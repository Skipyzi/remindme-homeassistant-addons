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

// fakeLauncher records router starts and the preset each one was given.
type fakeLauncher struct {
	mu      sync.Mutex
	starts  int
	presets []string
	fail    error
	last    *fakeProcess
}

func (launcher *fakeLauncher) Start(_ context.Context, _ string, args []string) (Process, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	if launcher.fail != nil {
		return nil, launcher.fail
	}
	launcher.starts++
	preset, _ := os.ReadFile(argument(args, "--models-preset"))
	launcher.presets = append(launcher.presets, string(preset))
	launcher.last = &fakeProcess{}
	return launcher.last, nil
}

func (launcher *fakeLauncher) startCount() int {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	return launcher.starts
}

func argument(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

// fakeProbe answers per model: an error from failures, otherwise success.
type fakeProbe struct {
	mu       sync.Mutex
	failures map[string]error
	probed   []string
}

func (probe *fakeProbe) check(_ context.Context, model string) error {
	probe.mu.Lock()
	defer probe.mu.Unlock()
	probe.probed = append(probe.probed, model)
	return probe.failures[model]
}

type fixture struct {
	supervisor *Supervisor
	launcher   *fakeLauncher
	probe      *fakeProbe
	store      state.Store
	dir        string
}

func newFixture(t *testing.T, files ...string) fixture {
	t.Helper()
	dir := t.TempDir()
	for _, file := range files {
		if err := os.WriteFile(filepath.Join(dir, file), []byte("GGUF"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	launcher := &fakeLauncher{}
	probe := &fakeProbe{failures: map[string]error{}}
	store := state.Store{Path: filepath.Join(t.TempDir(), "state.json")}
	supervisor, err := NewSupervisor(Config{
		Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: dir,
		PresetPath: filepath.Join(t.TempDir(), "router-models.ini"), MaxModels: 2,
		ReadinessTimeout: 20 * time.Millisecond, ProbeInterval: time.Millisecond,
		Identify: func(file string) string {
			if file == "Qwen3-4B-Q4_K_M.gguf" {
				return "qwen3-4b-q4"
			}
			return ""
		},
	}, launcher, store, probe.check)
	if err != nil {
		t.Fatal(err)
	}
	return fixture{supervisor: supervisor, launcher: launcher, probe: probe, store: store, dir: dir}
}

func (current fixture) installed(id, file string) state.Installed {
	return state.Installed{ID: id, File: file, Path: filepath.Join(current.dir, file)}
}

var testRuntime = hardware.Runtime{Context: 8192, Batch: 256, UBatch: 128, Threads: 4, Parallel: 2, KVUnified: true}

func TestStartServesEveryDownloadedModelWithTheConfiguredDefault(t *testing.T) {
	current := newFixture(t, "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf", "Qwen3-4B-Q4_K_M.gguf", "half.gguf.partial", "vision-mmproj.gguf")
	if err := current.supervisor.Start(context.Background(), current.installed("local-model", "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if current.launcher.startCount() != 1 {
		t.Fatalf("router should start once, started %d times", current.launcher.startCount())
	}
	preset := current.launcher.presets[0]
	for _, expected := range []string{"[qwen3-4b-q4]", "[speakoflow-mini-0.8b-q4_k_m]", "alias = Qwen3-4B-Q4_K_M"} {
		if !strings.Contains(preset, expected) {
			t.Fatalf("preset missing %q:\n%s", expected, preset)
		}
	}
	if strings.Contains(preset, "partial") || strings.Contains(preset, "mmproj") {
		t.Fatalf("preset must skip partial downloads and projectors:\n%s", preset)
	}
	if got := current.supervisor.ResolveModel(""); got != "speakoflow-mini-0.8b-q4_k_m" {
		t.Fatalf("default model = %q", got)
	}
	if got := current.probe.probed[len(current.probe.probed)-1]; got != "speakoflow-mini-0.8b-q4_k_m" {
		t.Fatalf("probed %q, want the default model", got)
	}
}

func TestUnknownAndMissingNamesResolveToTheDefault(t *testing.T) {
	current := newFixture(t, "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf", "Qwen3-4B-Q4_K_M.gguf")
	if err := current.supervisor.Start(context.Background(), current.installed("local-model", "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"":                     "speakoflow-mini-0.8b-q4_k_m",
		"gpt-4o":               "speakoflow-mini-0.8b-q4_k_m",
		"qwen3-1.7b":           "speakoflow-mini-0.8b-q4_k_m",
		"qwen3-4b-q4":          "qwen3-4b-q4",
		"Qwen3-4B-Q4_K_M":      "qwen3-4b-q4",
		"QWEN3-4B-Q4_K_M.gguf": "qwen3-4b-q4",
	}
	for requested, want := range cases {
		if got := current.supervisor.ResolveModel(requested); got != want {
			t.Fatalf("ResolveModel(%q) = %q, want %q", requested, got, want)
		}
	}
}

func TestStartRetriesUntilTheDefaultAnswers(t *testing.T) {
	current := newFixture(t, "a.gguf")
	attempts := 0
	current.supervisor.probe = func(context.Context, string) error {
		attempts++
		if attempts < 3 {
			return errors.New("loading")
		}
		return nil
	}
	if err := current.supervisor.Start(context.Background(), current.installed("a", "a.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("probe attempts = %d", attempts)
	}
}

func TestReadinessTimeoutReturnsLastProbeError(t *testing.T) {
	current := newFixture(t, "a.gguf")
	current.probe.failures["a"] = errors.New("still loading")
	err := current.supervisor.Start(context.Background(), current.installed("a", "a.gguf"), testRuntime)
	if err == nil || !strings.Contains(err.Error(), "still loading") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReadinessStopsWhenRouterExited(t *testing.T) {
	current := newFixture(t, "a.gguf")
	current.supervisor.probe = func(context.Context, string) error {
		current.launcher.last.mu.Lock()
		current.launcher.last.exited = true
		current.launcher.last.mu.Unlock()
		return errors.New("connection refused")
	}
	err := current.supervisor.Start(context.Background(), current.installed("a", "a.gguf"), testRuntime)
	if err == nil || !strings.Contains(err.Error(), "exited before readiness") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestActivateSwitchesTheDefaultWithoutRestartingOrDeleting(t *testing.T) {
	current := newFixture(t, "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf", "Qwen3-4B-Q4_K_M.gguf")
	ctx := context.Background()
	if err := current.supervisor.Start(ctx, current.installed("local-model", "SpeakoFlow-Mini-0.8B-Q4_K_M.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if err := current.supervisor.Activate(ctx, current.installed("qwen3-4b-q4", "Qwen3-4B-Q4_K_M.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if current.launcher.startCount() != 1 {
		t.Fatalf("switching the default must not restart the router (starts=%d)", current.launcher.startCount())
	}
	if got := current.supervisor.ResolveModel(""); got != "qwen3-4b-q4" {
		t.Fatalf("default after switch = %q", got)
	}
	if got := current.supervisor.ResolveModel("SpeakoFlow-Mini-0.8B-Q4_K_M"); got != "speakoflow-mini-0.8b-q4_k_m" {
		t.Fatalf("the previous model must stay reachable by name, got %q", got)
	}
	for _, file := range []string{"SpeakoFlow-Mini-0.8B-Q4_K_M.gguf", "Qwen3-4B-Q4_K_M.gguf"} {
		if _, err := os.Stat(filepath.Join(current.dir, file)); err != nil {
			t.Fatalf("%s was removed by a switch: %v", file, err)
		}
	}
	persisted, err := current.store.Load()
	if err != nil || persisted.Active == nil || persisted.Active.ID != "qwen3-4b-q4" || persisted.Fallback == nil || persisted.Fallback.ID != "local-model" {
		t.Fatalf("unexpected persisted state: %#v err=%v", persisted, err)
	}
}

func TestActivatingANewDownloadReloadsTheRouterOnce(t *testing.T) {
	current := newFixture(t, "a.gguf")
	ctx := context.Background()
	if err := current.supervisor.Start(ctx, current.installed("a", "a.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current.dir, "b.gguf"), []byte("GGUF"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := current.supervisor.Activate(ctx, current.installed("b", "b.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	if current.launcher.startCount() != 2 {
		t.Fatalf("expected one reload, starts=%d", current.launcher.startCount())
	}
	if !strings.Contains(current.launcher.presets[1], "[b]") {
		t.Fatalf("reloaded preset lacks the new model:\n%s", current.launcher.presets[1])
	}
	if got := current.supervisor.ResolveModel(""); got != "b" {
		t.Fatalf("default = %q", got)
	}
}

func TestFailedSwitchKeepsThePreviousDefault(t *testing.T) {
	current := newFixture(t, "a.gguf", "b.gguf")
	ctx := context.Background()
	if err := current.supervisor.Start(ctx, current.installed("a", "a.gguf"), testRuntime); err != nil {
		t.Fatal(err)
	}
	current.probe.failures["b"] = errors.New("out of memory")
	err := current.supervisor.Activate(ctx, current.installed("b", "b.gguf"), testRuntime)
	if err == nil || !strings.Contains(err.Error(), "previous model restored") {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := current.supervisor.ResolveModel(""); got != "a" {
		t.Fatalf("default after failed switch = %q", got)
	}
	if current.launcher.startCount() != 1 {
		t.Fatalf("a failed switch on a live router must not restart it (starts=%d)", current.launcher.startCount())
	}
	persisted := current.supervisor.State()
	if persisted.Active == nil || persisted.Active.ID != "a" || persisted.LastError == nil || persisted.LastError.Code != CodeActivationRolledBack {
		t.Fatalf("unexpected state: %#v", persisted)
	}
	if _, err := os.Stat(filepath.Join(current.dir, "b.gguf")); err != nil {
		t.Fatal("the failed candidate's file must be kept")
	}
}

func TestRouterArgsCarryRuntimeAndModelLimits(t *testing.T) {
	args := routerArgs(hardware.Runtime{
		Context: 8192, Batch: 256, UBatch: 128, Threads: 4, ThreadsBatch: 3,
		CacheReuse: 512, Parallel: 2, Jinja: true, KVUnified: true, FlashAttention: true,
		ReasoningFormat: "deepseek", ReasoningMode: "auto",
	}, "/data/model-manager/router-models.ini", 2)
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"--models-preset /data/model-manager/router-models.ini", "--models-max 2", "--port 8081",
		"--ctx-size 8192", "--parallel 2", "--threads-batch 3", "--cache-reuse 512", "--jinja",
		"--kv-unified", "--flash-attn", "--reasoning-format deepseek", "--reasoning auto",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %q", expected, joined)
		}
	}
	if strings.Contains(joined, "--model ") {
		t.Fatalf("a router takes no single --model: %q", joined)
	}
}

func TestRouterArgsKeepOneSlotWithoutUnifiedKV(t *testing.T) {
	base := hardware.Runtime{Context: 8192, Batch: 256, UBatch: 128, Threads: 4}
	cases := []struct {
		parallel int
		unified  bool
		want     string
	}{
		{parallel: 2, unified: false, want: "--parallel 1"},
		{parallel: 0, unified: true, want: "--parallel 1"},
		{parallel: 9, unified: true, want: "--parallel 4"},
	}
	for _, current := range cases {
		runtime := base
		runtime.Parallel, runtime.KVUnified = current.parallel, current.unified
		joined := strings.Join(routerArgs(runtime, "/p.ini", 2), " ")
		if !strings.Contains(joined, current.want) {
			t.Fatalf("parallel=%d unified=%v: want %q in %q", current.parallel, current.unified, current.want, joined)
		}
	}
}
