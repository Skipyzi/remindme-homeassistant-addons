// Package testsupport builds the fake Paper and restic binaries and assembles the
// managers the integration tests drive.
package testsupport

import (
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

var (
	buildOnce sync.Map // package path -> *buildResult
)

type buildResult struct {
	path string
	err  error
}

// FakeBinary compiles one of the helper commands in internal/testsupport and
// returns its path. The build is cached for the whole test binary run.
func FakeBinary(t *testing.T, name string) string {
	t.Helper()
	value, _ := buildOnce.LoadOrStore(name, &buildResult{})
	result := value.(*buildResult)
	if result.path == "" && result.err == nil {
		result.path, result.err = buildFake(name)
	}
	if result.err != nil {
		t.Skipf("cannot build the %s helper (%v); a Go toolchain is required for this test", name, result.err)
	}
	return result.path
}

func buildFake(name string) (string, error) {
	if _, err := exec.LookPath("go"); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "mc-fakes-")
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, name)
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	pkg := "github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport/" + name
	cmd := exec.Command("go", "build", "-o", out, pkg)
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", &buildError{output: string(output), err: err}
	}
	return out, nil
}

type buildError struct {
	output string
	err    error
}

func (e *buildError) Error() string { return e.err.Error() + ": " + e.output }

// Env is a ready-to-use controller environment in a temporary directory.
type Env struct {
	T        *testing.T
	Paths    appcfg.Paths
	Options  appcfg.Options
	Settings *appcfg.Store
	Store    *store.Store
	Bus      *events.Bus
	Log      *slog.Logger
}

// NewEnv creates the /data layout, the state database and the settings store.
func NewEnv(t *testing.T) *Env {
	t.Helper()
	dir := t.TempDir()
	paths := appcfg.NewPaths(dir)
	if err := paths.EnsureLayout(); err != nil {
		t.Fatalf("layout: %v", err)
	}
	options := appcfg.DefaultOptions()
	settings, err := appcfg.LoadSettings(paths.SettingsFile(), options)
	if err != nil {
		t.Fatalf("settings: %v", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st, err := store.Open(paths.Database(), paths.AuditLog(), log)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	return &Env{
		T: t, Paths: paths, Options: options, Settings: settings,
		Store: st, Bus: events.NewBus(), Log: log,
	}
}

// AcceptEULA marks the licence as accepted so the supervisor will start.
func (e *Env) AcceptEULA() {
	e.T.Helper()
	if _, err := e.Settings.Update(func(s *appcfg.Settings) { s.EULAAccepted = true }); err != nil {
		e.T.Fatalf("accept eula: %v", err)
	}
}

// WriteFakeJar creates a placeholder server JAR so start-up checks pass.
func (e *Env) WriteFakeJar() {
	e.T.Helper()
	if err := os.WriteFile(e.Paths.ServerJar(), []byte("PK\x03\x04 fake jar"), 0o644); err != nil {
		e.T.Fatalf("write jar: %v", err)
	}
}

// Collect drains bus events of the given type for the duration of a test.
func Collect(bus *events.Bus, buffer int) (func() []events.Event, func()) {
	ch, cancel := bus.Subscribe(buffer)
	var mu sync.Mutex
	var seen []events.Event
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range ch {
			mu.Lock()
			seen = append(seen, ev)
			mu.Unlock()
		}
	}()
	return func() []events.Event {
		mu.Lock()
		defer mu.Unlock()
		out := make([]events.Event, len(seen))
		copy(out, seen)
		return out
	}, func() {
		cancel()
		<-done
	}
}
