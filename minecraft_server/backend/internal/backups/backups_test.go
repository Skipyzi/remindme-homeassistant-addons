package backups

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

type harness struct {
	env     *testsupport.Env
	manager *Manager
	sup     *supervisor.Supervisor
	restic  *Restic
	worldID string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	env := testsupport.NewEnv(t)
	env.AcceptEULA()
	env.WriteFakeJar()

	fakePaper := testsupport.FakeBinary(t, "fakepaper")
	fakeRestic := testsupport.FakeBinary(t, "fakerestic")
	t.Setenv("FAKEPAPER_MODE", "ready")
	t.Setenv("FAKERESTIC_FAIL", "")

	backend := paper.New()
	sup := supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: backend, Log: env.Log, JavaBin: fakePaper, Flags: paper.FlagProfile,
		ReadyTimeout: 8 * time.Second,
		ExtraEnv:     func() []string { return []string{"FAKEPAPER_MODE=" + os.Getenv("FAKEPAPER_MODE")} },
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = sup.Shutdown(ctx)
	})

	restic := &Restic{
		Bin: fakeRestic, Repo: env.Paths.ResticRepo(), PasswordFile: env.Paths.ResticPassword(),
		CacheDir: filepath.Join(env.Paths.Backups(), "cache"), Log: env.Log,
	}

	const worldID = "survival"
	worldDir := filepath.Join(env.Paths.Worlds(), worldID)
	writeWorld(t, worldDir)
	if _, err := env.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = worldID }); err != nil {
		t.Fatal(err)
	}

	manager := NewManager(Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Supervisor: sup, Backend: backend, Restic: restic, Log: env.Log,
		WorldDir:     func(id string) (string, error) { return appcfg.Confine(env.Paths.Worlds(), id) },
		ActiveWorld:  func() string { return env.Settings.Get().ActiveWorld },
		StartTimeout: 6 * time.Second,
	})

	h := &harness{env: env, manager: manager, sup: sup, restic: restic, worldID: worldID}
	h.setResticFailure("")
	if err := manager.Init(t.Context()); err != nil {
		t.Fatalf("init repository: %v", err)
	}
	return h
}

// setResticFailure rewires the fake binary's failure mode.
func (h *harness) setResticFailure(mode string) {
	h.restic.ExtraEnv = []string{"FAKERESTIC_FAIL=" + mode}
}

func TestBackupWhileStoppedIsClean(t *testing.T) {
	h := newHarness(t)

	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual", Label: "first"}, "tester", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if record.Status != store.BackupComplete {
		t.Fatalf("expected a complete backup, got %s", record.Status)
	}
	if record.Consistency != ConsistencyClean {
		t.Fatalf("a backup of a stopped server should be clean, got %s", record.Consistency)
	}
	if record.SnapshotID == "" || record.SizeBytes == 0 {
		t.Fatalf("expected snapshot details, got %+v", record)
	}
	// Staging must be cleaned up.
	entries, err := os.ReadDir(filepath.Join(h.env.Paths.Staging(), "live"))
	if err == nil && len(entries) != 0 {
		t.Fatalf("staging copy was left behind: %v", entries)
	}
	if journals, err := h.env.Store.OpenJournals(); err != nil || len(journals) != 0 {
		t.Fatalf("expected no open journal entries, got %d (%v)", len(journals), err)
	}
}

