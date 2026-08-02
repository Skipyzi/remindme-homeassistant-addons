// Package supervisor owns the Minecraft process: it starts it, captures its
// console, classifies its exit and refuses to ever run two of them.
//
// The controller is the parent process and stays alive independently, so
// stopping Minecraft never takes the management UI with it.
package supervisor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/privdrop"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// State is the lifecycle state of the Minecraft process.
type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopping State = "stopping"
	StateCrashed  State = "crashed"
)

// Activity is a long-running controller operation layered on top of the process
// state. The API reports the activity as the effective state, which is what the
// specification calls backing_up, restoring, switching_world, generating,
// restarting and maintenance.
type Activity string

const (
	ActivityNone           Activity = ""
	ActivityBackup         Activity = "backing_up"
	ActivityRestore        Activity = "restoring"
	ActivityWorldSwitch    Activity = "switching_world"
	ActivityGenerating     Activity = "generating"
	ActivityRestarting     Activity = "restarting"
	ActivityUpdating       Activity = "updating"
	ActivityMaintenanceOps Activity = "maintenance"
)

var (
	ErrAlreadyRunning  = errors.New("minecraft is already running")
	ErrNotRunning      = errors.New("minecraft is not running")
	ErrEULANotAccepted = errors.New("the Minecraft EULA has not been accepted yet")
	ErrJarMissing      = errors.New("no server JAR is installed")
	ErrBusy            = errors.New("another operation is in progress")
	ErrNotReady        = errors.New("minecraft did not finish starting in time")
)

// kv keys for persisted runtime state.
const (
	kvDesiredRunning = "supervisor.desired_running"
	kvLastExitCode   = "supervisor.last_exit_code"
	kvCrashCount     = "supervisor.crash_count"
	kvSaveDisabled   = "supervisor.save_disabled"
	kvLastStart      = "supervisor.last_start"
	kvServerVersion  = "supervisor.server_version"
	kvServerBuild    = "supervisor.server_build"
)

// Deps are the collaborators the supervisor needs.
type Deps struct {
	Paths    appcfg.Paths
	Settings *appcfg.Store
	Store    *store.Store
	Bus      *events.Bus
	Backend  adapter.Backend
	Log      *slog.Logger

	// JavaBin is the fallback JVM used when ResolveJava is not set.
	JavaBin string
	// ResolveJava picks the JVM for the installed server JAR. Minecraft 26.x needs
	// Java 25 while the 1.21 line needs 21, so the choice depends on the JAR, not
	// on the container.
	ResolveJava func(jarPath string) (string, error)
	// ServerPort comes from the add-on options, not from settings, because the
	// container port mapping is fixed at add-on start.
	ServerPort int
	// ExtraArgs are appended to the Paper arguments, used for --world-container.
	ExtraArgs func() []string
	// PreStart runs immediately before launch (world container preparation).
	PreStart func() error
	// ExtraEnv adds environment variables for the child process. Minecraft is
	// otherwise given a deliberately small environment; tests use this to steer
	// the fake server.
	ExtraEnv func() []string
	// Flags resolves a JVM flag profile name into flags. Injected so the
	// supervisor stays independent of any particular server flavour.
	Flags func(profile string, heapMB int) ([]string, error)
	// Account is the identity Minecraft runs as. The zero value keeps the
	// controller's own identity, which inside an add-on container is root.
	Account privdrop.Account
	// ConsoleHistory is the number of console lines kept in memory.
	ConsoleHistory int
	// ReadyTimeout bounds how long a start may take before it counts as failed.
	ReadyTimeout time.Duration
}

type watcher struct {
	fn   func(adapter.LogEvent) bool
	done chan struct{}
	once sync.Once
}

func (w *watcher) close() { w.once.Do(func() { close(w.done) }) }

// Supervisor is safe for concurrent use.
type Supervisor struct {
	deps Deps
	log  *slog.Logger
	ring *ring

	mu        sync.Mutex
	state     State
	activity  Activity
	leaseID   int64
	leaseName Activity

	cmd       *exec.Cmd
	stdin     io.WriteCloser
	pid       int
	startedAt time.Time
	readyAt   time.Time

	intentionalStop bool
	stopRequested   bool
	exitCode        int
	crashCount      int
	lastCrashAt     time.Time
	saveDisabled    bool

	version string
	build   string
	players map[string]time.Time

	waiters  []*watcher
	waitDone chan struct{}

	// restartPolicyPaused prevents crash-restart storms during controller
	// initiated restarts and shutdowns.
	shuttingDown bool
}

