package appcfg

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathsAreNestedPerFlavour(t *testing.T) {
	paths := NewPaths(t.TempDir())
	if paths.Flavour() != DefaultFlavour {
		t.Fatalf("a fresh layout starts on %s, got %s", DefaultFlavour, paths.Flavour())
	}
	paperRuntime, paperWorlds, paperJar := paths.Runtime(), paths.Worlds(), paths.ServerJar()

	// A copy taken before the switch must follow it: every manager is handed a
	// copy of Paths at construction time.
	copied := paths
	paths.SetFlavour("bta", "bta.jar")

	if copied.Flavour() != "bta" {
		t.Fatal("a copy of Paths must see the switch")
	}
	if copied.Runtime() == paperRuntime || copied.Worlds() == paperWorlds {
		t.Fatal("the runtime and world directories must differ per flavour")
	}
	if filepath.Base(copied.ServerJar()) != "bta.jar" {
		t.Fatalf("the JAR name must follow the flavour, got %s", copied.ServerJar())
	}
	if filepath.Base(paperJar) != "paper.jar" {
		t.Fatalf("unexpected paper JAR name %s", paperJar)
	}
	if copied.Backups() != paths.Backups() {
		t.Fatal("the backup repository is shared; only its snapshots are tagged")
	}
}

func TestMigrateLayoutMovesExistingWorldsUnderPaper(t *testing.T) {
	data := t.TempDir()
	paths := NewPaths(data)

	// The pre-flavour layout: worlds directly below /data/worlds.
	for _, world := range []string{"survival", "creative"} {
		if err := os.MkdirAll(filepath.Join(data, "worlds", world, "world"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	marker := filepath.Join(data, "worlds", "survival", "world", "level.dat")
	if err := os.WriteFile(marker, []byte("nbt"), 0o644); err != nil {
		t.Fatal(err)
	}

	moved, err := paths.MigrateLayout()
	if err != nil {
		t.Fatal(err)
	}
	if !moved {
		t.Fatal("expected the worlds to be moved")
	}
	if _, err := os.Stat(filepath.Join(data, "worlds", "paper", "survival", "world", "level.dat")); err != nil {
		t.Fatalf("the world data did not survive the move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "worlds", "creative")); !os.IsNotExist(err) {
		t.Fatal("the old location should be gone")
	}

	// Running it again must do nothing, including on an installation that then
	// creates a world whose name happens to be another flavour's.
	moved, err = paths.MigrateLayout()
	if err != nil {
		t.Fatal(err)
	}
	if moved {
		t.Fatal("the migration must only run once")
	}
	if err := os.MkdirAll(filepath.Join(data, "worlds", "bta", "survival"), 0o755); err != nil {
		t.Fatal(err)
	}
	moved, err = paths.MigrateLayout()
	if err != nil || moved {
		t.Fatalf("a later flavour directory must not be migrated: moved=%v err=%v", moved, err)
	}
	if _, err := os.Stat(filepath.Join(data, "worlds", "bta", "survival")); err != nil {
		t.Fatalf("the bta worlds were moved away: %v", err)
	}
}

func TestMigrateLayoutOnAFreshInstallJustWritesTheMarker(t *testing.T) {
	paths := NewPaths(t.TempDir())
	moved, err := paths.MigrateLayout()
	if err != nil {
		t.Fatal(err)
	}
	if moved {
		t.Fatal("there is nothing to move on a fresh installation")
	}
	if err := paths.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Worlds()); err != nil {
		t.Fatalf("the flavour world directory should exist: %v", err)
	}
}

func TestSwitchFlavourParksAndRestoresPerFlavourState(t *testing.T) {
	dir := t.TempDir()
	store, err := LoadSettings(filepath.Join(dir, "settings.json"), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(func(s *Settings) {
		s.ActiveWorld = "survival"
		s.PaperVersion = "1.21.4"
		s.PaperBuild = 232
		s.EULAAccepted = true
	}); err != nil {
		t.Fatal(err)
	}

	after, err := store.SwitchFlavour("bta")
	if err != nil {
		t.Fatal(err)
	}
	if after.Flavour != "bta" {
		t.Fatalf("expected bta, got %q", after.Flavour)
	}
	// The new flavour starts empty: it has its own worlds and its own server.
	if after.ActiveWorld != "" || after.PaperVersion != "" || after.EULAAccepted {
		t.Fatalf("the new flavour should start clean: %+v", after)
	}

	if _, err := store.Update(func(s *Settings) {
		s.ActiveWorld = "beta-world"
		s.PaperVersion = "7.3_04"
	}); err != nil {
		t.Fatal(err)
	}

	back, err := store.SwitchFlavour(DefaultFlavour)
	if err != nil {
		t.Fatal(err)
	}
	if back.ActiveWorld != "survival" || back.PaperVersion != "1.21.4" || back.PaperBuild != 232 || !back.EULAAccepted {
		t.Fatalf("switching back must restore what was parked: %+v", back)
	}
	if parked := back.PerFlavour["bta"]; parked.ActiveWorld != "beta-world" || parked.ServerVersion != "7.3_04" {
		t.Fatalf("the other flavour's state was lost: %+v", parked)
	}

	// Reloading from disk keeps it.
	reloaded, err := LoadSettings(filepath.Join(dir, "settings.json"), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Get().PerFlavour["bta"].ActiveWorld; got != "beta-world" {
		t.Fatalf("per-flavour state did not survive a reload, got %q", got)
	}
}

func TestSettingsLoadedBeforeFlavoursExistedDefaultToPaper(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	// A settings file written by an older add-on version has no flavour field.
	if err := os.WriteFile(path, []byte(`{"memory_min_mb":1024,"memory_max_mb":3072,"active_world":"survival"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := LoadSettings(path, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	settings := store.Get()
	if settings.Flavour != DefaultFlavour {
		t.Fatalf("expected the default flavour, got %q", settings.Flavour)
	}
	if settings.ActiveWorld != "survival" {
		t.Fatal("the existing settings must be preserved")
	}
	if settings.IncludePreReleases {
		t.Fatal("pre-releases must stay off unless enabled")
	}
}
