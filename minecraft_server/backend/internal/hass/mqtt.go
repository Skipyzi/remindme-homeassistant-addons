// Package hass publishes Home Assistant entities over MQTT discovery and turns
// entity commands back into controller commands.
//
// Commands from Home Assistant go through the same commands.Service as the web
// UI, so authorization, validation and the audit log are identical no matter
// where a button press came from.
package hass

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

const (
	baseTopic   = "minecraft_addon"
	stateTopic  = baseTopic + "/state"
	availTopic  = baseTopic + "/availability"
	cmdPrefix   = baseTopic + "/cmd"
	nodeID      = "minecraft"
	actorName   = "homeassistant"
	publishFreq = 10 * time.Second
)

type Deps struct {
	Options    appcfg.Options
	Env        appcfg.Environment
	Settings   *appcfg.Store
	Store      *store.Store
	Supervisor *supervisor.Supervisor
	Commands   *commands.Service
	Worlds     *worlds.Manager
	Presets    *presets.Manager
	Backups    *backups.Manager
	Generation *generation.Manager
	Stats      *stats.Collector
	Telemetry  func() (bridge.Telemetry, bool)
	Log        *slog.Logger
}

type Client struct {
	deps   Deps
	log    *slog.Logger
	client mqtt.Client

	mu            sync.Mutex
	lastWorldList string
	lastPresets   string
	connected     bool
}

func New(d Deps) *Client {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	return &Client{deps: d, log: d.Log.With("component", "mqtt")}
}

// resolveBroker prefers the Supervisor-provided MQTT service so a normal
// installation needs no configuration at all.
func (c *Client) resolveBroker() (host string, port int, user, pass string, ok bool) {
	o := c.deps.Options
	if o.MQTTHost != "" {
		return o.MQTTHost, o.MQTTPort, o.MQTTUsername, o.MQTTPassword, true
	}
	if svc := c.deps.Env.MQTTService; svc.Available() {
		return svc.Host, svc.Port, svc.Username, svc.Password, true
	}
	return "", 0, "", "", false
}

// Run connects and keeps publishing until the context ends.
func (c *Client) Run(ctx context.Context) {
	if !c.deps.Options.MQTTEnabled {
		c.log.Info("Home Assistant entities are disabled")
		return
	}
	host, port, user, pass, ok := c.resolveBroker()
	if !ok {
		c.log.Warn("no MQTT broker configured or offered by the Supervisor; Home Assistant entities are unavailable")
		return
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(fmt.Sprintf("tcp://%s:%d", host, port))
	opts.SetClientID("minecraft-addon-" + shortHost())
	opts.SetUsername(user)
	opts.SetPassword(pass)
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(15 * time.Second)
	opts.SetKeepAlive(30 * time.Second)
	opts.SetCleanSession(true)
	// The broker publishes this if the add-on disappears, so entities go
	// unavailable instead of showing stale values.
	opts.SetWill(availTopic, "offline", 1, true)
	opts.OnConnect = func(client mqtt.Client) {
		c.mu.Lock()
		c.connected = true
		c.mu.Unlock()
		c.log.Info("connected to MQTT broker", "host", host, "port", port)
		client.Publish(availTopic, 1, true, "online")
		c.publishDiscovery(client, true)
		c.subscribe(client)
		c.publishState(client)
	}
	opts.OnConnectionLost = func(_ mqtt.Client, err error) {
		c.mu.Lock()
		c.connected = false
		c.mu.Unlock()
		c.log.Warn("MQTT connection lost", "error", err)
	}

	client := mqtt.NewClient(opts)
	c.client = client
	token := client.Connect()
	go func() {
		token.Wait()
		if err := token.Error(); err != nil {
			c.log.Warn("MQTT connection failed, retrying in the background", "error", err)
		}
	}()

	ticker := time.NewTicker(publishFreq)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			if client.IsConnected() {
				client.Publish(availTopic, 1, true, "offline").WaitTimeout(2 * time.Second)
				client.Disconnect(500)
			}
			return
		case <-ticker.C:
			if !client.IsConnected() {
				continue
			}
			c.publishDiscovery(client, false)
			c.publishState(client)
		}
	}
}

func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// device is attached to every entity so they group under one Home Assistant
// device.
func (c *Client) device() map[string]any {
	return map[string]any{
		"identifiers":  []string{"minecraft_addon_" + nodeID},
		"name":         "Minecraft Server",
		"manufacturer": "RemindMe add-ons",
		"model":        "PaperMC on Home Assistant OS",
		"sw_version":   c.deps.Settings.Get().PaperVersion,
	}
}