func New(d Deps) *Supervisor {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.ConsoleHistory <= 0 {
		d.ConsoleHistory = 2000
	}
	if d.ReadyTimeout <= 0 {
		d.ReadyTimeout = 5 * time.Minute
	}
	if d.JavaBin == "" {
		d.JavaBin = "java"
	}
	s := &Supervisor{
		deps:    d,
		log:     d.Log.With("component", "supervisor"),
		ring:    newRing(d.ConsoleHistory),
		state:   StateStopped,
		players: map[string]time.Time{},
	}
	s.restoreRuntimeState()
	return s
}

func (s *Supervisor) restoreRuntimeState() {
	if v, ok, _ := s.deps.Store.GetKV(kvLastExitCode); ok {
		s.exitCode, _ = strconv.Atoi(v)
	}
	if v, ok, _ := s.deps.Store.GetKV(kvCrashCount); ok {
		s.crashCount, _ = strconv.Atoi(v)
	}
	if v, ok, _ := s.deps.Store.GetKV(kvSaveDisabled); ok {
		s.saveDisabled = v == "true"
	}
	if v, ok, _ := s.deps.Store.GetKV(kvServerVersion); ok {
		s.version = v
	}
	if v, ok, _ := s.deps.Store.GetKV(kvServerBuild); ok {
		s.build = v
	}
}

// --------------------------------------------------------------- accessors --

type Snapshot struct {
	State           State     `json:"state"`
	ProcessState    State     `json:"process_state"`
	Activity        Activity  `json:"activity"`
	PID             int       `json:"pid"`
	StartedAt       string    `json:"started_at"`
	ReadyAt         string    `json:"ready_at"`
	UptimeSeconds   int64     `json:"uptime_seconds"`
	Players         []string  `json:"players"`
	Version         string    `json:"version"`
	Build           string    `json:"build"`
	LastExitCode    int       `json:"last_exit_code"`
	CrashCount      int       `json:"crash_count"`
	SaveDisabled    bool      `json:"save_disabled"`
	MaintenanceMode bool      `json:"maintenance_mode"`
	ConsoleSeq      uint64    `json:"console_seq"`
	Backend         string    `json:"backend"`
	lastCrash       time.Time `json:"-"`
}

func (s *Supervisor) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	players := make([]string, 0, len(s.players))
	for name := range s.players {
		players = append(players, name)
	}
	snap := Snapshot{
		State:        s.effectiveStateLocked(),
		ProcessState: s.state,
		Activity:     s.activity,
		PID:          s.pid,
		Players:      players,
		Version:      s.version,
		Build:        s.build,
		LastExitCode: s.exitCode,
		CrashCount:   s.crashCount,
		SaveDisabled: s.saveDisabled,
		ConsoleSeq:   s.ring.lastSeq(),
		Backend:      s.deps.Backend.Name(),
		lastCrash:    s.lastCrashAt,
	}
	if !s.startedAt.IsZero() {
		snap.StartedAt = s.startedAt.UTC().Format(time.RFC3339)
		if s.state == StateRunning || s.state == StateStarting {
			snap.UptimeSeconds = int64(time.Since(s.startedAt).Seconds())
		}
	}
	if !s.readyAt.IsZero() {
		snap.ReadyAt = s.readyAt.UTC().Format(time.RFC3339)
	}
	snap.MaintenanceMode = s.deps.Settings.Get().MaintenanceMode
	return snap
}

func (s *Supervisor) effectiveStateLocked() State {
	if s.activity != ActivityNone {
		return State(s.activity)
	}
	if s.deps.Settings.Get().MaintenanceMode && s.state == StateRunning {
		return State(ActivityMaintenanceOps)
	}
	return s.state
}

func (s *Supervisor) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Supervisor) IsRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state == StateRunning
}

func (s *Supervisor) SaveDisabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveDisabled
}

func (s *Supervisor) PlayerNames() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.players))
	for name := range s.players {
		out = append(out, name)
	}
	return out
}

func (s *Supervisor) Console(afterSeq uint64, limit int) []ConsoleLine {
	return s.ring.since(afterSeq, limit)
}

