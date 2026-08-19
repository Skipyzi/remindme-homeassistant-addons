// Command controller is the add-on's management service.
//
// It is the container's long-running process: it serves the web UI and the API,
// supervises Minecraft as a child process and runs the background workers. It
// keeps running while Minecraft is stopped, which is the whole point.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/api"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/flavours"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/hass"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/javaruntime"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/privdrop"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/scheduler"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/updates"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

// buildVersion is set with -ldflags at build time.
var buildVersion = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("controller stopped with an error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	env := appcfg.LoadEnvironment()
	options, optErr := appcfg.LoadOptions(appcfg.OptionsFile())
	log := newLogger(pickLevel(env.LogLevel, options.LogLevel))
	slog.SetDefault(log)

	log.Info("starting Minecraft add-on controller",
		"version", buildVersion, "data", env.Paths.Data, "listen", env.Listen)
	if optErr != nil {
		// Bad options must not stop the UI: the operator needs the UI to fix them.
		log.Error("add-on options are invalid, using defaults where possible", "error", optErr)
	}

	// A pre-flavour installation keeps its worlds one directory higher; move them
	// before anything else looks at them.
	if moved, err := env.Paths.MigrateLayout(); err != nil {
		return err
	} else if moved {
		log.Info("moved existing worlds into the per-flavour layout", "flavour", appcfg.DefaultFlavour)
	}
	if err := env.Paths.EnsureLayout(); err != nil {
		return err
	}

	st, err := store.Open(env.Paths.Database(), env.Paths.AuditLog(), log)
	if err != nil {
		return err
	}
	defer st.Close()

	settings, err := appcfg.LoadSettings(env.Paths.SettingsFile(), options)
	if err != nil {
		return err
	}
	bus := events.NewBus()

	// The flavour is settled before anything else is built: it decides which
	// directories under /data are in play. Every manager is handed the switchable
	// backend, so a later switch is a pointer swap rather than a rebuild.
	flavourName := settings.Get().Flavour
	initial, err := flavours.New(flavourName)
	if err != nil {
		log.Error("configured server flavour is unknown, falling back to PaperMC",
			"flavour", flavourName, "error", err)
		initial, _ = flavours.New(appcfg.DefaultFlavour)
	}
	backend := flavours.NewSwitchable(initial)
	env.Paths.SetFlavour(initial.Name(), initial.JarName())
	if err := env.Paths.EnsureLayout(); err != nil {
		return err
	}
	log.Info("server flavour", "flavour", initial.Name(), "name", initial.DisplayName())

	// Minecraft runs as an unprivileged user unless the operator turns that off.
	// The controller itself stays root: it owns /data and signals the JVM.
	account := privdrop.Resolve(options.RunServerAsRoot)
	log.Info("minecraft process identity", "identity", account.Describe())

	// The bridge listens on a Unix socket inside /data; the plugin dials in.
	bridgeSrv := bridge.New(env.Paths.BridgeSocket(), env.Paths.BridgeToken(), bus, log)
	if err := bridgeSrv.Start(); err != nil {
		log.Warn("management bridge unavailable; TPS and heap telemetry will be missing", "error", err)
	}
	defer bridgeSrv.Close()

	// The supervisor needs the world manager for launch arguments, and the world
	// manager needs the supervisor to stop and start the server. The cycle is
	// broken with a placeholder that is filled in immediately below.
	var worldManager *worlds.Manager

	// The container bundles more than one JRE: Minecraft 26.x needs Java 25, the
	// 1.21 line needs 21, and the JAR itself says which.
	javaRuntimes := javaruntime.Discover()
	log.Info("java runtimes available", "runtimes", javaruntime.Describe(javaRuntimes))
	resolveJava := func(jarPath string) (string, error) {
		info, err := paper.InspectJar(jarPath)
		if err != nil {
			log.Warn("could not read the server JAR metadata, assuming the default Java version",
				"error", err, "assumed", paper.DefaultRequiredJava)
		}
		runtime, err := javaruntime.Select(javaRuntimes, info.RequiredJava)
		if err != nil {
			return "", err
		}
		log.Debug("selected java runtime", "major", runtime.Major, "required", info.RequiredJava)
		return runtime.Path, nil
	}

	sup := supervisor.New(supervisor.Deps{
		Paths:       env.Paths,
		Settings:    settings,
		Store:       st,
		Bus:         bus,
		Backend:     backend,
		Log:         log,
		ServerPort:  options.ServerPort,
		Flags:       backend.FlagProfile,
		Account:     account,
		ResolveJava: resolveJava,
		ExtraArgs: func() []string {
			if worldManager == nil {
				return nil
			}
			return worldManager.ContainerArgs()
		},
		PreStart: func() error {
			if worldManager == nil {
				return nil
			}
			if err := worldManager.PrepareRuntime(); err != nil {
				return err
			}
			// The server writes into its runtime directory and its world set, and
			// talks to the bridge through the run directory, so those have to
			// belong to it once it is no longer root.
			if err := account.EnsureOwned(env.Paths.Runtime(), env.Paths.Worlds(), env.Paths.Run()); err != nil {
				return err
			}
			return account.EnsureOwnedFile(env.Paths.BridgeSocket())
		},
		ConsoleHistory: 3000,
	})

	collector := stats.New(stats.Deps{
		Store:    st,
		Log:      log,
		DiskPath: env.Paths.Data,
		PID:      func() int { return sup.Snapshot().PID },
		SizeTargets: func() map[string]string {
			targets := map[string]string{
				"data":    env.Paths.Data,
				"backups": env.Paths.Backups(),
				"runtime": env.Paths.Runtime(),
				"trash":   env.Paths.Trash(),
			}
			if entries, err := os.ReadDir(env.Paths.Worlds()); err == nil {
				for _, e := range entries {
					if e.IsDir() {
						targets["world:"+e.Name()] = filepath.Join(env.Paths.Worlds(), e.Name())
					}
				}
			}
			return targets
		},
	})

	configManager := mcconfig.NewManager(env.Paths, backend, st, bus, log)
	presetManager := presets.NewManager(env.Paths, env.AssetsDir, configManager, settings, st, bus, log)

	resticClient := &Restic{
		Bin:          "restic",
		Repo:         env.Paths.ResticRepo(),
		PasswordFile: env.Paths.ResticPassword(),
		CacheDir:     filepath.Join(env.Paths.Backups(), "cache"),
		Log:          log,
	}

	backupManager := backups.NewManager(backups.Deps{
		Paths:      env.Paths,
		Settings:   settings,
		Store:      st,
		Bus:        bus,
		Supervisor: sup,
		Backend:    backend,
		Restic:     resticClient,
		Log:        log,
		WorldDir: func(id string) (string, error) {
			return appcfg.Confine(env.Paths.Worlds(), id)
		},
		ActiveWorld: func() string { return settings.Get().ActiveWorld },
		Invalidate:  collector.Invalidate,
	})

	backupHook := func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error {
		_, err := backupManager.Create(ctx, backups.CreateRequest{
			WorldID: worldID, Kind: kind, Label: label,
		}, "controller", lease)
		return err
	}

	worldManager = worlds.NewManager(worlds.Deps{
		Paths:      env.Paths,
		Settings:   settings,
		Store:      st,
		Bus:        bus,
		Supervisor: sup,
		Config:     configManager,
		Log:        log,
		Backup:     backupHook,
		Invalidate: collector.Invalidate,
		Backend:    backend,
	})

	generationManager := generation.NewManager(generation.Deps{
		Paths:         env.Paths,
		Settings:      settings,
		Store:         st,
		Bus:           bus,
		Supervisor:    sup,
		Backend:       backend,
		Options:       options,
		Log:           log,
		Stats:         collector.System,
		Telemetry:     bridgeSrv.Latest,
		WorldDir:      func(id string) (string, error) { return appcfg.Confine(env.Paths.Worlds(), id) },
		ServerVersion: func() string { return sup.Snapshot().Version },
		Backup:        backupHook,
		UpdateWorldMeta: func(worldID string, generatedRadius, borderRadius int, status, jobID string) error {
			_, err := worldManager.UpdateMeta(worldID, func(meta *worlds.Meta) {
				meta.GenerationStatus = status
				meta.GeneratedRadius = generatedRadius
				meta.BorderRadius = borderRadius
				meta.LastGenerationJob = jobID
			})
			return err
		},
	})

	updateManager := updates.NewManager(updates.Deps{
		Sources: map[string]updates.Source{
			"paper":  updates.NewPaperSource(),
			"bta":    updates.NewBTASource(),
			"babric": updates.NewBabricSource(),
		},
		Paths:       env.Paths,
		Settings:    settings,
		Store:       st,
		Bus:         bus,
		Supervisor:  sup,
		Log:         log,
		Backup:      backupHook,
		ActiveWorld: func() string { return settings.Get().ActiveWorld },
		CheckJava: func(jarPath string) error {
			_, err := resolveJava(jarPath)
			return err
		},
	})

	commandService := commands.New(commands.Deps{
		Paths:      env.Paths,
		Backend:    backend,
		ServerPort: options.ServerPort,
		Settings:   settings,
		Store:      st,
		Supervisor: sup,
		Config:     configManager,
		Presets:    presetManager,
		Worlds:     worldManager,
		Backups:    backupManager,
		Generation: generationManager,
		Updates:    updateManager,
		Log:        log,
	})

	sched := scheduler.New(scheduler.Deps{
		Settings:   settings,
		Store:      st,
		Bus:        bus,
		Supervisor: sup,
		Commands:   commandService,
		Backups:    backupManager,
		Updates:    updateManager,
		Telemetry:  bridgeSrv.Latest,
		Log:        log,
	})

	mqttClient := hass.New(hass.Deps{
		Options:    options,
		Env:        env,
		Settings:   settings,
		Store:      st,
		Supervisor: sup,
		Commands:   commandService,
		Worlds:     worldManager,
		Presets:    presetManager,
		Backups:    backupManager,
		Generation: generationManager,
		Stats:      collector,
		Telemetry:  bridgeSrv.Latest,
		Log:        log,
	})

	apiServer := api.New(api.Deps{
		Version:     buildVersion,
		Backend:     backend,
		Paths:       env.Paths,
		Options:     options,
		Settings:    settings,
		Store:       st,
		Bus:         bus,
		Supervisor:  sup,
		Config:      configManager,
		Presets:     presetManager,
		Worlds:      worldManager,
		Backups:     backupManager,
		Generation:  generationManager,
		Updates:     updateManager,
		Commands:    commandService,
		Stats:       collector,
		Bridge:      bridgeSrv,
		FrontendDir: env.FrontendDir,
		Log:         log,
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The HTTP server starts before any recovery work so the UI is reachable while
	// the controller sorts out an interrupted operation.
	httpServer := &http.Server{
		Addr:              env.Listen,
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// No write timeout: /api/events is a long-lived stream.
		IdleTimeout: 120 * time.Second,
	}
	serverErr := make(chan error, 1)
	go func() {
		log.Info("management interface listening", "address", env.Listen)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	go collector.Run(ctx)
	go sched.Run(ctx)
	go generationManager.Run(ctx)
	go mqttClient.Run(ctx)

	// Chunky's console output drives the generation manager.
	go func() {
		_ = sup.Watch(ctx, func(ev adapter.LogEvent) bool {
			generationManager.HandleLog(ev)
			return false
		})
	}()

	startupReconcile(ctx, log, env, options, backend, st, sup, settings, configManager, worldManager,
		backupManager, generationManager, backupManager.Init, resticClient)

	select {
	case err := <-serverErr:
		return err
	case <-ctx.Done():
		log.Info("shutdown requested")
	}

	// Stop Minecraft first: it is the only thing that can lose data.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := sup.Shutdown(shutdownCtx); err != nil {
		log.Error("could not stop Minecraft cleanly", "error", err)
	}
	httpCtx, cancelHTTP := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelHTTP()
	if err := httpServer.Shutdown(httpCtx); err != nil {
		log.Warn("HTTP shutdown was not clean", "error", err)
	}
	log.Info("controller stopped")
	return nil
}

// startupReconcile brings the persistent state back in line with reality before
// anything new is allowed to happen.
func startupReconcile(
	ctx context.Context,
	log *slog.Logger,
	env appcfg.Environment,
	options appcfg.Options,
	backend adapter.Backend,
	st *store.Store,
	sup *supervisor.Supervisor,
	settings *appcfg.Store,
	configManager *mcconfig.Manager,
	worldManager *worlds.Manager,
	backupManager *backups.Manager,
	generationManager *generation.Manager,
	initBackups func(context.Context) error,
	restic *Restic,
) {
	if entries, err := st.OpenJournals(); err == nil && len(entries) > 0 {
		log.Warn("found unfinished operations from a previous run", "count", len(entries))
		for _, entry := range entries {
			log.Warn("unfinished operation", "op", entry.Op, "phase", entry.Phase, "started", entry.StartedAt)
		}
	}

	// Saving off plus an interrupted backup is the one combination that can lose
	// data silently, so it is handled first.
	backupManager.ReconcileInterrupted(ctx)

	caps := backend.Capabilities()
	// A backend without a launch argument for the listen port gets it written into
	// its properties file instead, on every start, so the add-on option stays the
	// single place the port is configured.
	enforced := map[string]string{}
	if !caps.ServerPortArg {
		enforced["server-port"] = strconv.Itoa(options.ServerPort)
	}
	if err := configManager.EnsureDefaults("controller", enforced); err != nil {
		log.Warn("could not write default server properties", "error", err)
	}
	if caps.BridgeTelemetry {
		ensureBridgePlugin(log, env)
	}
	if err := configManager.EnsureListFiles(); err != nil {
		log.Warn("could not create configuration files", "error", err)
	}
	if _, err := worldManager.EnsureActive(); err != nil {
		log.Error("no usable world available", "error", err)
	}

	initCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := initBackups(initCtx); err != nil {
		log.Warn("backups are unavailable", "error", err, "repository", restic.Repo)
	}

	generationManager.Reconcile(ctx)

	cfg := settings.Get()
	switch {
	case !cfg.EULAAccepted:
		log.Info("waiting for the Minecraft EULA to be accepted in the web UI")
	case cfg.StartOnBoot || sup.DesiredRunning():
		reason := "start_on_boot"
		if !cfg.StartOnBoot {
			reason = "server was running before the add-on restarted"
		}
		log.Info("starting Minecraft", "reason", reason)
		if err := sup.Start(); err != nil {
			log.Error("could not start Minecraft", "error", err)
		}
	default:
		log.Info("Minecraft is stopped; the management interface is available")
	}
}

func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}

func pickLevel(envLevel, optionLevel string) slog.Level {
	level := optionLevel
	if level == "" {
		level = envLevel
	}
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warning", "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Restic is an alias so main does not import the backups package twice under
// different names.
type Restic = backups.Restic
