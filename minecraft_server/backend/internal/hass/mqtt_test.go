package hass

import (
	"encoding/json"
	"strings"
	"testing"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

// fakeMessage is the minimal mqtt.Message implementation the handler needs.
type fakeMessage struct {
	topic   string
	payload []byte
}

func (m fakeMessage) Duplicate() bool   { return false }
func (m fakeMessage) Qos() byte         { return 1 }
func (m fakeMessage) Retained() bool    { return false }
func (m fakeMessage) Topic() string     { return m.topic }
func (m fakeMessage) MessageID() uint16 { return 1 }
func (m fakeMessage) Payload() []byte   { return m.payload }
func (m fakeMessage) Ack()              {}

var _ mqtt.Message = fakeMessage{}

func newClient(t *testing.T) (*Client, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	sup := supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: paper.New(), Log: env.Log, Flags: paper.FlagProfile,
	})
	config := mcconfig.NewManager(env.Paths, paper.New(), env.Store, env.Bus, env.Log)
	worldManager := worlds.NewManager(worlds.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Supervisor: sup, Config: config, Log: env.Log,
	})
	presetManager := presets.NewManager(env.Paths, t.TempDir(), config, env.Settings, env.Store, env.Bus, env.Log)
	service := commands.New(commands.Deps{
		Settings: env.Settings, Store: env.Store, Supervisor: sup, Log: env.Log,
		Config: config, Worlds: worldManager, Presets: presetManager,
	})
	client := New(Deps{
		Options: env.Options, Settings: env.Settings, Store: env.Store,
		Supervisor: sup, Commands: service, Worlds: worldManager, Presets: presetManager,
		Log: env.Log,
	})
	return client, env
}

func TestCommandsFromHomeAssistantGoThroughTheCommandService(t *testing.T) {
	client, env := newClient(t)

	// A select maps onto the same validated command the web UI calls.
	client.handleCommand(nil, fakeMessage{
		topic: cmdPrefix + "/select_generation_profile", payload: []byte("maximum"),
	})
	if got := env.Settings.Get().GenerationProfile; got != "maximum" {
		t.Fatalf("expected the profile to change, got %q", got)
	}

	// An invalid payload is refused by the same validation and recorded as an error.
	client.handleCommand(nil, fakeMessage{
		topic: cmdPrefix + "/select_generation_profile", payload: []byte("turbo"),
	})
	if got := env.Settings.Get().GenerationProfile; got != "maximum" {
		t.Fatalf("an invalid payload changed the profile to %q", got)
	}
	entries, err := env.Store.RecentAudit(20, "mqtt.")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("expected the rejected command to be audited")
	}
	if entries[0].Result != "error" {
		t.Fatalf("expected an error result, got %q", entries[0].Result)
	}
}

func TestUnknownCommandTopicsAreIgnored(t *testing.T) {
	client, env := newClient(t)
	client.handleCommand(nil, fakeMessage{topic: cmdPrefix + "/rm_rf_slash", payload: []byte("PRESS")})
	entries, err := env.Store.RecentAudit(20, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Action, "mqtt.rm_rf") {
			t.Fatal("an unknown topic must not turn into an action")
		}
	}
}

func TestDiscoveryPayloadsCoverTheDocumentedEntities(t *testing.T) {
	client, _ := newClient(t)
	entities := client.entities([]string{"survival"}, []string{"balanced"})

	want := map[string]string{
		"server_running":       "binary_sensor",
		"maintenance_mode":     "binary_sensor",
		"players_online":       "sensor",
		"tps":                  "sensor",
		"mspt":                 "sensor",
		"world_size":           "sensor",
		"backup_repository_size": "sensor",
		"last_backup":          "sensor",
		"cpu_temperature":      "sensor",
		"generation_progress":  "sensor",
		"generation_rate":      "sensor",
		"start":                "button",
		"stop":                 "button",
		"restart":              "button",
		"backup":               "button",
		"pause_generation":     "button",
		"resume_generation":    "button",
		"world":                "select",
		"preset":               "select",
		"generation_profile":   "select",
	}
	found := map[string]string{}
	for _, entity := range entities {
		found[entity.object] = entity.component
		// Every entity must be discoverable, available-aware and attached to the
		// same device.
		if entity.config["unique_id"] == nil || entity.config["availability_topic"] == nil {
			t.Errorf("%s is missing discovery fields", entity.object)
		}
		if _, err := json.Marshal(entity.config); err != nil {
			t.Errorf("%s payload is not serialisable: %v", entity.object, err)
		}
	}
	for object, component := range want {
		if found[object] != component {
			t.Errorf("expected %s to be a %s, got %q", object, component, found[object])
		}
	}
}

func TestSelectOptionsFallBackToNone(t *testing.T) {
	client, _ := newClient(t)
	worlds, presets := client.selectOptions()
	if len(worlds) != 1 || worlds[0] != "none" {
		t.Fatalf("expected a placeholder world option, got %v", worlds)
	}
	if len(presets) == 0 {
		t.Fatal("expected at least a placeholder preset option")
	}
}

func TestResolveBrokerPrefersExplicitOptionsThenSupervisor(t *testing.T) {
	client, _ := newClient(t)
	if _, _, _, _, ok := client.resolveBroker(); ok {
		t.Fatal("expected no broker when neither options nor the Supervisor provide one")
	}

	client.deps.Env = appcfg.Environment{MQTTService: appcfg.MQTTService{
		Host: "core-mosquitto", Port: 1883, Username: "addon", Password: "secret",
	}}
	host, port, user, _, ok := client.resolveBroker()
	if !ok || host != "core-mosquitto" || port != 1883 || user != "addon" {
		t.Fatalf("expected the Supervisor service to be used, got %s:%d %s", host, port, user)
	}

	client.deps.Options.MQTTHost = "192.168.1.10"
	client.deps.Options.MQTTPort = 1884
	host, port, _, _, ok = client.resolveBroker()
	if !ok || host != "192.168.1.10" || port != 1884 {
		t.Fatalf("explicit options should win, got %s:%d", host, port)
	}
}