// Note appends a controller message to the console history so the operator sees
// controller actions and Minecraft output in one place.
func (s *Supervisor) Note(format string, args ...any) {
	line := s.ring.append("controller", fmt.Sprintf(format, args...))
	s.deps.Bus.Publish(events.TypeServerLog, line)
}

// ------------------------------------------------------------------ leases --

// Lease is an exclusive claim on the server for a long operation. Nested
// operations reuse the parent lease instead of deadlocking.
type Lease struct {
	id   int64
	name Activity
}

func (s *Supervisor) Acquire(name Activity) (*Lease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activity != ActivityNone {
		return nil, fmt.Errorf("%w: %s", ErrBusy, s.activity)
	}
	s.leaseID++
	s.activity = name
	s.leaseName = name
	lease := &Lease{id: s.leaseID, name: name}
	s.publishStateLocked()
	return lease, nil
}

// AcquireOrReuse returns the parent lease when one is supplied, so a manager can
// be called both directly and as a step of a bigger operation.
func (s *Supervisor) AcquireOrReuse(parent *Lease, name Activity) (*Lease, bool, error) {
	if parent != nil {
		return parent, false, nil
	}
	l, err := s.Acquire(name)
	return l, true, err
}

func (s *Supervisor) Release(l *Lease) {
	if l == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.id != s.leaseID || s.activity == ActivityNone {
		return
	}
	s.activity = ActivityNone
	s.publishStateLocked()
}

// SetActivity changes the reported activity of an existing lease (a world switch
// that starts a backup, for example).
func (s *Supervisor) SetActivity(l *Lease, name Activity) {
	if l == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.id == s.leaseID {
		s.activity = name
		s.publishStateLocked()
	}
}

func (s *Supervisor) Busy() (bool, Activity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activity != ActivityNone, s.activity
}

// ------------------------------------------------------------------- start --

// Start launches Minecraft. It fails fast when a duplicate is running, the EULA
// has not been accepted or the JAR is missing.
func (s *Supervisor) Start() error {
	s.mu.Lock()
	if s.state == StateRunning || s.state == StateStarting || s.state == StateStopping {
		state := s.state
		s.mu.Unlock()
		if state == StateStopping {
			return fmt.Errorf("minecraft is still stopping")
		}
		return ErrAlreadyRunning
	}
	settings := s.deps.Settings.Get()
	if !settings.EULAAccepted {
		s.mu.Unlock()
		return ErrEULANotAccepted
	}
	s.mu.Unlock()

	// Kill an orphan from a previous controller life before doing anything else.
	if err := s.reapOrphan(); err != nil {
		return err
	}
	if s.deps.PreStart != nil {
		if err := s.deps.PreStart(); err != nil {
			return err
		}
	}
	if _, err := os.Stat(s.deps.Paths.ServerJar()); err != nil {
		return ErrJarMissing
	}
	if err := s.writeEULA(settings); err != nil {
		return err
	}

	flags, err := s.resolveFlags(settings)
	if err != nil {
		return err
	}
	javaBin := s.deps.JavaBin
	if s.deps.ResolveJava != nil {
		// A mismatch is reported here, before launch, instead of as an
		// UnsupportedClassVersionError buried in the console.
		resolved, err := s.deps.ResolveJava(s.deps.Paths.ServerJar())
		if err != nil {
			return err
		}
		javaBin = resolved
	}
	argv, err := s.deps.Backend.Argv(adapter.LaunchContext{
		JavaBin:    javaBin,
		JarPath:    s.deps.Paths.ServerJar(),
		WorkDir:    s.deps.Paths.Runtime(),
		HeapMinMB:  settings.MemoryMinMB,
		HeapMaxMB:  settings.MemoryMaxMB,
		Flags:      flags,
		ServerPort: s.deps.ServerPort,
		Nogui:      true,
	})
	if err != nil {
		return err
	}
	if s.deps.ExtraArgs != nil {
		argv = append(argv, s.deps.ExtraArgs()...)
	}

	cmd := exec.Command(argv[0], argv[1:]...) // #nosec G204 - argv is built from validated values, never a shell string
	cmd.Dir = s.deps.Paths.Runtime()
	cmd.Env = s.childEnv()
	cmd.SysProcAttr = sysProcAttr(s.deps.Account)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.state = StateStarting
	s.cmd = cmd
	s.stdin = stdin
	s.intentionalStop = false
	s.stopRequested = false
	s.startedAt = time.Now()
	s.readyAt = time.Time{}
	s.players = map[string]time.Time{}
	s.waitDone = make(chan struct{})
	waitDone := s.waitDone
	s.publishStateLocked()
	s.mu.Unlock()

	s.Note("starting %s: heap %d-%d MB, flags profile %s",
		s.deps.Backend.DisplayName(), settings.MemoryMinMB, settings.MemoryMaxMB, settings.JVMFlagsProfile)

	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		s.state = StateStopped
		s.cmd = nil
		s.stdin = nil
		close(s.waitDone)
		s.publishStateLocked()
		s.mu.Unlock()
		return fmt.Errorf("launch minecraft: %w", err)
	}

	s.mu.Lock()
	s.pid = cmd.Process.Pid
	pid := s.pid
	s.mu.Unlock()

	_ = os.WriteFile(s.deps.Paths.PidFile(), []byte(strconv.Itoa(pid)), 0o600)
	_ = s.deps.Store.SetKV(kvDesiredRunning, "true")
	_ = s.deps.Store.SetKV(kvLastStart, time.Now().UTC().Format(time.RFC3339))
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.start",
		Target: s.deps.Backend.Name(), Detail: fmt.Sprintf("pid=%d heap=%d-%dMB", pid, settings.MemoryMinMB, settings.MemoryMaxMB)})

	go s.pump("stdout", stdout)
	go s.pump("stderr", stderr)
	go s.awaitExit(cmd, waitDone)
	go s.watchdog(waitDone)

	return nil
}

