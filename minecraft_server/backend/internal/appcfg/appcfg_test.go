package appcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfineRejectsEscapes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")

	valid := map[string]string{
		"server.properties":        "server.properties",
		"config/paper-global.yml":  filepath.Join("config", "paper-global.yml"),
		"plugins/Chunky.jar":       filepath.Join("plugins", "Chunky.jar"),
	}
	for input, expected := range valid {
		got, err := Confine(root, input)
		if err != nil {
			t.Errorf("Confine(%q) failed: %v", input, err)
			continue
		}
		if got != filepath.Join(root, expected) {
			t.Errorf("Confine(%q) = %q", input, got)
		}
	}

	invalid := []string{
		"", "..", "../escape", "config/../../escape", "/etc/passwd",
		"C:\\Windows\\System32", "..\\escape", "with\x00nul",
	}
	for _, input := range invalid {
		if _, err := Confine(root, input); err == nil {
			t.Errorf("Confine(%q) should have been rejected", input)
		}
	}
}

func TestSettingsValidation(t *testing.T) {
	base := defaultSettings(DefaultOptions())
	if err := base.Validate(); err != nil {
		t.Fatalf("defaults are invalid: %v", err)
	}

	cases := map[string]func(*Settings){
		"tiny heap":                  func(s *Settings) { s.MemoryMinMB = 128 },
		"inverted heap":              func(s *Settings) { s.MemoryMaxMB = s.MemoryMinMB - 1 },
		"short stop timeout":         func(s *Settings) { s.StopTimeoutSeconds = 5 },
		"negative idle":              func(s *Settings) { s.IdleShutdownMinutes = -1 },
		"bad restart schedule":       func(s *Settings) { s.RestartSchedule = "4:30 pm" },
		"bad backup schedule":        func(s *Settings) { s.BackupSchedule = "99:99" },
		"bad allowed hours":          func(s *Settings) { s.Generation.AllowedHours.Start = "midnight" },
		"resume below pause TPS":     func(s *Settings) { s.Generation.ResumeWhen.TPSAbove = 10 },
		"resume above pause temp":    func(s *Settings) { s.Generation.ResumeWhen.CPUTemperatureBelowC = 95 },
		"negative safety margin":     func(s *Settings) { s.Generation.SafetyMarginBlocks = -1 },
		"invalid custom java flags":  func(s *Settings) { s.JVMFlagsProfile = "custom"; s.JVMFlagsCustom = "-Xmx8G" },
	}
	for name, mutate := range cases {
		settings := base
		mutate(&settings)
		if err := settings.Validate(); err == nil {
			t.Errorf("%s should have been rejected", name)
		}
	}
}

func TestSettingsStorePersistsAtomicallyAndRejectsInvalidUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "settings.json")
	store, err := LoadSettings(path, DefaultOptions())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected the file to be created: %v", err)
	}

	if _, err := store.Update(func(s *Settings) { s.MemoryMaxMB = 2048 }); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := store.Update(func(s *Settings) { s.MemoryMinMB = 10 }); err == nil {
		t.Fatal("expected an invalid update to be rejected")
	}
	if got := store.Get().MemoryMaxMB; got != 2048 {
		t.Fatalf("a rejected update changed state: %d", got)
	}

	// The stored file must contain the accepted value only.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored Settings
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("stored file is not valid JSON: %v", err)
	}
	if stored.MemoryMaxMB != 2048 || stored.MemoryMinMB != DefaultOptions().MemoryMinMB {
		t.Fatalf("unexpected stored settings: %+v", stored)
	}

	// Reloading picks up defaults for fields a previous version did not know.
	if err := os.WriteFile(path, []byte(`{"memory_max_mb":3072}`), 0o644); err != nil {
		t.Fatal(err)
	}
	reloaded, err := LoadSettings(path, DefaultOptions())
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	settings := reloaded.Get()
	if settings.MemoryMaxMB != 3072 {
		t.Fatalf("stored value lost: %d", settings.MemoryMaxMB)
	}
	if settings.StopTimeoutSeconds == 0 || settings.Generation.PauseWhen.TPSBelow == 0 {
		t.Fatalf("missing fields were not defaulted: %+v", settings)
	}
	if settings.PresetOverrides == nil {
		t.Fatal("expected the override map to be initialised")
	}
}

