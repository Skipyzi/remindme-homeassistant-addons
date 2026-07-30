package store

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "controller.db")
	st, err := Open(dbPath, filepath.Join(dir, "audit", "audit.log"), slog.Default())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, dbPath
}

func TestCorruptDatabaseIsMovedAsideAndRecreated(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "controller.db")
	// A file that is not SQLite at all is the worst case: an SD card that returned
	// garbage. The add-on must still start.
	if err := os.WriteFile(dbPath, []byte("this is not a database"), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := Open(dbPath, filepath.Join(dir, "audit", "audit.log"), slog.Default())
	if err != nil {
		t.Fatalf("expected recovery, got %v", err)
	}
	defer st.Close()

	if err := st.SetKV("probe", "value"); err != nil {
		t.Fatalf("the recreated database is not writable: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var corruptCopies int
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".corrupt-") {
			corruptCopies++
		}
	}
	if corruptCopies != 1 {
		t.Fatalf("expected the broken file to be kept for inspection, found %d copies", corruptCopies)
	}
	audit, err := st.RecentAudit(10, "database.")
	if err != nil || len(audit) == 0 {
		t.Fatalf("expected the recovery to be audited, got %d (%v)", len(audit), err)
	}
}

func TestKeyValueRoundTrip(t *testing.T) {
	st, _ := open(t)

	if _, ok, err := st.GetKV("missing"); err != nil || ok {
		t.Fatalf("missing key reported ok=%v err=%v", ok, err)
	}
	if err := st.SetKV("k", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetKV("k", "v2"); err != nil {
		t.Fatal(err)
	}
	value, ok, err := st.GetKV("k")
	if err != nil || !ok || value != "v2" {
		t.Fatalf("got %q ok=%v err=%v", value, ok, err)
	}

	type payload struct {
		Radius int `json:"radius"`
	}
	if err := st.SetJSON("params", payload{Radius: 3000}); err != nil {
		t.Fatal(err)
	}
	var out payload
	found, err := st.GetJSON("params", &out)
	if err != nil || !found || out.Radius != 3000 {
		t.Fatalf("json round trip failed: %+v found=%v err=%v", out, found, err)
	}

	n, err := st.IncrKV("counter", 2)
	if err != nil || n != 2 {
		t.Fatalf("increment: %d (%v)", n, err)
	}
	if n, _ := st.IncrKV("counter", 3); n != 5 {
		t.Fatalf("expected 5, got %d", n)
	}
}

func TestAuditWritesBothTheDatabaseAndTheTextLog(t *testing.T) {
	st, dbPath := open(t)
	auditPath := filepath.Join(filepath.Dir(dbPath), "audit", "audit.log")

	if err := st.Audit(AuditEntry{Actor: "tester", Action: "world.trash", Target: "survival",
		Detail: "moved to trash"}); err != nil {
		t.Fatalf("audit: %v", err)
	}
	entries, err := st.RecentAudit(10, "")
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one entry, got %d (%v)", len(entries), err)
	}
	if entries[0].Result != "ok" {
		t.Fatalf("expected a default result, got %q", entries[0].Result)
	}
	raw, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatalf("the human-readable log is missing: %v", err)
	}
	line := string(raw)
	for _, part := range []string{"tester", "world.trash", "survival", "moved to trash"} {
		if !strings.Contains(line, part) {
			t.Errorf("expected %q in the text log: %s", part, line)
		}
	}
}

func TestAuditRedactsSecrets(t *testing.T) {
	st, _ := open(t)
	if err := st.Audit(AuditEntry{Actor: "tester", Action: "config.write",
		Detail: `rcon.password=hunter2 mqtt_password: "s3cret" token=abc123`}); err != nil {
		t.Fatal(err)
	}
	entries, err := st.RecentAudit(1, "")
	if err != nil || len(entries) == 0 {
		t.Fatal("no entries")
	}
	detail := entries[0].Detail
	for _, secret := range []string{"hunter2", "s3cret", "abc123"} {
		if strings.Contains(detail, secret) {
			t.Errorf("secret %q survived redaction: %s", secret, detail)
		}
	}
	if !strings.Contains(detail, "***") {
		t.Errorf("expected masking, got %s", detail)
	}
}