func (s *Supervisor) resolveFlags(settings appcfg.Settings) ([]string, error) {
	if settings.JVMFlagsProfile == "custom" {
		return appcfg.ValidateJavaFlags(settings.JVMFlagsCustom)
	}
	if s.deps.Flags == nil {
		return nil, nil
	}
	return s.deps.Flags(settings.JVMFlagsProfile, settings.MemoryMaxMB)
}

func (s *Supervisor) childEnv() []string {
	keep := []string{"PATH", "JAVA_HOME", "TZ", "LANG", "HOME", "TERM"}
	env := make([]string, 0, len(keep)+1)
	for _, key := range keep {
		if v := os.Getenv(key); v != "" {
			env = append(env, key+"="+v)
		}
	}
	// The bridge plugin finds the controller through these two values only; no
	// network port and no credentials on the command line.
	env = append(env, "MCBRIDGE_SOCKET="+s.deps.Paths.BridgeSocket())
	env = append(env, "MCBRIDGE_TOKEN_FILE="+s.deps.Paths.BridgeToken())
	if s.deps.ExtraEnv != nil {
		env = append(env, s.deps.ExtraEnv()...)
	}
	return env
}

// writeEULA records acceptance for backends that have an EULA file. Not every
// flavour does: BTA is a standalone fork with no eula.txt, so there is nothing
// to write - but the operator still has to have accepted, which is checked
// before Start gets this far.
func (s *Supervisor) writeEULA(settings appcfg.Settings) error {
	if !settings.EULAAccepted {
		return ErrEULANotAccepted
	}
	if !s.deps.Backend.Capabilities().EULAFile {
		return nil
	}
	if err := os.WriteFile(s.deps.Paths.EulaFile(), []byte(s.deps.Backend.EULAAcceptedContent()), 0o644); err != nil {
		return err
	}
	return s.deps.Account.EnsureOwnedFile(s.deps.Paths.EulaFile())
}

// reapOrphan handles the case where the controller was restarted (add-on update,
// crash, Supervisor restart) while Minecraft kept running. The orphan has no
// usable console any more, so it is stopped rather than adopted.
func (s *Supervisor) reapOrphan() error {
	raw, err := os.ReadFile(s.deps.Paths.PidFile())
	if err != nil {
		return nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		_ = os.Remove(s.deps.Paths.PidFile())
		return nil
	}
	if !processAlive(pid) {
		_ = os.Remove(s.deps.Paths.PidFile())
		return nil
	}
	s.log.Warn("found an orphaned minecraft process, terminating it", "pid", pid)
	s.Note("orphaned Minecraft process %d found from a previous controller run, terminating", pid)
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.orphan_terminated",
		Target: strconv.Itoa(pid), Detail: "controller restarted while Minecraft was running"})
	_ = terminateProcess(pid)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			_ = os.Remove(s.deps.Paths.PidFile())
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = killProcess(pid)
	time.Sleep(2 * time.Second)
	if processAlive(pid) {
		return fmt.Errorf("an orphaned Minecraft process (pid %d) could not be stopped; restart the add-on", pid)
	}
	_ = os.Remove(s.deps.Paths.PidFile())
	return nil
}

