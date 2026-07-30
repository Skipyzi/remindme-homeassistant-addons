package paper

import (
	"strings"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
)

func TestArgvOrderAndHeapFlags(t *testing.T) {
	backend := New()
	argv, err := backend.Argv(adapter.LaunchContext{
		JavaBin: "/usr/bin/java", JarPath: "/data/runtime/paper/paper.jar",
		HeapMinMB: 1024, HeapMaxMB: 3072, Flags: []string{"-XX:+UseG1GC"},
		ServerPort: 25565, Nogui: true,
	})
	if err != nil {
		t.Fatalf("argv: %v", err)
	}
	joined := strings.Join(argv, " ")
	if argv[0] != "/usr/bin/java" {
		t.Fatalf("expected java first, got %q", argv[0])
	}
	if !strings.Contains(joined, "-Xms1024M") || !strings.Contains(joined, "-Xmx3072M") {
		t.Fatalf("heap flags missing: %s", joined)
	}
	jarIndex := indexOf(argv, "-jar")
	gcIndex := indexOf(argv, "-XX:+UseG1GC")
	if gcIndex < 0 || jarIndex < 0 || gcIndex > jarIndex {
		t.Fatalf("JVM flags must come before -jar: %s", joined)
	}
	if argv[jarIndex+1] != "/data/runtime/paper/paper.jar" {
		t.Fatalf("expected the jar path after -jar, got %q", argv[jarIndex+1])
	}
	if !strings.Contains(joined, "--nogui") || !strings.Contains(joined, "--port 25565") {
		t.Fatalf("paper arguments missing: %s", joined)
	}
}

func TestArgvRejectsIncompleteContext(t *testing.T) {
	backend := New()
	cases := []adapter.LaunchContext{
		{JarPath: "x", HeapMinMB: 1, HeapMaxMB: 2},
		{JavaBin: "java", HeapMinMB: 1, HeapMaxMB: 2},
		{JavaBin: "java", JarPath: "x", HeapMinMB: 0, HeapMaxMB: 1024},
		{JavaBin: "java", JarPath: "x", HeapMinMB: 2048, HeapMaxMB: 1024},
	}
	for i, ctx := range cases {
		if _, err := backend.Argv(ctx); err == nil {
			t.Errorf("case %d should have failed", i)
		}
	}
}

func TestFlagProfiles(t *testing.T) {
	for _, profile := range []string{"low_power", "balanced", "performance"} {
		flags, err := FlagProfile(profile, 3072)
		if err != nil {
			t.Fatalf("%s: %v", profile, err)
		}
		joined := strings.Join(flags, " ")
		if !strings.Contains(joined, "-XX:+UseG1GC") {
			t.Errorf("%s should use G1: %s", profile, joined)
		}
		for _, forbidden := range []string{"-Xmx", "-Xms", "using.aikars.flags"} {
			if strings.Contains(joined, forbidden) {
				t.Errorf("%s must not contain %s: %s", profile, forbidden, joined)
			}
		}
	}
	// AlwaysPreTouch commits the whole heap up front, which is only wanted in the
	// performance profile on a shared Raspberry Pi.
	balanced, _ := FlagProfile("balanced", 3072)
	if strings.Contains(strings.Join(balanced, " "), "AlwaysPreTouch") {
		t.Error("balanced should not pre-touch the heap")
	}
	performance, _ := FlagProfile("performance", 3072)
	if !strings.Contains(strings.Join(performance, " "), "AlwaysPreTouch") {
		t.Error("performance should pre-touch the heap")
	}
	// Region size scales with the heap so a small heap still gets many regions.
	small, _ := FlagProfile("balanced", 1536)
	if !strings.Contains(strings.Join(small, " "), "G1HeapRegionSize=2M") {
		t.Errorf("expected a small region size for a 1.5 GB heap: %v", small)
	}
	if _, err := FlagProfile("turbo", 3072); err == nil {
		t.Error("expected an unknown profile to be rejected")
	}
	if flags, err := FlagProfile("custom", 3072); err != nil || flags != nil {
		t.Errorf("custom should defer to the user's flags, got %v (%v)", flags, err)
	}
}