func TestSettingsClonesOverridesDeeply(t *testing.T) {
	store, err := LoadSettings(filepath.Join(t.TempDir(), "settings.json"), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(func(s *Settings) {
		s.PresetOverrides["knobs"] = map[string]string{"view_distance": "10"}
	}); err != nil {
		t.Fatal(err)
	}
	snapshot := store.Get()
	snapshot.PresetOverrides["knobs"]["view_distance"] = "3"
	if got := store.Get().PresetOverrides["knobs"]["view_distance"]; got != "10" {
		t.Fatalf("mutating a snapshot changed the store: %q", got)
	}
}

func TestWithinWindowHandlesMidnight(t *testing.T) {
	day := time.Date(2026, 7, 30, 0, 0, 0, 0, time.Local)
	at := func(hour, minute int) time.Time {
		return day.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute)
	}

	// A normal window.
	if !WithinWindow(at(1, 0), "00:30", "06:00") {
		t.Error("01:00 should be inside 00:30-06:00")
	}
	if WithinWindow(at(7, 0), "00:30", "06:00") {
		t.Error("07:00 should be outside 00:30-06:00")
	}
	// A window that wraps past midnight.
	if !WithinWindow(at(23, 30), "23:00", "02:00") {
		t.Error("23:30 should be inside 23:00-02:00")
	}
	if !WithinWindow(at(1, 0), "23:00", "02:00") {
		t.Error("01:00 should be inside 23:00-02:00")
	}
	if WithinWindow(at(12, 0), "23:00", "02:00") {
		t.Error("12:00 should be outside 23:00-02:00")
	}
	// Equal start and end means "always", and an unparseable window never blocks.
	if !WithinWindow(at(12, 0), "03:00", "03:00") {
		t.Error("an empty window should not block")
	}
	if !WithinWindow(at(12, 0), "nonsense", "06:00") {
		t.Error("an invalid window should not block")
	}
}

func TestOptionsValidation(t *testing.T) {
	opts := DefaultOptions()
	if err := opts.Validate(); err != nil {
		t.Fatalf("defaults invalid: %v", err)
	}

	bad := opts
	bad.MemoryMaxMB = 512
	bad.MemoryMinMB = 1024
	if err := bad.Validate(); err == nil {
		t.Error("expected inverted heap sizes to be rejected")
	}

	bad = opts
	bad.ChunkySource = "url"
	if err := bad.Validate(); err == nil {
		t.Error("chunky_source=url without a URL and checksum must be rejected")
	}
	bad.ChunkyDownloadURL = "https://example.invalid/chunky.jar"
	bad.ChunkySHA256 = strings.Repeat("a", 64)
	if err := bad.Validate(); err != nil {
		t.Errorf("a complete url source was rejected: %v", err)
	}

	bad = opts
	bad.ChunkySource = "somewhere-else"
	if err := bad.Validate(); err == nil {
		t.Error("expected an unknown chunky source to be rejected")
	}
}

func TestLoadOptionsMissingFileUsesDefaults(t *testing.T) {
	opts, err := LoadOptions(filepath.Join(t.TempDir(), "options.json"))
	if err != nil {
		t.Fatalf("expected a missing options file to be tolerated: %v", err)
	}
	if opts.ServerPort != DefaultOptions().ServerPort {
		t.Fatalf("expected defaults, got %+v", opts)
	}
}

func TestLoadOptionsAppliesFileValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "options.json")
	if err := os.WriteFile(path, []byte(`{"memory_max_mb":2048,"jvm_flags_profile":"low_power"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	opts, err := LoadOptions(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if opts.MemoryMaxMB != 2048 || opts.JVMFlagsProfile != "low_power" {
		t.Fatalf("unexpected options %+v", opts)
	}
	// Values not present in the file keep their defaults.
	if opts.StopTimeoutSeconds != DefaultOptions().StopTimeoutSeconds {
		t.Fatalf("expected the default stop timeout, got %d", opts.StopTimeoutSeconds)
	}
}

func TestEnsureLayoutCreatesPrivateDirectories(t *testing.T) {
	paths := NewPaths(t.TempDir())
	if err := paths.EnsureLayout(); err != nil {
		t.Fatalf("layout: %v", err)
	}
	for _, dir := range []string{paths.Runtime(), paths.Worlds(), paths.Backups(), paths.Staging(),
		paths.Presets(), paths.Config(), paths.Trash(), paths.Jars(), paths.Audit()} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("%s was not created: %v", dir, err)
		}
	}
	// Secrets and the runtime socket directory must not be world readable.
	for _, dir := range []string{paths.Secrets(), paths.Run()} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("%s missing: %v", dir, err)
		}
		if runtimeIsPOSIX() && info.Mode().Perm() != 0o700 {
			t.Errorf("%s has mode %v, want 0700", dir, info.Mode().Perm())
		}
	}
	// Running it twice must be harmless.
	if err := paths.EnsureLayout(); err != nil {
		t.Fatalf("second layout call failed: %v", err)
	}
}

func runtimeIsPOSIX() bool { return os.PathSeparator == '/' }