// ------------------------------------------------------------------ output --

func (s *Supervisor) pump(stream string, r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := strings.TrimRight(scanner.Text(), "\r")
		if text == "" {
			continue
		}
		line := s.ring.append(stream, store.Redact(text))
		s.deps.Bus.Publish(events.TypeServerLog, line)
		s.handleLogEvent(s.deps.Backend.Parse(text))
	}
}

func (s *Supervisor) handleLogEvent(ev adapter.LogEvent) {
	switch ev.Kind {
	case adapter.KindReady:
		s.mu.Lock()
		if s.state == StateStarting {
			s.state = StateRunning
			s.readyAt = time.Now()
			s.publishStateLocked()
		}
		s.mu.Unlock()
		s.deps.Bus.Publish(events.TypeStatsUpdate, map[string]any{"ready": true})
	case adapter.KindStopping:
		s.mu.Lock()
		if s.state == StateRunning || s.state == StateStarting {
			s.state = StateStopping
			s.publishStateLocked()
		}
		s.mu.Unlock()
	case adapter.KindPlayerJoin:
		s.mu.Lock()
		s.players[ev.Player] = time.Now()
		s.mu.Unlock()
		s.deps.Bus.Publish(events.TypePlayerJoin, map[string]string{"player": ev.Player})
	case adapter.KindPlayerLeave:
		s.mu.Lock()
		delete(s.players, ev.Player)
		s.mu.Unlock()
		s.deps.Bus.Publish(events.TypePlayerLeave, map[string]string{"player": ev.Player})
	case adapter.KindVersion:
		s.mu.Lock()
		if ev.Version != "" {
			s.version = ev.Version
			_ = s.deps.Store.SetKV(kvServerVersion, ev.Version)
		}
		if ev.Build != "" {
			s.build = ev.Build
			_ = s.deps.Store.SetKV(kvServerBuild, ev.Build)
		}
		s.mu.Unlock()
	case adapter.KindSaveDisabled:
		s.setSaveDisabled(true)
	case adapter.KindSaveEnabled:
		s.setSaveDisabled(false)
	case adapter.KindEULARequired:
		s.deps.Bus.Fail("server", "Minecraft refused to start: the EULA has not been accepted")
	case adapter.KindPortUnavailable:
		s.deps.Bus.Fail("server", fmt.Sprintf("port %d is already in use", s.deps.ServerPort))
	case adapter.KindOutOfMemory:
		s.deps.Bus.Fail("server", "the JVM ran out of memory; lower view distance or raise the heap")
	case adapter.KindPluginIncompat:
		s.deps.Bus.Warn("server", "a plugin is incompatible with this server version: "+ev.Message)
	case adapter.KindWorldCorrupt:
		s.deps.Bus.Warn("server", "the server reported world data problems: "+ev.Message)
	}
	s.notifyWatchers(ev)
}

func (s *Supervisor) setSaveDisabled(v bool) {
	s.mu.Lock()
	s.saveDisabled = v
	s.mu.Unlock()
	_ = s.deps.Store.SetKV(kvSaveDisabled, strconv.FormatBool(v))
}