func TestJournalPhasesMergePayloads(t *testing.T) {
	st, _ := open(t)

	id, err := st.JournalBegin(OpRestore, "verify", map[string]any{"backup": "bk-1"})
	if err != nil {
		t.Fatal(err)
	}
	open1, err := st.OpenJournals()
	if err != nil || len(open1) != 1 {
		t.Fatalf("expected one open entry, got %d (%v)", len(open1), err)
	}
	if err := st.JournalPhase(id, "swap", map[string]any{"aside": "/data/worlds/x.previous"}); err != nil {
		t.Fatal(err)
	}
	open2, err := st.OpenJournals()
	if err != nil {
		t.Fatal(err)
	}
	entry := open2[0]
	if entry.Phase != "swap" {
		t.Fatalf("expected the phase to advance, got %q", entry.Phase)
	}
	// Earlier payload keys must survive: recovery needs both the backup id and the
	// aside directory.
	if entry.PayloadString("backup") != "bk-1" || entry.PayloadString("aside") == "" {
		t.Fatalf("payload lost information: %+v", entry.Payload)
	}
	if err := st.JournalEnd(id, JournalDone, "finished"); err != nil {
		t.Fatal(err)
	}
	if remaining, _ := st.OpenJournals(); len(remaining) != 0 {
		t.Fatalf("expected no open entries, got %d", len(remaining))
	}
	recent, err := st.RecentJournals(10)
	if err != nil || len(recent) != 1 || recent[0].Status != JournalDone {
		t.Fatalf("unexpected journal history: %+v (%v)", recent, err)
	}
}

func TestBackupRecordsAndLastSuccessful(t *testing.T) {
	st, _ := open(t)

	older := BackupRecord{ID: "bk-1", SnapshotID: "aaaa1111", WorldID: "survival", Kind: "manual",
		Status: BackupComplete, CreatedAt: time.Now().Add(-time.Hour)}
	newer := BackupRecord{ID: "bk-2", SnapshotID: "bbbb2222", WorldID: "survival", Kind: "scheduled",
		Status: BackupComplete, CreatedAt: time.Now()}
	failed := BackupRecord{ID: "bk-3", WorldID: "survival", Status: BackupFailed, CreatedAt: time.Now()}
	for _, record := range []BackupRecord{older, newer, failed} {
		if err := st.PutBackup(record); err != nil {
			t.Fatal(err)
		}
	}

	last, ok, err := st.LastSuccessfulBackup()
	if err != nil || !ok {
		t.Fatalf("expected a successful backup, got ok=%v err=%v", ok, err)
	}
	if last.ID != "bk-2" {
		t.Fatalf("expected the newest complete backup, got %s", last.ID)
	}

	// Snapshot ids are also usable as lookup keys, which is what the API accepts.
	found, ok, err := st.GetBackup("bbbb2222")
	if err != nil || !ok || found.ID != "bk-2" {
		t.Fatalf("lookup by snapshot id failed: %+v ok=%v err=%v", found, ok, err)
	}

	if err := st.DeleteBackup("bk-2"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.GetBackup("bk-2"); ok {
		t.Fatal("expected the record to be gone")
	}
}

func TestActiveJobPicksTheLiveOne(t *testing.T) {
	st, _ := open(t)
	records := []JobRecord{
		{ID: "gen-done", WorldID: "w", Profile: "gentle", Status: JobCompleted, CreatedAt: time.Now().Add(-time.Hour)},
		{ID: "gen-live", WorldID: "w", Profile: "gentle", Status: JobPaused, CreatedAt: time.Now()},
	}
	for _, record := range records {
		if err := st.PutJob(record); err != nil {
			t.Fatal(err)
		}
	}
	job, ok, err := st.ActiveJob()
	if err != nil || !ok {
		t.Fatalf("expected an active job, ok=%v err=%v", ok, err)
	}
	if job.ID != "gen-live" {
		t.Fatalf("expected the paused job, got %s", job.ID)
	}
}

func TestSizeAndChunkSampleCaches(t *testing.T) {
	st, _ := open(t)

	if err := st.PutSize("/data/worlds/survival", 1234, 56); err != nil {
		t.Fatal(err)
	}
	record, ok, err := st.GetSize("/data/worlds/survival")
	if err != nil || !ok || record.Bytes != 1234 || record.Files != 56 {
		t.Fatalf("unexpected size record %+v ok=%v err=%v", record, ok, err)
	}
	if err := st.DeleteSize("/data/worlds/survival"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.GetSize("/data/worlds/survival"); ok {
		t.Fatal("expected the size record to be gone")
	}

	sample := ChunkSample{WorldID: "survival", Dimension: "world", BytesPerChunk: 92160, ChunksMeasured: 5000}
	if err := st.PutChunkSample(sample); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetChunkSample("survival", "world")
	if err != nil || !ok || got.BytesPerChunk != 92160 {
		t.Fatalf("unexpected sample %+v ok=%v err=%v", got, ok, err)
	}
	if got.MeasuredAt.IsZero() {
		t.Fatal("expected a measurement timestamp")
	}
}

func TestRedactLeavesNormalTextAlone(t *testing.T) {
	text := "view-distance=7 max-players=10"
	if got := Redact(text); got != text {
		t.Fatalf("redaction changed innocent text: %q", got)
	}
}
