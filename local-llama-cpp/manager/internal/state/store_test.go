package state

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRecoveryRollsBackInterruptedActivation(t *testing.T) {
	current := State{
		Phase:    PhaseActivating,
		Active:   &Installed{ID: "candidate", Path: "/models/candidate.gguf"},
		Fallback: &Installed{ID: "stable", Path: "/models/stable.gguf", Healthy: true},
	}
	decision := Recovery(current, func(path string) bool { return path == "/models/stable.gguf" })
	if decision.Action != ActionRestore || decision.Model == nil || decision.Model.ID != "stable" {
		t.Fatalf("unexpected decision: %#v", decision)
	}
}

func TestRecoveryResumesInterruptedDownload(t *testing.T) {
	current := State{Phase: PhaseDownloading, Operation: &Operation{ID: "op", VariantID: "candidate", ModelPath: "/models/candidate.gguf.partial"}}
	decision := Recovery(current, func(path string) bool { return path == "/models/candidate.gguf.partial" })
	if decision.Action != ActionResume || decision.Operation == nil || decision.Operation.ID != "op" {
		t.Fatalf("unexpected decision: %#v", decision)
	}
}

func TestRecoveryDegradesWithoutHealthyModel(t *testing.T) {
	decision := Recovery(State{Phase: PhaseProbing}, func(string) bool { return false })
	if !decision.Degraded || decision.Action != ActionDegraded {
		t.Fatalf("unexpected decision: %#v", decision)
	}
}

func TestSaveLoadUsesAtomicFileAnd0600(t *testing.T) {
	dir := t.TempDir()
	store := Store{Path: filepath.Join(dir, "state.json")}
	want := State{Phase: PhaseIdle, Active: &Installed{ID: "stable", Healthy: true}}
	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.Path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v", info.Mode().Perm())
	}
	got, err := store.Load()
	if err != nil || got.Active == nil || got.Active.ID != "stable" || got.Version != CurrentVersion {
		t.Fatalf("got=%#v err=%v", got, err)
	}
}

func TestLoadQuarantinesMalformedState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{Path: path, Now: func() time.Time { return time.Unix(123, 0) }}
	got, err := store.Load()
	if err == nil || got.Phase != PhaseDegraded {
		t.Fatalf("got=%#v err=%v", got, err)
	}
	if _, err := os.Stat(path + ".corrupt-123"); err != nil {
		t.Fatalf("quarantine missing: %v", err)
	}
}

func TestStateTransitionsPreserveOperationError(t *testing.T) {
	current := State{Phase: PhaseIdle}.Begin("op", "candidate", "/models/candidate.gguf.partial", 100)
	current = current.Transition(PhaseDownloading, 20)
	current = current.Fail("download_interrupted", "Download interrupted; it can be resumed.")
	if current.Operation == nil || current.Operation.BytesDone != 20 || current.Operation.ErrorCode != "download_interrupted" || current.Phase != PhaseFailed {
		t.Fatalf("unexpected state: %#v", current)
	}
}