// Watch registers a callback for log events. It returns when fn reports true or
// the context ends; it is how the backup pipeline waits for "Saved the game".
func (s *Supervisor) Watch(ctx context.Context, fn func(adapter.LogEvent) bool) error {
	w := &watcher{fn: fn, done: make(chan struct{})}
	s.mu.Lock()
	s.waiters = append(s.waiters, w)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		for i, existing := range s.waiters {
			if existing == w {
				s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}()
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Supervisor) notifyWatchers(ev adapter.LogEvent) {
	s.mu.Lock()
	watchers := make([]*watcher, len(s.waiters))
	copy(watchers, s.waiters)
	s.mu.Unlock()
	for _, w := range watchers {
		if w.fn(ev) {
			w.close()
		}
	}
}

// ------------------------------------------------------------------- exit ----

func (s *Supervisor) awaitExit(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	// The marker is cleared before the state changes, not after: anything that
	// sees the process as stopped or crashed must not still be able to read
	// "should be running". It stays set only when the controller itself was killed
	// while Minecraft ran, which is exactly the case where the reconciler should
	// start the server again.
	_ = s.deps.Store.SetKV(kvDesiredRunning, "false")

	s.mu.Lock()
	intentional := s.intentionalStop
	shuttingDown := s.shuttingDown
	s.state = StateStopped
	if !intentional {
		s.state = StateCrashed
		s.crashCount++
		s.lastCrashAt = time.Now()
	}
	s.exitCode = exitCode
	s.pid = 0
	s.cmd = nil
	if s.stdin != nil {
		_ = s.stdin.Close()
		s.stdin = nil
	}
	s.players = map[string]time.Time{}
	crashed := s.state == StateCrashed
	crashCount := s.crashCount
	s.publishStateLocked()
	s.mu.Unlock()

	// The pid file and the persisted "should be running" marker are cleared before
	// waiters are released, so a caller that returns from Stop can rely on both.
	_ = os.Remove(s.deps.Paths.PidFile())
	_ = s.deps.Store.SetKV(kvLastExitCode, strconv.Itoa(exitCode))
	_ = s.deps.Store.SetKV(kvCrashCount, strconv.Itoa(crashCount))
	_ = shuttingDown

	// All bookkeeping for this exit finishes before waiters are released, so a
	// caller that returns from Stop knows the audit log and the state database are
	// already up to date.
	if crashed {
		s.Note("minecraft exited unexpectedly with code %d", exitCode)
		s.deps.Bus.Fail("server", fmt.Sprintf("Minecraft exited unexpectedly with code %d", exitCode))
		_ = s.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.crashed",
			Target: s.deps.Backend.Name(), Detail: fmt.Sprintf("exit_code=%d crash_count=%d", exitCode, crashCount), Result: "error"})
	} else {
		s.Note("minecraft stopped (exit code %d)", exitCode)
		_ = s.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.stopped",
			Target: s.deps.Backend.Name(), Detail: fmt.Sprintf("exit_code=%d", exitCode)})
	}
	close(done)

	if crashed {
		s.maybeRestartAfterCrash()
	}
}

// maybeRestartAfterCrash implements the crash-restart policy: opt-in, rate
// limited, and never during a controller-initiated shutdown.
func (s *Supervisor) maybeRestartAfterCrash() {
	settings := s.deps.Settings.Get()
	if !settings.AutoRestartOnCrash {
		return
	}
	s.mu.Lock()
	shuttingDown := s.shuttingDown
	busy := s.activity != ActivityNone
	crashes := s.crashCount
	s.mu.Unlock()
	if shuttingDown || busy {
		return
	}
	// Back off progressively; give up after three consecutive crashes so a
	// broken configuration does not turn into a restart loop.
	delay := time.Duration(0)
	switch {
	case crashes <= 1:
		delay = 10 * time.Second
	case crashes == 2:
		delay = 30 * time.Second
	case crashes == 3:
		delay = 60 * time.Second
	default:
		s.deps.Bus.Fail("server", "automatic restart disabled after three consecutive crashes; check the console")
		s.Note("not restarting automatically: %d consecutive crashes", crashes)
		return
	}
	s.Note("restarting automatically in %s (crash %d)", delay, crashes)
	go func() {
		time.Sleep(delay)
		if err := s.Start(); err != nil {
			s.deps.Bus.Fail("server", "automatic restart failed: "+err.Error())
		}
	}()
}

// watchdog fails a start that never reaches "Done".
func (s *Supervisor) watchdog(done chan struct{}) {
	timer := time.NewTimer(s.deps.ReadyTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
	}
	s.mu.Lock()
	// The watchdog belongs to one launch. Comparing the wait channel makes sure a
	// timer left over from a previous, already finished launch cannot stop the
	// process that is starting now.
	stuck := s.state == StateStarting && s.waitDone == done
	s.mu.Unlock()
	if !stuck {
		return
	}
	s.deps.Bus.Fail("server", fmt.Sprintf("Minecraft did not finish starting within %s", s.deps.ReadyTimeout))
	s.Note("startup timed out after %s; stopping", s.deps.ReadyTimeout)
	_ = s.Stop(context.Background(), StopOptions{Reason: "startup timeout"})
}

