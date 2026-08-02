package bta

import (
	"strings"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
)

func TestArgvHasNoServerArguments(t *testing.T) {
	b := New()
	argv, err := b.Argv(adapter.LaunchContext{
		JavaBin: "/usr/bin/java", JarPath: "/data/runtime/bta/bta.jar",
		HeapMinMB: 1024, HeapMaxMB: 2048, ServerPort: 25565, Nogui: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(argv, " ")
	// BTA's main method ignores its arguments: the port comes from
	// server.properties and there is no --nogui or --world-container.
	for _, unexpected := range []string{"--nogui", "--port", "--world-container"} {
		if strings.Contains(joined, unexpected) {
			t.Errorf("BTA takes no arguments, but argv has %q: %s", unexpected, joined)
		}
	}
	if argv[len(argv)-2] != "-jar" {
		t.Fatalf("the JAR must be last: %v", argv)
	}
	if !strings.Contains(joined, "-Xmx2048M") || !strings.Contains(joined, "-Xms1024M") {
		t.Fatalf("heap flags missing: %s", joined)
	}
}

func TestArgvRejectsAnIncompleteContext(t *testing.T) {
	b := New()
	cases := []adapter.LaunchContext{
		{JarPath: "x", HeapMinMB: 1, HeapMaxMB: 2},
		{JavaBin: "java", HeapMinMB: 1, HeapMaxMB: 2},
		{JavaBin: "java", JarPath: "x", HeapMinMB: 0, HeapMaxMB: 2},
		{JavaBin: "java", JarPath: "x", HeapMinMB: 4096, HeapMaxMB: 1024},
	}
	for i, ctx := range cases {
		if _, err := b.Argv(ctx); err == nil {
			t.Errorf("case %d should have been rejected", i)
		}
	}
}

func TestCapabilitiesSayWhatIsMissing(t *testing.T) {
	caps := New().Capabilities()
	if caps.BukkitPlugins || caps.TerrainGeneration || caps.BridgeTelemetry {
		t.Error("BTA is not a Bukkit server; none of the plugin features apply")
	}
	if caps.EULAFile {
		t.Error("BTA has no eula.txt")
	}
	if caps.ServerPortArg {
		t.Error("BTA's port is a property, not an argument")
	}
	if caps.WorldBinding != adapter.BindLevelLink {
		t.Errorf("unexpected world binding %q", caps.WorldBinding)
	}
	// The other dimensions live inside the level directory, so a world set is one
	// directory rather than three.
	if len(caps.Dimensions) != 1 || caps.Dimensions[0] != "world" {
		t.Errorf("unexpected dimensions %v", caps.Dimensions)
	}
	if New().WorldArgs("/data/worlds/bta/survival") != nil {
		t.Error("BTA has no world container argument")
	}
}

// The lines below are real BTA 7.3 console output; the log pattern is
// [HH:mm:ss] [thread/LEVEL]: message.
func TestParseRecognisesBTAConsoleLines(t *testing.T) {
	b := New()
	cases := []struct {
		line   string
		kind   adapter.LogKind
		player string
	}{
		{`[05:18:55] [Server thread/INFO]: Done (3524571348ns)! For help, type "help" or "?"`, adapter.KindReady, ""},
		{`[05:19:02] [Server thread/INFO]: Skipyzi joined the game.`, adapter.KindPlayerJoin, "Skipyzi"},
		{`[05:22:41] [Server thread/INFO]: Skipyzi left the game.`, adapter.KindPlayerLeave, "Skipyzi"},
		{`[05:18:50] [main/INFO]: Starting Better than Adventure! server for version 7.3`, adapter.KindVersion, ""},
		{`[05:30:00] [Server thread/INFO]: Stopping the server`, adapter.KindStopping, ""},
		{`[05:18:51] [main/WARN]: **** FAILED TO BIND TO PORT!`, adapter.KindPortUnavailable, ""},
		{`[05:25:00] [Server thread/INFO]: Saving complete`, adapter.KindSaved, ""},
		{`[05:25:00] [Server thread/INFO]: Disabling auto saving`, adapter.KindSaveDisabled, ""},
		{`[05:25:30] [Server thread/INFO]: Enabling auto saving`, adapter.KindSaveEnabled, ""},
		{`[05:18:52] [Server thread/INFO]: nothing interesting`, adapter.KindOther, ""},
	}
	for _, tc := range cases {
		ev := b.Parse(tc.line)
		if ev.Kind != tc.kind {
			t.Errorf("%q parsed as %q, want %q", tc.line, ev.Kind, tc.kind)
		}
		if tc.player != "" && ev.Player != tc.player {
			t.Errorf("%q gave player %q, want %q", tc.line, ev.Player, tc.player)
		}
	}
	if ev := b.Parse(`[05:18:50] [main/INFO]: Starting Better than Adventure! server for version 7.3`); ev.Version != "7.3" {
		t.Errorf("version not parsed: %q", ev.Version)
	}
}

// Paper's "Done (12.345s)!" must not be mistaken for BTA's, and the other way
// round: the ready line is what a start is judged on.
func TestReadyLineIsBTASpecific(t *testing.T) {
	if New().Parse(`[05:18:55] [Server thread/INFO]: Done (12.345s)! For help, type "help"`).Kind == adapter.KindReady {
		t.Error("a Paper ready line must not match the BTA pattern")
	}
}

func TestConsoleCommandsUseBrigadierSubCommands(t *testing.T) {
	b := New()
	if b.SaveAllCommand() != "save all" || b.SaveOffCommand() != "save off" || b.SaveOnCommand() != "save on" {
		t.Errorf("unexpected save commands: %q %q %q",
			b.SaveAllCommand(), b.SaveOffCommand(), b.SaveOnCommand())
	}
	if b.StopCommand() != "stop" {
		t.Errorf("unexpected stop command %q", b.StopCommand())
	}
	if b.GenerationCommands(adapter.GenerationAction{Verb: "start"}) != nil {
		t.Error("BTA has no pre-generation plugin")
	}
}

func TestDefaultPropertiesDoNotPhoneHome(t *testing.T) {
	props := New().DefaultProperties()
	// BTA only contacts its stats API when a token is configured.
	if props["stats-token"] != "" {
		t.Errorf("stats-token must default to empty, got %q", props["stats-token"])
	}
	if props["level-name"] != "world" {
		t.Errorf("the level name must match the linked directory, got %q", props["level-name"])
	}
	if props["online-mode"] != "true" {
		t.Error("online-mode must default to true")
	}
}

func TestConfigFilesAreTextLists(t *testing.T) {
	for _, file := range New().ConfigFiles() {
		if file.Name == "ops.txt" && file.Format != "lines" {
			t.Errorf("ops.txt should be edited as plain lines, got %q", file.Format)
		}
		if strings.HasSuffix(file.Name, ".json") {
			t.Errorf("BTA has no JSON configuration, but %q is listed", file.Name)
		}
	}
}
