package worlds

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

type fixture struct {
	env      *testsupport.Env
	manager  *Manager
	sup      *supervisor.Supervisor
	config   *mcconfig.Manager
	backups  *int
	failNext *bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	env := testsupport.NewEnv(t)
	env.AcceptEULA()
	env.WriteFakeJar()
	backend := paper.New()
	config := mcconfig.NewManager(env.Paths, backend, env.Store, env.Bus, env.Log)

	fake := testsupport.FakeBinary(t, "fakepaper")
	t.Setenv("FAKEPAPER_MODE", "ready")

	var manager *Manager
	sup := supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: backend, Log: env.Log, JavaBin: fake, ServerPort: 25599,
		Flags: paper.FlagProfile, ReadyTimeout: 8 * time.Second,
		ExtraEnv: func() []string { return []string{"FAKEPAPER_MODE=" + os.Getenv("FAKEPAPER_MODE")} },
		ExtraArgs: func() []string {
			if manager == nil {
				return nil
			}
			return manager.ContainerArgs()
		},
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = sup.Shutdown(ctx)
	})

	backupCount := 0
	failBackup := false
	manager = NewManager(Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Supervisor: sup, Config: config, Log: env.Log, StartTimeout: 6 * time.Second,
		Backend: backend,
		Backup: func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error {
			if failBackup {
				return errors.New("simulated backup failure")
			}
			backupCount++
			return nil
		},
	})
	return &fixture{env: env, manager: manager, sup: sup, config: config,
		backups: &backupCount, failNext: &failBackup}
}

func TestCreateCloneAndRenameWorlds(t *testing.T) {
	f := newFixture(t)

	info, err := f.manager.Create(CreateRequest{Name: "My Survival", Seed: "12345"}, "tester")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if info.ID != "my-survival" {
		t.Fatalf("expected a normalised id, got %q", info.ID)
	}
	if _, err := f.manager.Create(CreateRequest{Name: "My Survival"}, "tester"); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}

	// Give the clone something to copy.
	writeWorldData(t, filepath.Join(f.env.Paths.World("my-survival"), "world"))

	clone, err := f.manager.Clone("my-survival", "copy", "tester")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if _, err := os.Stat(filepath.Join(clone.Path, "world", "level.dat")); err != nil {
		t.Fatalf("clone is missing world data: %v", err)
	}
	if clone.Seed != "12345" {
		t.Fatalf("expected the seed to be carried over, got %q", clone.Seed)
	}

	renamed, err := f.manager.Rename("copy", "Second world", "tester")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Name != "Second world" || renamed.ID != "copy" {
		t.Fatalf("rename should change the display name only: %+v", renamed)
	}
}

func TestImportRejectsUnsafeArchives(t *testing.T) {
	f := newFixture(t)

	cases := []struct {
		name    string
		entries map[string]string
	}{
		{"traversal", map[string]string{"../../escape/level.dat": "x"}},
		{"absolute", map[string]string{"/etc/passwd": "x"}},
		{"windows-traversal", map[string]string{"..\\..\\escape.dat": "x"}},
		{"no-world-data", map[string]string{"readme.txt": "not a world"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			archive := writeZip(t, tc.entries)
			_, err := f.manager.ImportZip(archive, "imported-"+tc.name, "tester")
			if err == nil {
				t.Fatal("expected the import to be rejected")
			}
			if _, statErr := os.Stat(f.env.Paths.World("imported-" + tc.name)); statErr == nil {
				t.Fatal("a rejected import must not leave a world behind")
			}
			// Nothing may have escaped into the data root either.
			if _, statErr := os.Stat(filepath.Join(f.env.Paths.Data, "escape")); statErr == nil {
				t.Fatal("archive escaped the staging directory")
			}
		})
	}
}

