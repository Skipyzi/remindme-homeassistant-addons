// Package updates installs server builds in a controlled way: staged download,
// checksum verification, backup, atomic swap, health check and rollback.
//
// Where the builds come from is a Source, one per server flavour; everything
// after "which file, from where, with which checksum" is the same for all of
// them.
package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/javaruntime"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// previousName is the kept copy of the JAR that was replaced. It is per flavour
// because a rollback must never restore another flavour's server.
func previousName(flavour string) string { return flavour + ".jar.previous" }

type Deps struct {
	Paths      appcfg.Paths
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Log        *slog.Logger

	// Sources are the install sources, keyed by flavour name.
	Sources map[string]Source

	Backup      func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error
	ActiveWorld func() string
	// CheckJava reports whether the container has a JVM that can run a JAR. It is
	// consulted before the staged JAR replaces the installed one.
	CheckJava    func(jarPath string) error
	StartTimeout time.Duration
}

type Manager struct {
	deps Deps
	log  *slog.Logger
}

func NewManager(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StartTimeout <= 0 {
		d.StartTimeout = 5 * time.Minute
	}
	if d.Sources == nil {
		d.Sources = map[string]Source{}
	}
	return &Manager{deps: d, log: d.Log.With("component", "updates")}
}

// source is the install source of the active flavour.
func (m *Manager) source() (Source, error) {
	flavour := m.deps.Paths.Flavour()
	if src, ok := m.deps.Sources[flavour]; ok {
		return src, nil
	}
	return nil, fmt.Errorf("no install source is configured for the %s server", flavour)
}