func TestSecondBackupStoresOnlyChangedData(t *testing.T) {
	h := newHarness(t)

	first, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if second.SizeBytes != first.SizeBytes {
		t.Fatalf("both snapshots should cover the same data: %d vs %d", first.SizeBytes, second.SizeBytes)
	}
	if second.AddedBytes >= first.AddedBytes {
		t.Fatalf("an unchanged world should add almost nothing: first added %d, second added %d",
			first.AddedBytes, second.AddedBytes)
	}

	// Change one region file: the next backup stores that file and nothing else.
	regionPath := filepath.Join(h.env.Paths.Worlds(), h.worldID, "world", "region", "r.0.0.mca")
	if err := os.WriteFile(regionPath, bytes.Repeat([]byte("z"), 8192), 0o644); err != nil {
		t.Fatal(err)
	}
	third, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatalf("third: %v", err)
	}
	if third.AddedBytes < 8192 {
		t.Fatalf("expected the changed region file to be stored, added %d", third.AddedBytes)
	}
	if third.AddedBytes >= first.AddedBytes {
		t.Fatalf("a single changed file should still be far less than the whole world: %d vs %d",
			third.AddedBytes, first.AddedBytes)
	}
}

func TestLiveBackupFlushesAndAlwaysRestoresSaving(t *testing.T) {
	h := newHarness(t)
	startServer(t, h)

	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if record.Consistency != ConsistencyFlushed {
		t.Fatalf("expected a flushed backup, got %s", record.Consistency)
	}
	if h.sup.SaveDisabled() {
		t.Fatal("world saving was left disabled after a successful backup")
	}
	console := consoleText(h.sup)
	for _, expected := range []string{"save-off", "Saved the game", "Automatic saving is now enabled"} {
		if !strings.Contains(console, expected) {
			t.Errorf("expected %q in the console:\n%s", expected, console)
		}
	}
}

func TestFailedBackupReEnablesSavingAndRecordsTheFailure(t *testing.T) {
	h := newHarness(t)
	startServer(t, h)
	h.setResticFailure("backup")

	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err == nil {
		t.Fatal("expected the backup to fail")
	}
	if record.Status != store.BackupFailed {
		t.Fatalf("expected a failed record, got %s", record.Status)
	}
	// This is the invariant that matters most: a failed backup must never leave a
	// server that is not saving.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && h.sup.SaveDisabled() {
		time.Sleep(50 * time.Millisecond)
	}
	if h.sup.SaveDisabled() {
		t.Fatal("world saving was left disabled after a failed backup")
	}
	if journals, err := h.env.Store.OpenJournals(); err != nil || len(journals) != 0 {
		t.Fatalf("the failed operation should be closed in the journal, got %d", len(journals))
	}
}

func TestOfflineBackupStopsAndRestartsTheServer(t *testing.T) {
	h := newHarness(t)
	startServer(t, h)

	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual", Offline: true}, "tester", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if record.Consistency != ConsistencyClean {
		t.Fatalf("an offline backup must be clean, got %s", record.Consistency)
	}
	waitFor(t, 15*time.Second, func() bool { return h.sup.IsRunning() })
}

