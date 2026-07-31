package presets

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

// assetsDir writes the shipped preset files into a temporary "assets" tree so the
// test exercises the same loading path as the container image.
func assetsDir(t *testing.T, presets ...Preset) string {
	t.Helper()
	dir := t.TempDir()
	presetDir := filepath.Join(dir, "presets")
	if err := os.MkdirAll(presetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, preset := range presets {
		raw, err := json.Marshal(preset)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(presetDir, preset.ID+".json"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }

func newFixture(t *testing.T, builtins ...Preset) (*Manager, *mcconfig.Manager, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	config := mcconfig.NewManager(env.Paths, paper.New(), env.Store, env.Bus, env.Log)
	if err := config.EnsureDefaults("test", nil); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(env.Paths, assetsDir(t, builtins...), config, env.Settings, env.Store, env.Bus, env.Log)
	return manager, config, env
}

func lowPower() Preset {
	return Preset{
		ID: "low-power", Name: "Low Power", Description: "smallest footprint",
		Knobs: map[string]any{
			"view_distance": 5, "simulation_distance": 4, "max_players": 5,
			"spawn_limit_monsters": 30,
		},
		Settings: Settings{
			MemoryMinMB: intPtr(1024), MemoryMaxMB: intPtr(2048),
			JVMFlagsProfile: strPtr("low_power"),
		},
	}
}

func TestListIncludesBuiltInsAndUserPresets(t *testing.T) {
	manager, _, env := newFixture(t, lowPower())

	if _, err := manager.Save(Preset{ID: "mine", Name: "Mine", Knobs: map[string]any{"view_distance": 6}}, "tester"); err != nil {
		t.Fatalf("save: %v", err)
	}
	list, err := manager.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected two presets, got %d", len(list))
	}
	var builtIn, user int
	for _, preset := range list {
		if preset.BuiltIn {
			builtIn++
		} else {
			user++
		}
	}
	if builtIn != 1 || user != 1 {
		t.Fatalf("expected one of each, got %d built-in and %d user", builtIn, user)
	}
	if _, err := os.Stat(filepath.Join(env.Paths.Presets(), "mine.json")); err != nil {
		t.Fatalf("user preset was not written: %v", err)
	}
}

func TestSaveRejectsUnknownKnobsAndUnsafeIDs(t *testing.T) {
	manager, _, _ := newFixture(t)
	if _, err := manager.Save(Preset{ID: "bad", Knobs: map[string]any{"not_a_knob": 1}}, "tester"); err == nil {
		t.Error("expected an unknown setting to be rejected")
	}
	if _, err := manager.Save(Preset{ID: "../escape", Knobs: map[string]any{}}, "tester"); err == nil {
		t.Error("expected an unsafe preset id to be rejected")
	}
}

func TestDiffListsOnlyRealChanges(t *testing.T) {
	manager, config, _ := newFixture(t, lowPower())

	// Match one of the preset values exactly; it must not appear in the diff.
	if _, err := config.SetKnobs(map[string]any{"max_players": 5}, "tester"); err != nil {
		t.Fatal(err)
	}

	diff, err := manager.Diff("low-power")
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if diff.Unchanged == 0 {
		t.Error("expected the matching value to be counted as unchanged")
	}
	for _, change := range diff.Changes {
		if change.Key == "max_players" {
			t.Error("a value that already matches must not be in the diff")
		}
		if change.Current == nil && change.Scope == "knob" && change.Key == "view_distance" {
			t.Error("expected the current value to be reported")
		}
	}
	if !diff.RestartRequired {
		t.Error("view distance changes require a restart, the diff should say so")
	}
	found := map[string]bool{}
	for _, change := range diff.Changes {
		found[change.Key] = true
	}
	for _, key := range []string{"view_distance", "simulation_distance", "memory_max_mb", "jvm_flags_profile"} {
		if !found[key] {
			t.Errorf("expected %s in the diff", key)
		}
	}
}

func TestApplyWritesKnobsAndSettings(t *testing.T) {
	manager, config, env := newFixture(t, lowPower())

	result, err := manager.Apply("low-power", "tester", false)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(result.Applied) == 0 {
		t.Fatal("expected changes to be applied")
	}
	values, err := config.KnobValues()
	if err != nil {
		t.Fatal(err)
	}
	if values["view_distance"] != 5 || values["simulation_distance"] != 4 {
		t.Fatalf("knobs were not written: %+v", values)
	}
	settings := env.Settings.Get()
	if settings.MemoryMaxMB != 2048 || settings.JVMFlagsProfile != "low_power" {
		t.Fatalf("controller settings were not applied: %+v", settings)
	}
	if settings.ActivePreset != "low-power" {
		t.Fatalf("expected the active preset to be recorded, got %q", settings.ActivePreset)
	}

	// Applying again is a no-op.
	second, err := manager.Diff("low-power")
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Changes) != 0 {
		t.Fatalf("expected no further changes, got %d", len(second.Changes))
	}
}

func TestApplyKeepsManualOverridesUnlessAsked(t *testing.T) {
	manager, config, _ := newFixture(t, lowPower())

	// The operator deliberately raises the view distance and the UI records it.
	if _, err := config.SetKnobs(map[string]any{"view_distance": 10}, "tester"); err != nil {
		t.Fatal(err)
	}
	manager.RecordOverrides(map[string]any{"view_distance": 10})

	diff, err := manager.Diff("low-power")
	if err != nil {
		t.Fatal(err)
	}
	if diff.Overrides != 1 {
		t.Fatalf("expected the override to be flagged, got %d", diff.Overrides)
	}

	result, err := manager.Apply("low-power", "tester", false)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(result.Skipped) != 1 || result.Skipped[0].Key != "view_distance" {
		t.Fatalf("expected the manual change to be kept, skipped=%+v", result.Skipped)
	}
	values, _ := config.KnobValues()
	if values["view_distance"] != 10 {
		t.Fatalf("the preset overwrote a manual change: %v", values["view_distance"])
	}
	if values["simulation_distance"] != 4 {
		t.Fatalf("other preset values should still be applied: %v", values["simulation_distance"])
	}

	// Asking explicitly lets the preset win.
	if _, err := manager.Apply("low-power", "tester", true); err != nil {
		t.Fatalf("forced apply: %v", err)
	}
	values, _ = config.KnobValues()
	if values["view_distance"] != 5 {
		t.Fatalf("forced apply did not overwrite the manual change: %v", values["view_distance"])
	}
}

func TestUserPresetShadowsBuiltIn(t *testing.T) {
	manager, _, _ := newFixture(t, lowPower())
	if _, err := manager.Save(Preset{
		ID: "low-power", Name: "My Low Power", Knobs: map[string]any{"view_distance": 3},
	}, "tester"); err != nil {
		t.Fatal(err)
	}
	preset, err := manager.Get("low-power")
	if err != nil {
		t.Fatal(err)
	}
	if preset.BuiltIn || preset.Name != "My Low Power" {
		t.Fatalf("expected the user preset to shadow the built-in one: %+v", preset)
	}
	if err := manager.Delete("low-power", "tester"); err != nil {
		t.Fatal(err)
	}
	preset, err = manager.Get("low-power")
	if err != nil {
		t.Fatal(err)
	}
	if !preset.BuiltIn {
		t.Fatal("deleting the user copy should reveal the built-in preset again")
	}
}

func TestShippedPresetFilesAreValid(t *testing.T) {
	// The presets shipped with the add-on must parse and only reference known
	// settings, otherwise a fresh installation would show broken entries.
	dir := filepath.Join("..", "..", "..", "presets")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("preset directory not available: %v", err)
	}
	catalog := mcconfig.KnobByKey()
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var preset Preset
		if err := json.Unmarshal(raw, &preset); err != nil {
			t.Errorf("%s is not valid JSON: %v", entry.Name(), err)
			continue
		}
		if preset.ID == "" || preset.Name == "" || preset.Description == "" {
			t.Errorf("%s is missing an id, name or description", entry.Name())
		}
		for key := range preset.Knobs {
			if _, ok := catalog[key]; !ok {
				t.Errorf("%s references unknown setting %q", entry.Name(), key)
			}
		}
		count++
	}
	if count < 6 {
		t.Errorf("expected the six documented presets, found %d", count)
	}
}