func TestParseRecognisesLifecycleLines(t *testing.T) {
	backend := New()
	cases := []struct {
		line string
		kind adapter.LogKind
	}{
		{`[12:00:00 INFO]: Done (23.456s)! For help, type "help"`, adapter.KindReady},
		{`[12:00:00 INFO]: Stopping the server`, adapter.KindStopping},
		{`[12:00:00 INFO]: Alex joined the game`, adapter.KindPlayerJoin},
		{`[12:00:00 INFO]: Alex left the game`, adapter.KindPlayerLeave},
		{`[12:00:00 INFO]: Starting minecraft server version 1.21.4`, adapter.KindVersion},
		{`[12:00:00 INFO]: This server is running Paper version 1.21.4-100-main@abc (MC: 1.21.4)`, adapter.KindVersion},
		{`[12:00:00 ERROR]: You need to agree to the EULA in order to run the server.`, adapter.KindEULARequired},
		{`[12:00:00 WARN]: **** FAILED TO BIND TO PORT!`, adapter.KindPortUnavailable},
		{`java.lang.OutOfMemoryError: Java heap space`, adapter.KindOutOfMemory},
		{`[12:00:00 INFO]: Saved the game`, adapter.KindSaved},
		{`[12:00:00 INFO]: Automatic saving is now disabled`, adapter.KindSaveDisabled},
		{`[12:00:00 INFO]: Automatic saving is now enabled`, adapter.KindSaveEnabled},
		{`[12:00:00 INFO]: Unknown command: chunky`, adapter.KindGenNotInstalled},
		{`[12:00:00 INFO]: Some ordinary chat line`, adapter.KindOther},
	}
	for _, tc := range cases {
		got := backend.Parse(tc.line)
		if got.Kind != tc.kind {
			t.Errorf("%q parsed as %s, want %s", tc.line, got.Kind, tc.kind)
		}
	}

	if player := backend.Parse(`[12:00:00 INFO]: Steve_99 joined the game`).Player; player != "Steve_99" {
		t.Errorf("expected the player name, got %q", player)
	}
	if version := backend.Parse(`[12:00:00 INFO]: Starting minecraft server version 1.20.6`).Version; version != "1.20.6" {
		t.Errorf("expected the version, got %q", version)
	}
}

func TestParseChunkyProgress(t *testing.T) {
	backend := New()
	event := backend.Parse(`[12:00:00 INFO]: [Chunky] [world] Task running: 1250/10000 chunks (12.50%), 42.5 cps, ETA: 00:03:45`)
	if event.Kind != adapter.KindGenProgress {
		t.Fatalf("expected progress, got %s", event.Kind)
	}
	if event.Percent != 12.5 {
		t.Errorf("percent = %v", event.Percent)
	}
	if event.ChunksDone != 1250 || event.ChunksTotal != 10000 {
		t.Errorf("chunks = %d/%d", event.ChunksDone, event.ChunksTotal)
	}
	if event.Rate != 42.5 {
		t.Errorf("rate = %v", event.Rate)
	}
	if event.ETASeconds != 3*60+45 {
		t.Errorf("eta = %d", event.ETASeconds)
	}
	if event.World != "world" {
		t.Errorf("world = %q", event.World)
	}

	if kind := backend.Parse(`[12:00:00 INFO]: [Chunky] [world_nether] Task finished for world_nether`).Kind; kind != adapter.KindGenTaskDone {
		t.Errorf("expected a completion event, got %s", kind)
	}
	if kind := backend.Parse(`[12:00:00 INFO]: [Chunky] Task cancelled`).Kind; kind != adapter.KindGenTaskCancelled {
		t.Errorf("expected a cancellation event, got %s", kind)
	}
	// A different Chunky release phrases progress differently; the parser must
	// still find the numbers it needs.
	alternative := backend.Parse(`[12:00:00 INFO]: [Chunky] world: 55.00% complete, 3000/6000 chunks, 30 cps`)
	if alternative.Percent != 55 || alternative.ChunksTotal != 6000 || alternative.Rate != 30 {
		t.Errorf("tolerant parsing failed: %+v", alternative)
	}
}