// Installed describes the JAR currently on disk.
type Installed struct {
	Present     bool   `json:"present"`
	Flavour     string `json:"flavour"`
	Project     string `json:"project"`
	Version     string `json:"version"`
	Build       int    `json:"build"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	ModifiedAt  string `json:"modified_at"`
	HasPrevious bool   `json:"has_previous"`
	// RequiredJava is what the installed JAR declares it needs, and JavaRuntimes
	// is what the container has, so the UI can explain a refusal.
	RequiredJava  int    `json:"required_java,omitempty"`
	JavaRuntimes  string `json:"java_runtimes,omitempty"`
	JavaSupported bool   `json:"java_supported"`
	JavaProblem   string `json:"java_problem,omitempty"`
}

func (m *Manager) Installed() Installed {
	settings := m.deps.Settings.Get()
	flavour := m.deps.Paths.Flavour()
	out := Installed{Flavour: flavour, Version: settings.PaperVersion, Build: settings.PaperBuild}
	if src, err := m.source(); err == nil {
		out.Project = src.ProjectName()
	}
	st, err := os.Stat(m.deps.Paths.ServerJar())
	if err != nil {
		return out
	}
	out.Present = true
	out.SizeBytes = st.Size()
	out.ModifiedAt = st.ModTime().UTC().Format(time.RFC3339)
	if raw, err := os.ReadFile(m.deps.Paths.ServerJar()); err == nil {
		sum := sha256.Sum256(raw)
		out.SHA256 = hex.EncodeToString(sum[:])
	}
	if _, err := os.Stat(filepath.Join(m.deps.Paths.Jars(), previousName(flavour))); err == nil {
		out.HasPrevious = true
	}
	if info, err := paper.InspectJar(m.deps.Paths.ServerJar()); err == nil {
		out.RequiredJava = info.RequiredJava
		if info.MinecraftVersion != "" && out.Version == "" {
			out.Version = info.MinecraftVersion
		}
	}
	runtimes := javaruntime.Discover()
	out.JavaRuntimes = javaruntime.Describe(runtimes)
	if _, err := javaruntime.Select(runtimes, out.RequiredJava); err != nil {
		out.JavaProblem = err.Error()
	} else {
		out.JavaSupported = true
	}
	return out
}

// Versions lists the versions installable for the active flavour, newest first.
func (m *Manager) Versions(ctx context.Context) ([]string, error) {
	src, err := m.source()
	if err != nil {
		return nil, err
	}
	return src.Versions(ctx, m.deps.Settings.Get().IncludePreReleases)
}

// Builds lists the builds of one version, newest first.
func (m *Manager) Builds(ctx context.Context, version string) ([]Build, error) {
	src, err := m.source()
	if err != nil {
		return nil, err
	}
	return src.Builds(ctx, version)
}

// LatestStable returns the newest build on the stable channel for a version.
func (m *Manager) LatestStable(ctx context.Context, version string) (Build, error) {
	builds, err := m.Builds(ctx, version)
	if err != nil {
		return Build{}, err
	}
	if build, ok := pickStable(builds); ok {
		return build, nil
	}
	return Build{}, fmt.Errorf("no builds published for %s", version)
}

// Available reports what could be installed.
type Available struct {
	Installed       Installed `json:"installed"`
	Flavour         string    `json:"flavour"`
	Project         string    `json:"project"`
	TargetVersion   string    `json:"target_version"`
	LatestBuild     int       `json:"latest_build"`
	LatestChannel   string    `json:"latest_channel"`
	LatestSHA256    string    `json:"latest_sha256"`
	UpdateAvailable bool      `json:"update_available"`
	Versions        []string  `json:"versions,omitempty"`
	// IncludePreReleases mirrors the setting so the UI can render the toggle
	// without a second request.
	IncludePreReleases bool   `json:"include_pre_releases"`
	Error              string `json:"error,omitempty"`
}

func (m *Manager) Check(ctx context.Context, version string) Available {
	settings := m.deps.Settings.Get()
	out := Available{
		Installed:          m.Installed(),
		Flavour:            m.deps.Paths.Flavour(),
		IncludePreReleases: settings.IncludePreReleases,
	}
	src, err := m.source()
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Project = src.ProjectName()
	if version == "" {
		version = settings.PaperVersion
	}
	versions, err := m.Versions(ctx)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Versions = versions
	if version == "" && len(versions) > 0 {
		version = versions[0]
	}
	out.TargetVersion = version
	build, err := m.LatestStable(ctx, version)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.LatestBuild = build.Build
	out.LatestChannel = build.Channel
	out.LatestSHA256 = build.SHA256
	out.UpdateAvailable = !out.Installed.Present ||
		out.Installed.Version != version || out.Installed.Build < build.Build
	return out
}

// Result reports what an install did.
type Result struct {
	Flavour    string `json:"flavour"`
	Version    string `json:"version"`
	Build      int    `json:"build"`
	Previous   string `json:"previous"`
	Started    bool   `json:"started"`
	RolledBack bool   `json:"rolled_back"`
	SHA256     string `json:"sha256"`
}

// Install downloads and activates a build.
//
// Nothing is installed without an explicit request; scheduled updates only exist
// when the operator turns them on. The previous JAR is kept so a failed start can
// be undone immediately.
func (m *Manager) Install(ctx context.Context, version string, build int, actor string) (Result, error) {
	flavour := m.deps.Paths.Flavour()
	result := Result{Flavour: flavour, Version: version, Build: build}
	src, err := m.source()
	if err != nil {
		return result, err
	}
	if err := src.ValidVersion(version); err != nil {
		return result, err
	}

	builds, err := src.Builds(ctx, version)
	if err != nil {
		return result, err
	}
	target, err := selectTarget(builds, build, version)
	if err != nil {
		return result, err
	}
	result.Build = target.Build
	result.SHA256 = target.SHA256
	if target.SHA256 == "" && !src.AllowsUnverified() {
		return result, fmt.Errorf("%s did not publish a checksum for this build; refusing to install it", src.ProjectName())
	}

	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityUpdating)
	if err != nil {
		return result, err
	}
	defer m.deps.Supervisor.Release(lease)

	journalID, _ := m.deps.Store.JournalBegin(store.OpUpdate, "download", map[string]any{
		"flavour": flavour, "version": version, "build": target.Build, "actor": actor,
	})
	failed := func(err error) (Result, error) {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		m.deps.Bus.Fail("updates", "update failed: "+err.Error())
		return result, err
	}

	// 1. Download to staging and verify. The URL comes from the release metadata,
	// so it is not constructed here, and it is checked against the source's
	// allow-list - including every redirect hop - before use.
	if target.URL == "" {
		return failed(fmt.Errorf("%s did not publish a download URL for this build", src.ProjectName()))
	}
	m.deps.Supervisor.Note("downloading %s %s", src.ProjectName(), version)
	data, err := httpDownload(ctx, target.URL, src.DownloadHosts())
	if err != nil {
		return failed(err)
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	switch {
	case target.SHA256 != "":
		if actual != target.SHA256 {
			return failed(fmt.Errorf("checksum mismatch: expected %s, got %s", target.SHA256, actual))
		}
	default:
		// The source publishes no checksum (BTA's own CDN). The download came over
		// HTTPS from the project's first-party host on the allow-list; the SHA-256
		// of what arrived is computed here and recorded in the audit log so any
		// later dispute about what was installed has a fact to check against.
		result.SHA256 = actual
		m.deps.Supervisor.Note("%s publishes no checksum; recorded sha256 %s of the download", src.ProjectName(), actual[:16])
	}
	staged := filepath.Join(m.deps.Paths.Jars(), src.StagedName(version, target.Build))
	if err := atomicfs.WriteFile(staged, data, 0o644); err != nil {
		return failed(err)
	}

	// 1b. Refuse a JAR this container cannot run, before anything is swapped.
	// Minecraft 26.x needs Java 25; the alternative would be a download, a stop, a
	// failed start and a rollback to tell the operator the same thing.
	if m.deps.CheckJava != nil {
		if err := m.deps.CheckJava(staged); err != nil {
			_ = os.Remove(staged)
			return failed(err)
		}
	}

	// 2. Back up the world and the configuration before changing the server.
	if m.deps.Backup != nil {
		worldID := m.deps.ActiveWorld()
		if worldID != "" {
			m.deps.Supervisor.Note("backing up %s before the update", worldID)
			if err := m.deps.Backup(ctx, worldID, "pre_update",
				fmt.Sprintf("before %s build %d", version, target.Build), lease); err != nil {
				return failed(fmt.Errorf("pre-update backup failed: %w", err))
			}
		}
	}

	// 3. Stop the server.
	wasRunning := m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting
	if wasRunning {
		if err := m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "server update"}); err != nil {
			return failed(fmt.Errorf("could not stop Minecraft: %w", err))
		}
	}

	// 4. Swap the server, keeping what was there for the rollback. A plain
	// source swaps one JAR; a bundle source unpacks the launcher, its libraries
	// and its base mods into the runtime directory, replacing only the trees the
	// bundle owns - the world, its link, server.properties and any extra mods the
	// user added are never touched. The previous artifact (JAR or bundle zip) is
	// kept under the same name either way, so the rollback below does not care
	// which kind it restores.
	_ = m.deps.Store.JournalPhase(journalID, "swap", map[string]any{"staged": staged, "bundle": src.Bundle()})
	previous := filepath.Join(m.deps.Paths.Jars(), previousName(flavour))
	if src.Bundle() {
		// The zip of the CURRENT installation was kept by the previous install;
		// it becomes the rollback artifact for this one.
		installedZip := filepath.Join(m.deps.Paths.Jars(), flavour+".installed.zip")
		if prior, err := os.ReadFile(installedZip); err == nil {
			if err := atomicfs.WriteFile(previous, prior, 0o644); err == nil {
				result.Previous = previous
			}
		}
		if err := installBundle(data, m.deps.Paths.Runtime(), filepath.Base(m.deps.Paths.ServerJar())); err != nil {
			return failed(err)
		}
		if err := atomicfs.WriteFile(installedZip, data, 0o644); err != nil {
			m.log.Warn("could not keep the installed bundle for the next rollback", "error", err)
		}
		m.log.Info("installed server bundle", "flavour", flavour, "contents", bundleSummary(data))
	} else {
		if current, err := os.ReadFile(m.deps.Paths.ServerJar()); err == nil {
			if err := atomicfs.WriteFile(previous, current, 0o644); err != nil {
				m.log.Warn("could not keep the previous JAR", "error", err)
			} else {
				result.Previous = previous
			}
		}
		if err := atomicfs.WriteFile(m.deps.Paths.ServerJar(), data, 0o644); err != nil {
			return failed(err)
		}
	}
	prevSettings := m.deps.Settings.Get()
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) {
		s.PaperVersion = version
		s.PaperBuild = target.Build
	}); err != nil {
		return failed(err)
	}

	// 5. Start and verify, rolling back on failure.
	if wasRunning {
		_ = m.deps.Store.JournalPhase(journalID, "verify", nil)
		startErr := m.deps.Supervisor.Start()
		if startErr == nil {
			readyCtx, cancel := context.WithTimeout(ctx, m.deps.StartTimeout)
			startErr = m.deps.Supervisor.WaitReady(readyCtx)
			cancel()
		}
		if startErr != nil {
			m.deps.Bus.Fail("updates", "the new build did not start; rolling back")
			m.rollback(ctx, prevSettings, previous, wasRunning, src.Bundle())
			result.RolledBack = true
			return failed(fmt.Errorf("the new build failed to start (%w); the previous JAR was restored", startErr))
		}
		result.Started = true
	}

	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "server.update", Target: version,
		Detail: fmt.Sprintf("flavour=%s build=%d sha256=%s started=%t", flavour, target.Build, actual[:16], result.Started)})
	m.deps.Bus.Publish(events.TypeSettingsChanged, map[string]any{
		"flavour": flavour, "paper_version": version, "paper_build": target.Build,
	})
	return result, nil
}

func (m *Manager) rollback(ctx context.Context, prev appcfg.Settings, previousJar string, wasRunning, bundle bool) {
	if m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting {
		_ = m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "update rollback"})
	}
	if previousJar != "" {
		if raw, err := os.ReadFile(previousJar); err == nil {
			var restoreErr error
			if bundle {
				// The kept artifact is the previous bundle zip; restoring means
				// unpacking it the same way it was installed.
				restoreErr = installBundle(raw, m.deps.Paths.Runtime(), filepath.Base(m.deps.Paths.ServerJar()))
			} else {
				restoreErr = atomicfs.WriteFile(m.deps.Paths.ServerJar(), raw, 0o644)
			}
			if restoreErr != nil {
				m.deps.Bus.Fail("updates", "could not restore the previous server: "+restoreErr.Error())
			}
		}
	}
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) {
		s.PaperVersion = prev.PaperVersion
		s.PaperBuild = prev.PaperBuild
	}); err != nil {
		m.log.Warn("could not restore version settings", "error", err)
	}
	if wasRunning {
		if err := m.deps.Supervisor.Start(); err != nil {
			m.deps.Bus.Fail("updates", "rollback could not restart Minecraft: "+err.Error())
		}
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.update_rollback",
		Target: prev.PaperVersion, Detail: "the new build failed to start", Result: "error"})
}

// EnsureInstalled downloads the newest stable build when no JAR exists yet. It is
// called only when the user asks for it from the UI.
func (m *Manager) EnsureInstalled(ctx context.Context, actor string) (Result, error) {
	if m.Installed().Present {
		return Result{}, errors.New("a server JAR is already installed")
	}
	src, err := m.source()
	if err != nil {
		return Result{}, err
	}
	version := m.deps.Settings.Get().PaperVersion
	if version == "" {
		versions, err := m.Versions(ctx)
		if err != nil {
			return Result{}, err
		}
		if len(versions) == 0 {
			return Result{}, fmt.Errorf("%s returned no versions", src.ProjectName())
		}
		version = versions[0]
	}
	return m.Install(ctx, version, 0, actor)
}