// entity describes one discovery payload.
type entity struct {
	component string
	object    string
	config    map[string]any
}

func (c *Client) discoveryTopic(e entity) string {
	prefix := c.deps.Options.MQTTDiscoveryPrefix
	if prefix == "" {
		prefix = "homeassistant"
	}
	return fmt.Sprintf("%s/%s/%s/%s/config", prefix, e.component, nodeID, e.object)
}

// publishDiscovery publishes entity definitions. Selects are re-published when
// their option lists change (a new world, a new preset).
func (c *Client) publishDiscovery(client mqtt.Client, force bool) {
	worldOptions, presetOptions := c.selectOptions()
	worldKey := strings.Join(worldOptions, ",")
	presetKey := strings.Join(presetOptions, ",")

	c.mu.Lock()
	changed := worldKey != c.lastWorldList || presetKey != c.lastPresets
	c.lastWorldList, c.lastPresets = worldKey, presetKey
	c.mu.Unlock()

	if !force && !changed {
		return
	}
	for _, e := range c.entities(worldOptions, presetOptions) {
		payload, err := json.Marshal(e.config)
		if err != nil {
			continue
		}
		client.Publish(c.discoveryTopic(e), 1, true, payload)
	}
}

func (c *Client) selectOptions() (worldOptions, presetOptions []string) {
	if list, err := c.deps.Worlds.List(); err == nil {
		for _, world := range list {
			if !world.Archived {
				worldOptions = append(worldOptions, world.ID)
			}
		}
	}
	if len(worldOptions) == 0 {
		worldOptions = []string{"none"}
	}
	if list, err := c.deps.Presets.List(); err == nil {
		for _, preset := range list {
			presetOptions = append(presetOptions, preset.ID)
		}
	}
	if len(presetOptions) == 0 {
		presetOptions = []string{"none"}
	}
	return worldOptions, presetOptions
}