func TestRestorePutsTheWorldBackAndTakesASafetyBackup(t *testing.T) {
	h := newHarness(t)

	original := []byte("original chunk data")
	regionPath := filepath.Join(h.env.Paths.Worlds(), h.worldID, "world", "region", "r.0.0.mca")
	if err := os.WriteFile(regionPath, original, 0o644); err != nil {
		t.Fatal(err)
	}
	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	// Ruin the world after the backup.
	if err := os.WriteFile(regionPath, []byte("corrupted"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := h.manager.Restore(t.Context(), RestoreRequest{BackupID: record.ID}, "tester")
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.RolledBack {
		t.Fatal("the restore should have succeeded")
	}
	if result.SafetyBackup == "" {
		t.Fatal("expected a safety backup of the pre-restore world")
	}
	restored, err := os.ReadFile(regionPath)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatalf("expected the original content back, got %q", restored)
	}
	if journals, err := h.env.Store.OpenJournals(); err != nil || len(journals) != 0 {
		t.Fatalf("expected no open journal entries, got %d", len(journals))
	}
}

func TestRestoreRollsBackWhenTheServerDoesNotStart(t *testing.T) {
	h := newHarness(t)

	regionPath := filepath.Join(h.env.Paths.Worlds(), h.worldID, "world", "region", "r.0.0.mca")
	if err := os.WriteFile(regionPath, []byte("snapshot content"), 0o644); err != nil {
		t.Fatal(err)
	}
	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatal(err)
	}

	current := []byte("current world, must survive a failed restore")
	if err := os.WriteFile(regionPath, current, 0o644); err != nil {
		t.Fatal(err)
	}
	startServer(t, h)

	// The server will not come up after the restore.
	t.Setenv("FAKEPAPER_MODE", "no_ready")

	result, err := h.manager.Restore(t.Context(), RestoreRequest{BackupID: record.ID}, "tester")
	if err == nil {
		t.Fatal("expected the restore to fail")
	}
	if !result.RolledBack {
		t.Fatalf("expected a rollback, got %+v", result)
	}
	got, readErr := os.ReadFile(regionPath)
	if readErr != nil {
		t.Fatalf("the pre-restore world is gone: %v", readErr)
	}
	if !bytes.Equal(got, current) {
		t.Fatalf("a failed restore destroyed the active world: %q", got)
	}

	// The rollback restarted the server; stop it here so the temporary directory
	// is not still in use when the test framework cleans up.
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStop()
	if err := h.sup.Shutdown(stopCtx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	waitFor(t, 10*time.Second, func() bool { return !h.sup.IsRunning() })
}

func TestReconcileRollsBackAnInterruptedSwap(t *testing.T) {
	h := newHarness(t)

	worldDir := filepath.Join(h.env.Paths.Worlds(), h.worldID)
	aside := worldDir + ".previous.test"
	// Simulate a controller that died between moving the old world aside and
	// confirming the new one.
	if err := os.Rename(worldDir, aside); err != nil {
		t.Fatal(err)
	}
	writeWorld(t, worldDir)
	if err := os.WriteFile(filepath.Join(worldDir, "world", "region", "r.0.0.mca"), []byte("half restored"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Store.JournalBegin(store.OpRestore, "verify_start", map[string]any{
		"world": h.worldID, "aside": aside, "backup": "bk-test",
	}); err != nil {
		t.Fatal(err)
	}

	h.manager.ReconcileInterrupted(t.Context())

	if journals, err := h.env.Store.OpenJournals(); err != nil || len(journals) != 0 {
		t.Fatalf("expected the journal entry to be closed, got %d", len(journals))
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatal("expected the aside copy to be moved back")
	}
	content, err := os.ReadFile(filepath.Join(worldDir, "world", "region", "r.0.0.mca"))
	if err != nil {
		t.Fatalf("world missing after recovery: %v", err)
	}
	if string(content) == "half restored" {
		t.Fatal("expected the pre-restore world to be restored, not the half-written one")
	}
}

func TestReconcileCleansAnInterruptedBackup(t *testing.T) {
	h := newHarness(t)

	staging := filepath.Join(h.env.Paths.Staging(), "live", h.worldID)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	record := store.BackupRecord{ID: "bk-interrupted", WorldID: h.worldID, Kind: "manual",
		Status: store.BackupRunning, CreatedAt: time.Now()}
	if err := h.env.Store.PutBackup(record); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Store.JournalBegin(store.OpBackup, "restic", map[string]any{
		"record": record.ID, "staging": staging, "world": h.worldID,
	}); err != nil {
		t.Fatal(err)
	}

	h.manager.ReconcileInterrupted(t.Context())

	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatal("expected the staging copy to be removed")
	}
	updated, ok, err := h.env.Store.GetBackup(record.ID)
	if err != nil || !ok {
		t.Fatalf("record missing: %v", err)
	}
	if updated.Status != store.BackupFailed {
		t.Fatalf("expected the interrupted record to be marked failed, got %s", updated.Status)
	}
}

func TestRetentionForgetsSnapshotsAndReconcilesTheIndex(t *testing.T) {
	h := newHarness(t)
	if _, err := h.env.Settings.Update(func(s *appcfg.Settings) {
		s.BackupRetention = appcfg.Retention{KeepLast: 1}
	}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil); err != nil {
			t.Fatalf("backup %d: %v", i, err)
		}
	}
	if err := h.manager.ApplyRetention(t.Context(), "tester"); err != nil {
		t.Fatalf("retention: %v", err)
	}
	// The fake restic accepts the policy without deleting anything, so the local
	// index must still match what the repository reports.
	records, err := h.manager.List(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if record.Status == store.BackupComplete && !record.Exists {
			t.Fatalf("record %s is not in the repository any more", record.ID)
		}
	}
}

func TestDeleteRemovesSnapshotAndRecord(t *testing.T) {
	h := newHarness(t)
	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.manager.Delete(t.Context(), record.ID, "tester"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok, err := h.env.Store.GetBackup(record.ID); err != nil || ok {
		t.Fatalf("expected the record to be gone (ok=%v err=%v)", ok, err)
	}
}

func TestHealthReportsTheRepository(t *testing.T) {
	h := newHarness(t)
	if _, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil); err != nil {
		t.Fatal(err)
	}
	health := h.manager.Health(t.Context())
	if !health.Available {
		t.Fatalf("expected the repository to be available: %s", health.Error)
	}
	if health.SnapshotCount == 0 {
		t.Error("expected at least one snapshot")
	}
	if health.LastBackupAt == "" {
		t.Error("expected the last backup time to be reported")
	}
}

func TestPreviewListsSnapshotContent(t *testing.T) {
	h := newHarness(t)
	record, err := h.manager.Create(t.Context(), CreateRequest{Kind: "manual"}, "tester", nil)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := h.manager.Preview(t.Context(), record.ID)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(preview.Entries) == 0 {
		t.Fatal("expected entries in the preview")
	}
}

// ------------------------------------------------------------------ helpers --

func startServer(t *testing.T, h *harness) {
	t.Helper()
	if err := h.sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := h.sup.WaitReady(ctx); err != nil {
		t.Fatalf("wait ready: %v", err)
	}
}

func writeWorld(t *testing.T, dir string) {
	t.Helper()
	regionDir := filepath.Join(dir, "world", "region")
	if err := os.MkdirAll(regionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "world", "level.dat"), []byte("level"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(regionDir, "r.0.0.mca"), bytes.Repeat([]byte("a"), 16384), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(regionDir, "r.0.1.mca"), bytes.Repeat([]byte("b"), 16384), 0o644); err != nil {
		t.Fatal(err)
	}
}

func consoleText(sup *supervisor.Supervisor) string {
	var sb strings.Builder
	for _, line := range sup.Console(0, 500) {
		sb.WriteString(line.Text)
		sb.WriteByte('\n')
	}
	return sb.String()
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition was not met in time")
}

// A repository that exists but cannot be opened must never be re-initialised:
// doing so writes a fresh key over the existing one and makes every snapshot in
// it unreadable.
func TestEnsureRepoNeverReinitialisesAnExistingRepository(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(repo, "config")
	if err := os.WriteFile(config, []byte("existing repository config"), 0o600); err != nil {
		t.Fatal(err)
	}

	client := &Restic{
		Bin:          testsupport.FakeBinary(t, "fakerestic"),
		Repo:         repo,
		PasswordFile: filepath.Join(dir, "restic.pass"),
		CacheDir:     filepath.Join(dir, "cache"),
		ExtraEnv:     []string{"FAKERESTIC_FAIL=cat"},
	}

	err := client.EnsureRepo(context.Background())
	if err == nil {
		t.Fatal("expected the unreadable repository to be reported")
	}
	if !strings.Contains(err.Error(), "could not be opened") {
		t.Fatalf("unexpected error: %v", err)
	}
	raw, readErr := os.ReadFile(config)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(raw) != "existing repository config" {
		t.Fatalf("the existing repository config was overwritten: %q", raw)
	}
}