func TestGenerationCommands(t *testing.T) {
	backend := New()
	configure := backend.GenerationCommands(adapter.GenerationAction{
		Verb: "configure", World: "world_nether", Shape: "circle", Radius: 2000, CenterX: 10, CenterZ: -20,
	})
	joined := strings.Join(configure, "; ")
	for _, expected := range []string{"chunky world world_nether", "chunky center 10 -20", "chunky shape circle", "chunky radius 2000"} {
		if !strings.Contains(joined, expected) {
			t.Errorf("expected %q in %q", expected, joined)
		}
	}
	// An unknown shape falls back to a safe default rather than passing junk on.
	fallback := backend.GenerationCommands(adapter.GenerationAction{Verb: "configure", Shape: "banana", Radius: 10})
	if !strings.Contains(strings.Join(fallback, " "), "chunky shape square") {
		t.Errorf("expected the default shape, got %v", fallback)
	}
	for verb, expected := range map[string]string{
		"start": "chunky start", "pause": "chunky pause", "resume": "chunky continue",
		"cancel": "chunky cancel", "progress": "chunky progress",
	} {
		got := backend.GenerationCommands(adapter.GenerationAction{Verb: verb})
		if len(got) != 1 || got[0] != expected {
			t.Errorf("%s produced %v, want %q", verb, got, expected)
		}
	}
	if got := backend.GenerationCommands(adapter.GenerationAction{Verb: "nonsense"}); got != nil {
		t.Errorf("expected no commands for an unknown verb, got %v", got)
	}
}

func TestConfigFilesCoverTheDocumentedSet(t *testing.T) {
	backend := New()
	want := []string{"server.properties", "bukkit.yml", "spigot.yml", "paper-global.yml",
		"paper-world-defaults.yml", "ops.json", "whitelist.json"}
	files := backend.ConfigFiles()
	if len(files) != len(want) {
		t.Fatalf("expected %d editable files, got %d", len(want), len(files))
	}
	byName := map[string]bool{}
	for _, file := range files {
		byName[file.Name] = true
		if file.RelPath == "" || file.Format == "" {
			t.Errorf("%s is missing metadata", file.Name)
		}
		if strings.Contains(file.RelPath, "..") {
			t.Errorf("%s has an unsafe relative path", file.Name)
		}
	}
	for _, name := range want {
		if !byName[name] {
			t.Errorf("%s is not editable", name)
		}
	}
}

func TestEULAContentAndDefaults(t *testing.T) {
	backend := New()
	if !strings.Contains(backend.EULAAcceptedContent(), "eula=true") {
		t.Error("the EULA file must record acceptance")
	}
	defaults := backend.DefaultProperties()
	if defaults["level-name"] != "world" {
		t.Errorf("level-name should stay 'world', got %q", defaults["level-name"])
	}
	if defaults["enable-rcon"] != "false" {
		t.Error("RCON must be off by default")
	}
	viewDistance := defaults["view-distance"]
	if viewDistance != "7" {
		t.Errorf("expected a Pi friendly view distance, got %q", viewDistance)
	}
}

func TestWorldContainerArgs(t *testing.T) {
	args := WorldContainerArgs("/data/worlds/survival")
	if len(args) != 2 || args[0] != "--world-container" || args[1] != "/data/worlds/survival" {
		t.Fatalf("unexpected arguments %v", args)
	}
}

func indexOf(values []string, want string) int {
	for i, value := range values {
		if value == want {
			return i
		}
	}
	return -1
}