func (c *Client) entities(worldOptions, presetOptions []string) []entity {
	base := func(name, object string) map[string]any {
		return map[string]any{
			"name":                name,
			"unique_id":           "minecraft_addon_" + object,
			"object_id":           "minecraft_" + object,
			"state_topic":         stateTopic,
			"availability_topic":  availTopic,
			"json_attributes_topic": stateTopic,
			"device":              c.device(),
		}
	}
	sensor := func(name, object, template, unit, deviceClass, icon string) entity {
		cfg := base(name, object)
		cfg["value_template"] = template
		if unit != "" {
			cfg["unit_of_measurement"] = unit
			cfg["state_class"] = "measurement"
		}
		if deviceClass != "" {
			cfg["device_class"] = deviceClass
		}
		if icon != "" {
			cfg["icon"] = icon
		}
		return entity{component: "sensor", object: object, config: cfg}
	}
	button := func(name, object, command, icon string) entity {
		cfg := base(name, object)
		delete(cfg, "state_topic")
		delete(cfg, "json_attributes_topic")
		cfg["command_topic"] = cmdPrefix + "/" + command
		cfg["payload_press"] = "PRESS"
		if icon != "" {
			cfg["icon"] = icon
		}
		return entity{component: "button", object: object, config: cfg}
	}

	out := []entity{
		{component: "binary_sensor", object: "server_running", config: mergeMap(base("Minecraft server running", "server_running"), map[string]any{
			"value_template": "{{ 'ON' if value_json.running else 'OFF' }}",
			"payload_on":     "ON",
			"payload_off":    "OFF",
			"device_class":   "running",
			"icon":           "mdi:minecraft",
		})},
		{component: "binary_sensor", object: "maintenance_mode", config: mergeMap(base("Minecraft maintenance mode", "maintenance_mode"), map[string]any{
			"value_template": "{{ 'ON' if value_json.maintenance else 'OFF' }}",
			"payload_on":     "ON",
			"payload_off":    "OFF",
			"icon":           "mdi:wrench",
		})},
		sensor("Minecraft state", "state", "{{ value_json.state }}", "", "", "mdi:state-machine"),
		sensor("Minecraft players online", "players_online", "{{ value_json.players_online }}", "players", "", "mdi:account-group"),
		sensor("Minecraft TPS", "tps", "{{ value_json.tps }}", "", "", "mdi:speedometer"),
		sensor("Minecraft MSPT", "mspt", "{{ value_json.mspt }}", "ms", "", "mdi:timer-outline"),
		sensor("Minecraft world size", "world_size", "{{ value_json.world_size_mb }}", "MB", "data_size", "mdi:earth"),
		sensor("Minecraft backup repository size", "backup_repository_size", "{{ value_json.backup_size_mb }}", "MB", "data_size", "mdi:database"),
		sensor("Minecraft last backup", "last_backup", "{{ value_json.last_backup }}", "", "timestamp", "mdi:backup-restore"),
		sensor("Minecraft CPU temperature", "cpu_temperature", "{{ value_json.cpu_temperature_c }}", "°C", "temperature", "mdi:thermometer"),
		sensor("Minecraft heap used", "heap_used", "{{ value_json.heap_used_mb }}", "MB", "data_size", "mdi:memory"),
		sensor("Minecraft generation progress", "generation_progress", "{{ value_json.generation_progress }}", "%", "", "mdi:progress-wrench"),
		sensor("Minecraft generation rate", "generation_rate", "{{ value_json.generation_rate }}", "chunks/s", "", "mdi:chart-line"),
		button("Minecraft start", "start", "start", "mdi:play"),
		button("Minecraft stop", "stop", "stop", "mdi:stop"),
		button("Minecraft restart", "restart", "restart", "mdi:restart"),
		button("Minecraft backup", "backup", "backup", "mdi:content-save"),
		button("Minecraft pause generation", "pause_generation", "pause_generation", "mdi:pause"),
		button("Minecraft resume generation", "resume_generation", "resume_generation", "mdi:play-pause"),
	}

	worldSelect := base("Minecraft world", "world")
	worldSelect["command_topic"] = cmdPrefix + "/select_world"
	worldSelect["value_template"] = "{{ value_json.active_world }}"
	worldSelect["options"] = worldOptions
	worldSelect["icon"] = "mdi:earth"
	out = append(out, entity{component: "select", object: "world", config: worldSelect})

	presetSelect := base("Minecraft preset", "preset")
	presetSelect["command_topic"] = cmdPrefix + "/select_preset"
	presetSelect["value_template"] = "{{ value_json.active_preset }}"
	presetSelect["options"] = presetOptions
	presetSelect["icon"] = "mdi:tune"
	out = append(out, entity{component: "select", object: "preset", config: presetSelect})

	profileSelect := base("Minecraft generation profile", "generation_profile")
	profileSelect["command_topic"] = cmdPrefix + "/select_generation_profile"
	profileSelect["value_template"] = "{{ value_json.generation_profile }}"
	profileSelect["options"] = []string{generation.ProfileGentle, generation.ProfileBalanced, generation.ProfileMaximum}
	profileSelect["icon"] = "mdi:map-clock"
	out = append(out, entity{component: "select", object: "generation_profile", config: profileSelect})

	return out
}

