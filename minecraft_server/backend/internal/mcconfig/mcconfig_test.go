package mcconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

func newManager(t *testing.T) (*Manager, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	return NewManager(env.Paths, paper.New(), env.Store, env.Bus, env.Log), env
}

func TestPropertiesPreserveCommentsAndOrder(t *testing.T) {
	raw := "#Minecraft server properties\n#Mon Jan 01\nview-distance=10\nmotd=A Server\nmax-players=20\n"
	props := ParseProperties([]byte(raw))

	props.Set("view-distance", "7")
	props.Set("new-key", "value")

	out := string(props.Bytes())
	if !strings.HasPrefix(out, "#Minecraft server properties\n#Mon Jan 01\n") {
		t.Fatalf("comments were not preserved:\n%s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if lines[2] != "view-distance=7" {
		t.Fatalf("expected the changed key to stay in place, got %q", lines[2])
	}
	if lines[len(lines)-1] != "new-key=value" {
		t.Fatalf("expected new keys to be appended, got %q", lines[len(lines)-1])
	}
	if v, _ := props.Get("max-players"); v != "20" {
		t.Fatalf("unrelated key changed: %q", v)
	}
}

func TestPropertiesEscapeRoundTrip(t *testing.T) {
	props := ParseProperties(nil)
	props.Set("motd", "Grüße: Welcome=Home")
	encoded := string(props.Bytes())
	if strings.Contains(encoded, "ü") {
		t.Fatalf("non-ASCII should be escaped for the vanilla loader: %q", encoded)
	}
	reparsed := ParseProperties([]byte(encoded))
	if got, _ := reparsed.Get("motd"); got != "Grüße: Welcome=Home" {
		t.Fatalf("round trip failed, got %q", got)
	}
}

func TestValidateRejectsBrokenFormats(t *testing.T) {
	if err := Validate("properties", []byte("this-line-has-no-separator\n")); err == nil {
		t.Error("expected malformed properties to be rejected")
	}
	if err := Validate("properties", []byte("bad key=1\n")); err == nil {
		t.Error("expected an invalid key to be rejected")
	}
	if err := Validate("yaml", []byte("a:\n  - b\n   c: broken\n")); err == nil {
		t.Error("expected invalid YAML to be rejected")
	}
	if err := Validate("json", []byte("{not json}")); err == nil {
		t.Error("expected invalid JSON to be rejected")
	}
	if err := Validate("json", []byte("[]")); err != nil {
		t.Errorf("valid JSON rejected: %v", err)
	}
	if err := Validate("properties", []byte("# only a comment\n")); err != nil {
		t.Errorf("comment-only file rejected: %v", err)
	}
}

func TestWriteCreatesSnapshotAndRefusesUnknownFiles(t *testing.T) {
	manager, env := newManager(t)

	if _, err := manager.Write("server.properties", "view-distance=7\n", "tester"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	// The first write has nothing to snapshot; the second must snapshot the first.
	result, err := manager.Write("server.properties", "view-distance=5\n", "tester")
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	if result.SnapshotPath == "" {
		t.Fatal("expected a snapshot of the previous content")
	}
	snapshot, err := os.ReadFile(result.SnapshotPath)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if !strings.Contains(string(snapshot), "view-distance=7") {
		t.Fatalf("snapshot has the wrong content: %q", snapshot)
	}
	if !result.RestartRequired {
		t.Error("server.properties changes should report restart_required")
	}

	if _, err := manager.Write("/etc/passwd", "x", "tester"); err == nil {
		t.Error("expected an unknown file to be refused")
	}
	if _, err := manager.Write("../../escape.yml", "x", "tester"); err == nil {
		t.Error("expected a traversal path to be refused")
	}

	entries, err := env.Store.RecentAudit(10, "config.")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 2 {
		t.Fatalf("expected the writes to be audited, got %d entries", len(entries))
	}
}

func TestWriteRejectsInvalidContentWithoutTouchingTheFile(t *testing.T) {
	manager, _ := newManager(t)
	if _, err := manager.Write("bukkit.yml", "spawn-limits:\n  monsters: 50\n", "tester"); err != nil {
		t.Fatalf("valid write: %v", err)
	}
	before, _, err := manager.Read("bukkit.yml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Write("bukkit.yml", "spawn-limits:\n\t- broken: [", "tester"); err == nil {
		t.Fatal("expected invalid YAML to be rejected")
	}
	after, content, err := manager.Read("bukkit.yml")
	if err != nil {
		t.Fatal(err)
	}
	if before.SHA256 != after.SHA256 {
		t.Fatalf("the file changed despite a rejected write: %q", content)
	}
}

func TestUnchangedWriteIsANoOp(t *testing.T) {
	manager, _ := newManager(t)
	if _, err := manager.Write("server.properties", "view-distance=7\n", "tester"); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Write("server.properties", "view-distance=7\n", "tester")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Unchanged {
		t.Fatal("expected an identical write to be reported as unchanged")
	}
	if result.SnapshotPath != "" {
		t.Fatal("an unchanged write must not create a snapshot")
	}
}

func TestSetYAMLPathPreservesComments(t *testing.T) {
	input := []byte("# Paper world defaults\nchunk-loading-basic:\n  # how fast chunks go out\n  player-max-chunk-send-rate: 75.0\n")
	out, err := SetYAMLPath(input, "chunk-loading-basic.player-max-chunk-send-rate", 25)
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, "# Paper world defaults") || !strings.Contains(text, "# how fast chunks go out") {
		t.Fatalf("comments lost:\n%s", text)
	}
	if !strings.Contains(text, "player-max-chunk-send-rate: 25") {
		t.Fatalf("value not written:\n%s", text)
	}

	value, found, err := GetYAMLPath(out, "chunk-loading-basic.player-max-chunk-send-rate")
	if err != nil || !found {
		t.Fatalf("read back: found=%v err=%v", found, err)
	}
	if value != 25 {
		t.Fatalf("expected 25, got %v (%T)", value, value)
	}
}

func TestSetYAMLPathCreatesMissingParents(t *testing.T) {
	out, err := SetYAMLPath([]byte("existing: 1\n"), "chunks.max-auto-save-chunks-per-tick", 12)
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	value, found, err := GetYAMLPath(out, "chunks.max-auto-save-chunks-per-tick")
	if err != nil || !found || value != 12 {
		t.Fatalf("expected 12, got %v found=%v err=%v", value, found, err)
	}
	if value, _, _ := GetYAMLPath(out, "existing"); value != 1 {
		t.Fatalf("existing key was lost: %v", value)
	}
}

func TestSetKnobsWritesEveryFileOnceAndValidatesRanges(t *testing.T) {
	manager, _ := newManager(t)

	results, err := manager.SetKnobs(map[string]any{
		"view_distance":                  6,
		"simulation_distance":            4,
		"spawn_limit_monsters":           40,
		"chunk_send_rate":                20.0,
		"max_concurrent_chunk_generates": 2.0,
	}, "tester")
	if err != nil {
		t.Fatalf("set knobs: %v", err)
	}
	// server.properties, bukkit.yml, paper-world-defaults.yml, paper-global.yml
	if len(results) != 4 {
		t.Fatalf("expected one write per file, got %d", len(results))
	}

	values, err := manager.KnobValues()
	if err != nil {
		t.Fatal(err)
	}
	if values["view_distance"] != 6 {
		t.Fatalf("view_distance not stored: %v", values["view_distance"])
	}
	if values["spawn_limit_monsters"] != 40 {
		t.Fatalf("spawn_limit_monsters not stored: %v", values["spawn_limit_monsters"])
	}

	if _, err := manager.SetKnobs(map[string]any{"view_distance": 99}, "tester"); err == nil {
		t.Error("expected an out-of-range view distance to be rejected")
	}
	if _, err := manager.SetKnobs(map[string]any{"gamemode": "godmode"}, "tester"); err == nil {
		t.Error("expected an invalid enum value to be rejected")
	}
	if _, err := manager.SetKnobs(map[string]any{"nonsense": 1}, "tester"); err == nil {
		t.Error("expected an unknown knob to be rejected")
	}
	if _, err := manager.SetKnobs(map[string]any{"motd": "line\nbreak"}, "tester"); err == nil {
		t.Error("expected a line break in a text value to be rejected")
	}
}

func TestSnapshotsArePrunedAndRestorable(t *testing.T) {
	manager, env := newManager(t)
	for i := 0; i < 3; i++ {
		if _, err := manager.Write("spigot.yml", "world-settings:\n  default:\n    mob-spawn-range: "+string(rune('3'+i))+"\n", "tester"); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	snapshots, err := manager.Snapshots("spigot.yml")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) == 0 {
		t.Fatal("expected snapshots to exist")
	}
	if _, err := manager.RestoreSnapshot("spigot.yml", snapshots[len(snapshots)-1], "tester"); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}
	if _, err := manager.RestoreSnapshot("spigot.yml", "../../../etc/passwd", "tester"); err == nil {
		t.Error("expected a traversal snapshot name to be refused")
	}
	if _, err := os.Stat(filepath.Join(env.Paths.ConfigSnapshots())); err != nil {
		t.Fatalf("snapshot directory missing: %v", err)
	}
}

func TestEnsureDefaultsOnlyFillsMissingKeys(t *testing.T) {
	manager, _ := newManager(t)
	if _, err := manager.Write("server.properties", "view-distance=3\n", "tester"); err != nil {
		t.Fatal(err)
	}
	if err := manager.EnsureDefaults("controller", nil); err != nil {
		t.Fatalf("defaults: %v", err)
	}
	props, err := manager.Properties()
	if err != nil {
		t.Fatal(err)
	}
	if got := props.GetOr("view-distance", ""); got != "3" {
		t.Fatalf("defaults overwrote an existing value: %q", got)
	}
	if got := props.GetOr("difficulty", ""); got == "" {
		t.Fatal("defaults did not add missing keys")
	}
}