// ------------------------------------------------------------------- stop ----

type StopOptions struct {
	// Force skips the graceful sequence entirely (dangerous action).
	Force bool
	// Reason is recorded in the audit log.
	Reason string
	// Timeout overrides the configured graceful timeout.
	Timeout time.Duration
}

// Stop performs the graceful shutdown sequence: flush saves, ask Minecraft to
// stop, wait, then escalate to SIGTERM and finally SIGKILL.
func (s *Supervisor) Stop(ctx context.Context, opts StopOptions) error {
	s.mu.Lock()
	if s.state == StateStopped || s.state == StateCrashed {
		s.mu.Unlock()
		return nil
	}
	if s.cmd == nil || s.cmd.Process == nil {
		s.mu.Unlock()
		return ErrNotRunning
	}
	pid := s.pid
	done := s.waitDone
	s.intentionalStop = true
	s.stopRequested = true
	s.state = StateStopping
	settings := s.deps.Settings.Get()
	s.publishStateLocked()
	s.mu.Unlock()

	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = time.Duration(settings.StopTimeoutSeconds) * time.Second
	}

	_ = s.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.stop",
		Target: s.deps.Backend.Name(),
		Detail: fmt.Sprintf("force=%t reason=%s timeout=%s", opts.Force, opts.Reason, timeout)})

	if opts.Force {
		s.Note("force stopping Minecraft (data loss is possible)")
		_ = killProcess(pid)
		return s.waitExit(ctx, done, 30*time.Second, pid)
	}

	// Flush the world before asking the server to stop: if the stop itself hangs
	// and we have to escalate, the world on disk is still consistent.
	s.Note("flushing world data")
	flushCtx, cancelFlush := context.WithTimeout(ctx, 30*time.Second)
	saved := make(chan struct{}, 1)
	go func() {
		_ = s.Watch(flushCtx, func(ev adapter.LogEvent) bool {
			if ev.Kind == adapter.KindSaved {
				select {
				case saved <- struct{}{}:
				default:
				}
				return true
			}
			return false
		})
	}()
	if err := s.Send(s.deps.Backend.SaveAllCommand()); err != nil {
		s.log.Warn("save-all failed", "error", err)
	}
	select {
	case <-saved:
	case <-flushCtx.Done():
		s.log.Warn("did not observe a save confirmation, continuing with stop")
	}
	cancelFlush()

	if err := s.Send(s.deps.Backend.StopCommand()); err != nil {
		s.log.Warn("stop command failed, escalating", "error", err)
	}
	if err := s.waitExit(ctx, done, timeout, 0); err == nil {
		return nil
	}

	s.Note("Minecraft did not exit within %s, sending SIGTERM", timeout)
	s.deps.Bus.Warn("server", "graceful stop timed out, escalating to SIGTERM")
	_ = terminateProcess(pid)
	if err := s.waitExit(ctx, done, 30*time.Second, 0); err == nil {
		return nil
	}
	s.Note("Minecraft still running, sending SIGKILL")
	s.deps.Bus.Warn("server", "SIGTERM timed out, escalating to SIGKILL")
	_ = killProcess(pid)
	return s.waitExit(ctx, done, 30*time.Second, pid)
}

func (s *Supervisor) waitExit(ctx context.Context, done chan struct{}, timeout time.Duration, killPID int) error {
	if done == nil {
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		if killPID > 0 {
			return fmt.Errorf("process %d did not exit within %s", killPID, timeout)
		}
		return fmt.Errorf("minecraft did not exit within %s", timeout)
	}
}

// Restart stops and starts, reporting the restarting activity while it runs.
func (s *Supervisor) Restart(ctx context.Context, reason string) error {
	lease, mine, err := s.AcquireOrReuse(nil, ActivityRestarting)
	if err != nil {
		return err
	}
	if mine {
		defer s.Release(lease)
	}
	if s.State() != StateStopped && s.State() != StateCrashed {
		if err := s.Stop(ctx, StopOptions{Reason: "restart: " + reason}); err != nil {
			return err
		}
	}
	return s.Start()
}

// Shutdown is called when the controller itself is terminating.
func (s *Supervisor) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.shuttingDown = true
	running := s.state == StateRunning || s.state == StateStarting || s.state == StateStopping
	s.mu.Unlock()
	if !running {
		return nil
	}
	return s.Stop(ctx, StopOptions{Reason: "controller shutdown"})
}

