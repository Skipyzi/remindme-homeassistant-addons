package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"remindme.local/model-manager/internal/hardware"
	"remindme.local/model-manager/internal/state"
)

type fakeProcess struct {
	mu      sync.Mutex
	stopped bool
	exited  bool
}

func (process *fakeProcess) Stop(time.Duration) error {
	process.mu.Lock()
	defer process.mu.Unlock()
	process.stopped = true
	return nil
}

func (process *fakeProcess) Wait() error { return nil }

func (process *fakeProcess) Exited() bool {
	process.mu.Lock()
	defer process.mu.Unlock()
	return process.exited
}

type fakeLauncher struct {
	mu       sync.Mutex
	active   string
	starts   map[string]int
	failures map[string]error
}

func (launcher *fakeLauncher) Start(_ context.Context, _ string, args []string) (Process, error) {
	model := argument(args, "--model")
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.starts[filepath.Base(model)]++
	if err := launcher.failures[filepath.Base(model)]; err != nil {
		return nil, err
	}
	launcher.active = filepath.Base(model)
	return &fakeProcess{}, nil
}

func (launcher *fakeLauncher) activeModel() string {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	return launcher.active
}

func argument(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

func newTestSupervisor(t *testing.T, probeFailures map[string]error) (*Supervisor, *fakeLauncher, state.Store) {
	t.Helper()
	launcher := &fakeLauncher{starts: map[string]int{}, failures: map[string]error{}}
	store := state.Store{Path: filepath.Join(t.TempDir(), "state.json")}
	supervisor, err := NewSupervisor(Config{
		Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: t.TempDir(),
		ReadinessTimeout: 10 * time.Millisecond, ProbeInterval: time.Millisecond,
	}, launcher, store, func(context.Context) error {
		return probeFailures[launcher.activeModel()]
	})
	if err != nil {
		t.Fatal(err)
	}
	return supervisor, launcher, store
}

func TestStartRetriesUntilLlamaServerIsReady(t *testing.T) {
	attempts := 0
	launcher := &fakeLauncher{starts: map[string]int{}, failures: map[string]error{}}
	supervisor, err := NewSupervisor(Config{
		Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: t.TempDir(),
		ReadinessTimeout: 100 * time.Millisecond, ProbeInterval: time.Millisecond,
	}, launcher, state.Store{Path: filepath.Join(t.TempDir(), "state.json")}, func(context.Context) error {
		attempts++
		if attempts < 3 {
			return errors.New("connection refused")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	model := state.Installed{ID: "delayed", Path: filepath.Join(t.TempDir(), "delayed.gguf")}
	if err := supervisor.Start(context.Background(), model, hardware.Runtime{Context: 4096, Batch: 128, UBatch: 64, Threads: 4}); err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("expected three readiness attempts, got %d", attempts)
	}
}

func TestReadinessTimeoutReturnsLastProbeError(t *testing.T) {
	supervisor, err := NewSupervisor(Config{
		Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: t.TempDir(),
		ReadinessTimeout: 5 * time.Millisecond, ProbeInterval: time.Millisecond,
	}, &fakeLauncher{starts: map[string]int{}, failures: map[string]error{}}, state.Store{Path: filepath.Join(t.TempDir(), "state.json")}, func(context.Context) error {
		return errors.New("connection refused")
	})
	if err != nil {
		t.Fatal(err)
	}
	err = supervisor.probeWithTimeout(context.Background(), &fakeProcess{})
	if err == nil || !strings.Contains(err.Error(), "readiness timeout") || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("unexpected timeout error: %v", err)
	}
}

func TestReadinessStopsWhenProcessExited(t *testing.T) {
	supervisor, err := NewSupervisor(Config{
		Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: t.TempDir(),
		ReadinessTimeout: time.Second, ProbeInterval: time.Millisecond,
	}, &fakeLauncher{starts: map[string]int{}, failures: map[string]error{}}, state.Store{Path: filepath.Join(t.TempDir(), "state.json")}, func(context.Context) error {
		return errors.New("connection refused")
	})
	if err != nil {
		t.Fatal(err)
	}
	err = supervisor.probeWithTimeout(context.Background(), &fakeProcess{exited: true})
	if err == nil || !strings.Contains(err.Error(), "llama server exited before readiness") {
		t.Fatalf("unexpected process-exit error: %v", err)
	}
}

func TestActivateRestoresFallbackWhenCandidateProbeFails(t *testing.T) {
	supervisor, launcher, store := newTestSupervisor(t, map[string]error{"broken.gguf": errors.New("unhealthy")})
	stable := state.Installed{ID: "stable", Path: filepath.Join(t.TempDir(), "stable.gguf"), Healthy: true}
	candidate := state.Installed{ID: "broken", Path: filepath.Join(t.TempDir(), "broken.gguf")}
	if err := supervisor.Start(context.Background(), stable, hardware.Runtime{Context: 4096, Batch: 128, UBatch: 64, Threads: 4}); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Activate(context.Background(), candidate, hardware.Runtime{Context: 4096, Batch: 128, UBatch: 64, Threads: 4}); err == nil {
		t.Fatal("expected probe failure")
	}
	if supervisor.ActiveID() != "stable" || launcher.starts["stable.gguf"] != 2 {
		t.Fatalf("rollback failed: active=%q starts=%#v", supervisor.ActiveID(), launcher.starts)
	}
	persisted, err := store.Load()
	if err != nil || persisted.Active == nil || persisted.Active.ID != "stable" || persisted.LastError == nil || persisted.LastError.Code != CodeActivationRolledBack {
		t.Fatalf("unexpected persisted state: %#v err=%v", persisted, err)
	}
}

func TestActivatePromotesCandidateAndRetainsOldModel(t *testing.T) {
	supervisor, _, store := newTestSupervisor(t, map[string]error{})
	stable := state.Installed{ID: "stable", Path: filepath.Join(t.TempDir(), "stable.gguf"), Healthy: true}
	candidate := state.Installed{ID: "candidate", Path: filepath.Join(t.TempDir(), "candidate.gguf")}
	runtime := hardware.Runtime{Context: 8192, Batch: 256, UBatch: 128, Threads: 4, ReasoningFormat: "deepseek", ReasoningMode: "auto"}
	if err := supervisor.Start(context.Background(), stable, runtime); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Activate(context.Background(), candidate, runtime); err != nil {
		t.Fatal(err)
	}
	persisted, err := store.Load()
	if err != nil || persisted.Active == nil || persisted.Active.ID != "candidate" || persisted.Fallback == nil || persisted.Fallback.ID != "stable" {
		t.Fatalf("unexpected persisted state: %#v err=%v", persisted, err)
	}
}

func TestLlamaArgsUseValidatedValuesWithoutShell(t *testing.T) {
	args := llamaArgs(state.Installed{Path: "/data/models/model.gguf"}, hardware.Runtime{Context: 8192, Batch: 256, UBatch: 128, Threads: 4, ReasoningFormat: "deepseek", ReasoningMode: "auto"})
	joined := strings.Join(args, " ")
	for _, expected := range []string{"--model /data/models/model.gguf", "--port 8081", "--ctx-size 8192", "--reasoning-format deepseek", "--reasoning auto"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %q", expected, joined)
		}
	}
}

func TestPruneProtectsActiveFallbackAndOperation(t *testing.T) {
	dir := t.TempDir()
	paths := map[string]string{
		"active": filepath.Join(dir, "active.gguf"), "fallback": filepath.Join(dir, "fallback.gguf"),
		"operation": filepath.Join(dir, "operation.gguf"), "old": filepath.Join(dir, "old.gguf"),
	}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("GGUF"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	supervisor, err := NewSupervisor(Config{Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: dir}, &fakeLauncher{starts: map[string]int{}, failures: map[string]error{}}, state.Store{Path: filepath.Join(t.TempDir(), "state.json")}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	current := state.State{Active: &state.Installed{Path: paths["active"]}, Fallback: &state.Installed{Path: paths["fallback"]}, Operation: &state.Operation{ModelPath: paths["operation"]}}
	if err := supervisor.Prune(current); err != nil {
		t.Fatal(err)
	}
	for name, path := range paths {
		_, statErr := os.Stat(path)
		if name == "old" && !os.IsNotExist(statErr) {
			t.Fatal("old model was not pruned")
		}
		if name != "old" && statErr != nil {
			t.Fatalf("protected %s was removed: %v", name, statErr)
		}
	}
}