func mergeMap(dst, src map[string]any) map[string]any {
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

// publishState sends one JSON document that every entity reads through its own
// value template. One message keeps broker traffic low, which matters on a Pi.
func (c *Client) publishState(client mqtt.Client) {
	snapshot := c.deps.Supervisor.Snapshot()
	settings := c.deps.Settings.Get()
	system := c.deps.Stats.System()
	genStatus := c.deps.Generation.Status()

	telemetry, fresh := c.deps.Telemetry()
	players := len(snapshot.Players)
	tps := 0.0
	mspt := 0.0
	heapUsed := int64(0)
	heapMax := int64(0)
	if fresh {
		players = telemetry.OnlinePlayers
		tps = round2(telemetry.TPS1m())
		mspt = round2(telemetry.MSPT)
		heapUsed = telemetry.HeapUsedMB
		heapMax = telemetry.HeapMaxMB
	}

	worldSizeMB := int64(0)
	if settings.ActiveWorld != "" {
		worldSizeMB = c.deps.Stats.Size("world:"+settings.ActiveWorld).Bytes / (1 << 20)
	}
	lastBackup := ""
	if record, ok, _ := c.deps.Store.LastSuccessfulBackup(); ok {
		lastBackup = record.CreatedAt.UTC().Format(time.RFC3339)
	}

	genProgress := 0.0
	genRate := 0.0
	genPaused := ""
	if genStatus.Job != nil {
		genProgress = round2(genStatus.Job.Progress)
		genRate = round2(genStatus.Job.Rate)
		genPaused = genStatus.Job.PauseReason
	}

	payload := map[string]any{
		"state":                string(snapshot.State),
		"running":              snapshot.ProcessState == supervisor.StateRunning,
		"maintenance":          settings.MaintenanceMode,
		"players_online":       players,
		"players":              snapshot.Players,
		"max_players":          telemetry.MaxPlayers,
		"tps":                  tps,
		"mspt":                 mspt,
		"heap_used_mb":         heapUsed,
		"heap_max_mb":          heapMax,
		"loaded_chunks":        telemetry.LoadedChunks,
		"entities":             telemetry.Entities,
		"uptime_seconds":       snapshot.UptimeSeconds,
		"version":              snapshot.Version,
		"active_world":         orNone(settings.ActiveWorld),
		"active_preset":        orNone(settings.ActivePreset),
		"generation_profile":   orDefault(settings.GenerationProfile, generation.ProfileGentle),
		"world_size_mb":        worldSizeMB,
		"backup_size_mb":       c.deps.Stats.Size("backups").Bytes / (1 << 20),
		"last_backup":          lastBackup,
		"cpu_temperature_c":    round2(system.CPUTemperatureC),
		"cpu_percent":          round2(system.CPUPercent),
		"thermal_throttled":    system.ThermalThrottled,
		"disk_free_gb":         round2(float64(system.DiskFreeBytes) / (1 << 30)),
		"generation_active":    genStatus.Active,
		"generation_progress":  genProgress,
		"generation_rate":      genRate,
		"generation_paused_reason": genPaused,
		"crash_count":          snapshot.CrashCount,
		"last_exit_code":       snapshot.LastExitCode,
		"eula_accepted":        settings.EULAAccepted,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	client.Publish(stateTopic, 0, true, raw)
}

func (c *Client) subscribe(client mqtt.Client) {
	topic := cmdPrefix + "/#"
	if token := client.Subscribe(topic, 1, c.handleCommand); token.Wait() && token.Error() != nil {
		c.log.Warn("could not subscribe to command topics", "error", token.Error())
	}
}

// handleCommand maps an MQTT message onto a controller command. Unknown topics and
// invalid payloads are logged and ignored: an entity must never be able to make
// the controller do something the web UI could not.
func (c *Client) handleCommand(_ mqtt.Client, msg mqtt.Message) {
	action := strings.TrimPrefix(msg.Topic(), cmdPrefix+"/")
	payload := strings.TrimSpace(string(msg.Payload()))
	c.log.Info("command from Home Assistant", "action", action, "payload", payload)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	var err error
	switch action {
	case "start":
		err = c.deps.Commands.Start(actorName)
	case "stop":
		err = c.deps.Commands.Stop(ctx, actorName, false, "")
	case "restart":
		err = c.deps.Commands.Restart(ctx, actorName)
	case "backup":
		_, err = c.deps.Commands.Backup(ctx, actorName, backups.CreateRequest{
			Kind: "home_assistant", Label: "triggered from Home Assistant",
		})
	case "pause_generation":
		err = c.deps.Commands.PauseGeneration(actorName)
	case "resume_generation":
		err = c.deps.Commands.ResumeGeneration(actorName)
	case "select_world":
		_, err = c.deps.Commands.ActivateWorld(ctx, actorName, worlds.ActivateRequest{
			WorldID: payload, Backup: true,
		})
	case "select_preset":
		_, err = c.deps.Commands.ApplyPreset(actorName, payload, false)
	case "select_generation_profile":
		err = c.deps.Commands.SetGenerationProfile(actorName, payload)
	default:
		c.log.Warn("ignoring unknown command topic", "action", action)
		return
	}
	if err != nil {
		c.log.Warn("command from Home Assistant failed", "action", action, "error", err)
		_ = c.deps.Store.Audit(store.AuditEntry{Actor: actorName, Action: "mqtt." + action,
			Detail: err.Error(), Result: "error"})
		return
	}
	if c.client != nil && c.client.IsConnected() {
		c.publishState(c.client)
	}
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}

func orNone(v string) string {
	if v == "" {
		return "none"
	}
	return v
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func shortHost() string {
	host, err := hostname()
	if err != nil || host == "" {
		return "addon"
	}
	if len(host) > 12 {
		return host[:12]
	}
	return host
}