func TestImportRejectsSymlinkEntries(t *testing.T) {
	f := newFixture(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	header := &zip.FileHeader{Name: "world/level.dat"}
	header.SetMode(0o644)
	w, err := zw.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("level"))

	linkHeader := &zip.FileHeader{Name: "world/link"}
	linkHeader.SetMode(os.ModeSymlink | 0o777)
	lw, err := zw.CreateHeader(linkHeader)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = lw.Write([]byte("/etc/passwd"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(t.TempDir(), "link.zip")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.ImportZip(path, "linky", "tester"); !errors.Is(err, ErrUnsafeArchive) {
		t.Fatalf("expected ErrUnsafeArchive, got %v", err)
	}
}

func TestImportNormalisesDimensionLayout(t *testing.T) {
	f := newFixture(t)
	archive := writeZip(t, map[string]string{
		"myserver/world/level.dat":         "overworld",
		"myserver/world/region/r.0.0.mca":  "chunks",
		"myserver/world_nether/level.dat":  "nether",
		"myserver/world_the_end/level.dat": "end",
		"myserver/server.properties":       "view-distance=7",
	})
	result, err := f.manager.ImportZip(archive, "Imported World", "tester")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if result.WorldID != "imported-world" {
		t.Fatalf("unexpected world id %q", result.WorldID)
	}
	for _, dim := range Dimensions {
		if _, err := os.Stat(filepath.Join(f.env.Paths.World(result.WorldID), dim, "level.dat")); err != nil {
			t.Errorf("dimension %s missing: %v", dim, err)
		}
	}
	if err := f.manager.Validate(result.WorldID); err != nil {
		t.Fatalf("imported world did not validate: %v", err)
	}
}

func TestExportProducesAReadableArchive(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.Create(CreateRequest{Name: "exportme"}, "tester"); err != nil {
		t.Fatal(err)
	}
	writeWorldData(t, filepath.Join(f.env.Paths.World("exportme"), "world"))

	var buf bytes.Buffer
	if err := f.manager.ExportZip("exportme", &buf, "tester"); err != nil {
		t.Fatalf("export: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("archive is not readable: %v", err)
	}
	found := false
	for _, entry := range reader.File {
		if entry.Name == "world/level.dat" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected world/level.dat in the archive")
	}
}

func TestDeleteMovesToTrashAndPurgeNeedsTheTrashName(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.Create(CreateRequest{Name: "doomed"}, "tester"); err != nil {
		t.Fatal(err)
	}
	writeWorldData(t, filepath.Join(f.env.Paths.World("doomed"), "world"))

	trashName, err := f.manager.Delete("doomed", "tester")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(f.env.Paths.World("doomed")); !os.IsNotExist(err) {
		t.Fatal("the world directory should have moved")
	}
	entries, err := f.manager.Trash()
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one trash entry, got %d (%v)", len(entries), err)
	}

	// Restoring brings it back with its data.
	restored, err := f.manager.RestoreTrash(trashName, "tester")
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, err := os.Stat(filepath.Join(restored.Path, "world", "level.dat")); err != nil {
		t.Fatalf("restored world lost its data: %v", err)
	}

	trashName, err = f.manager.Delete(restored.ID, "tester")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.manager.PurgeTrash("../secrets", "tester"); err == nil {
		t.Error("expected a traversal trash name to be refused")
	}
	if err := f.manager.PurgeTrash(trashName, "tester"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if entries, _ := f.manager.Trash(); len(entries) != 0 {
		t.Fatal("expected the trash to be empty")
	}
}

func TestActiveWorldCannotBeDeletedWhileRunning(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.EnsureActive(); err != nil {
		t.Fatal(err)
	}
	active := f.env.Settings.Get().ActiveWorld

	if err := f.sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := f.sup.WaitReady(ctx); err != nil {
		t.Fatalf("wait ready: %v", err)
	}

	if _, err := f.manager.Delete(active, "tester"); !errors.Is(err, ErrActiveRunning) {
		t.Fatalf("expected ErrActiveRunning, got %v", err)
	}
}

func TestActivateRollsBackWhenTheNewWorldDoesNotStart(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.Create(CreateRequest{Name: "first"}, "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Create(CreateRequest{Name: "second"}, "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.env.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = "first" }); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}
	if err := f.sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := f.sup.WaitReady(ctx); err != nil {
		t.Fatalf("wait ready: %v", err)
	}

	// The next launch never reports "Done", so the switch must roll back.
	t.Setenv("FAKEPAPER_MODE", "no_ready")

	switchCtx, cancelSwitch := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancelSwitch()
	result, err := f.manager.Activate(switchCtx, ActivateRequest{WorldID: "second", Backup: true}, "tester")
	if err == nil {
		t.Fatal("expected the world switch to fail")
	}
	if !result.RolledBack {
		t.Fatalf("expected a rollback, got %+v (%v)", result, err)
	}
	if active := f.env.Settings.Get().ActiveWorld; active != "first" {
		t.Fatalf("expected the previous world to be active again, got %q", active)
	}
	if *f.backups == 0 {
		t.Error("expected a safety backup before the switch")
	}
}

func TestActivateAbortsWhenTheSafetyBackupFails(t *testing.T) {
	f := newFixture(t)
	for _, name := range []string{"alpha", "beta"} {
		if _, err := f.manager.Create(CreateRequest{Name: name}, "tester"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.env.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = "alpha" }); err != nil {
		t.Fatal(err)
	}
	*f.failNext = true

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := f.manager.Activate(ctx, ActivateRequest{WorldID: "beta", Backup: true}, "tester"); err == nil {
		t.Fatal("expected the switch to abort when the backup fails")
	}
	if active := f.env.Settings.Get().ActiveWorld; active != "alpha" {
		t.Fatalf("the active world changed despite the failure: %q", active)
	}
}

func TestContainerArgsPointAtTheActiveWorld(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.Create(CreateRequest{Name: "args"}, "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.env.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = "args" }); err != nil {
		t.Fatal(err)
	}
	args := f.manager.ContainerArgs()
	if len(args) != 2 || args[0] != "--world-container" {
		t.Fatalf("unexpected arguments %v", args)
	}
	if filepath.Base(args[1]) != "args" {
		t.Fatalf("expected the world directory, got %q", args[1])
	}
}

func TestPrepareRuntimeAppliesTheSeedOnlyForFreshWorlds(t *testing.T) {
	f := newFixture(t)
	if _, err := f.manager.Create(CreateRequest{Name: "seeded", Seed: "424242"}, "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.env.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = "seeded" }); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.PrepareRuntime(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	props, err := f.config.Properties()
	if err != nil {
		t.Fatal(err)
	}
	if got := props.GetOr("level-seed", ""); got != "424242" {
		t.Fatalf("expected the seed to be applied, got %q", got)
	}
	if got := props.GetOr("level-name", ""); got != "world" {
		t.Fatalf("expected level-name to stay 'world', got %q", got)
	}

	// Once the world exists, level.dat owns the seed and the property is left alone.
	writeWorldData(t, filepath.Join(f.env.Paths.World("seeded"), "world"))
	if _, err := f.config.SetProperties(map[string]string{"level-seed": "999"}, "tester"); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}
	props, _ = f.config.Properties()
	if got := props.GetOr("level-seed", ""); got != "999" {
		t.Fatalf("the seed of an existing world was overwritten: %q", got)
	}
}

func TestTrimTimestamp(t *testing.T) {
	if got := trimTimestamp("survival-20260730T120000"); got != "survival" {
		t.Fatalf("got %q", got)
	}
	if got := trimTimestamp("survival"); got != "survival" {
		t.Fatalf("got %q", got)
	}
}

func writeWorldData(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "region"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "level.dat"), []byte("level"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "region", "r.0.0.mca"), bytes.Repeat([]byte("c"), 4096), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = runtime.GOOS
	return path
}