// ---------------------------------------------------------------- commands --

var errBadCommand = errors.New("invalid console command")

// Send writes a command to the Minecraft console.
func (s *Supervisor) Send(command string) error {
	command = strings.TrimSpace(command)
	if err := ValidateCommand(command); err != nil {
		return err
	}
	s.mu.Lock()
	stdin := s.stdin
	state := s.state
	s.mu.Unlock()
	if stdin == nil || (state != StateRunning && state != StateStarting && state != StateStopping) {
		return ErrNotRunning
	}
	if _, err := io.WriteString(stdin, command+"\n"); err != nil {
		return fmt.Errorf("write console command: %w", err)
	}
	// Echo the command into the history. Without this the console shows effects
	// with no causes, which makes reading a backup or generation run confusing.
	line := s.ring.append("controller", "> "+store.Redact(command))
	s.deps.Bus.Publish(events.TypeServerLog, line)
	return nil
}

// SendMany writes several commands in order, stopping at the first failure.
func (s *Supervisor) SendMany(commands []string) error {
	for _, c := range commands {
		if err := s.Send(c); err != nil {
			return err
		}
	}
	return nil
}

// ValidateCommand rejects anything that is not a single console command. Commands
// are written to a pipe, never to a shell, but a newline would let one request
// inject a second command, so it is refused.
func ValidateCommand(command string) error {
	if command == "" {
		return fmt.Errorf("%w: empty", errBadCommand)
	}
	if len(command) > 512 {
		return fmt.Errorf("%w: longer than 512 characters", errBadCommand)
	}
	if strings.ContainsAny(command, "\n\r\x00") {
		return fmt.Errorf("%w: contains a line break", errBadCommand)
	}
	for _, r := range command {
		if r < 0x20 && r != '\t' {
			return fmt.Errorf("%w: contains a control character", errBadCommand)
		}
	}
	return nil
}

// WaitReady blocks until the server reports Done, the process exits, or the
// context ends.
func (s *Supervisor) WaitReady(ctx context.Context) error {
	if s.IsRunning() {
		return nil
	}
	s.mu.Lock()
	done := s.waitDone
	state := s.state
	s.mu.Unlock()
	if state == StateStopped || state == StateCrashed {
		return ErrNotRunning
	}
	ready := make(chan struct{})
	go func() {
		_ = s.Watch(ctx, func(ev adapter.LogEvent) bool {
			if ev.Kind == adapter.KindReady {
				close(ready)
				return true
			}
			return false
		})
	}()
	select {
	case <-ready:
		return nil
	case <-done:
		return fmt.Errorf("%w: process exited with code %d", ErrNotRunning, s.Snapshot().LastExitCode)
	case <-ctx.Done():
		return ErrNotReady
	}
}

// EnsureSaveOn re-enables world saving. It is called during startup
// reconciliation because a backup that was interrupted may have left saving off.
func (s *Supervisor) EnsureSaveOn() {
	if !s.SaveDisabled() {
		return
	}
	if !s.IsRunning() {
		// Saving state lives in the running server; clearing the flag is enough
		// once the process is gone.
		s.setSaveDisabled(false)
		return
	}
	s.Note("re-enabling world saving after an interrupted operation")
	if err := s.Send(s.deps.Backend.SaveOnCommand()); err == nil {
		s.setSaveDisabled(false)
	}
}

func (s *Supervisor) publishStateLocked() {
	state := s.effectiveStateLocked()
	s.deps.Bus.Publish(events.TypeServerState, map[string]any{
		"state":          string(state),
		"process_state":  string(s.state),
		"activity":       string(s.activity),
		"pid":            s.pid,
		"players":        len(s.players),
		"last_exit_code": s.exitCode,
		"crash_count":    s.crashCount,
	})
}

// DesiredRunning reports whether Minecraft was running when the controller last
// exited, which the reconciler uses to decide whether to start it again.
func (s *Supervisor) DesiredRunning() bool {
	v, ok, _ := s.deps.Store.GetKV(kvDesiredRunning)
	return ok && v == "true"
}

// LogsDir is where Paper writes its own log files.
func (s *Supervisor) LogsDir() string { return filepath.Join(s.deps.Paths.Runtime(), "logs") }
