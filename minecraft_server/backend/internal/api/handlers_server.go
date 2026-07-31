package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/updates"
)

// StatusResponse is the one call the dashboard makes on load; everything after
// that arrives over the event stream.
type StatusResponse struct {
	Version   string              `json:"controller_version"`
	Server    supervisor.Snapshot `json:"server"`
	World     string              `json:"active_world"`
	WorldName string              `json:"active_world_name"`
	Settings  appcfg.Settings     `json:"settings"`
	// Flavour and Capabilities let the UI hide what this server cannot do rather
	// than offering it and failing.
	Flavour      string               `json:"flavour"`
	FlavourName  string               `json:"flavour_name"`
	Capabilities adapter.Capabilities `json:"capabilities"`
	Jar          updates.Installed    `json:"jar"`
	Bridge       BridgeStatus         `json:"bridge"`
	Maintenance  bool                 `json:"maintenance_mode"`
	EULA         bool                 `json:"eula_accepted"`
	Generation   any                  `json:"generation"`
	Backups      BackupSummary        `json:"backups"`
	Warnings     []string             `json:"warnings,omitempty"`
	ServerTime   string               `json:"server_time"`
}

type BridgeStatus struct {
	Connected     bool   `json:"connected"`
	PluginVersion string `json:"plugin_version"`
	LastSeen      string `json:"last_seen"`
}

type BackupSummary struct {
	LastBackupAt string `json:"last_backup_at"`
	LastKind     string `json:"last_kind"`
	LastStatus   string `json:"last_status"`
	Count        int    `json:"count"`
	SizeBytes    int64  `json:"repository_size_bytes"`
	Running      bool   `json:"running"`
	RunningKind  string `json:"running_kind"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	settings := s.deps.Settings.Get()
	snapshot := s.deps.Supervisor.Snapshot()

	resp := StatusResponse{
		Version:      s.deps.Version,
		Flavour:      s.deps.Backend.Name(),
		FlavourName:  s.deps.Backend.DisplayName(),
		Capabilities: s.deps.Backend.Capabilities(),
		Server:       snapshot,
		World:        settings.ActiveWorld,
		Settings:     settings,
		Jar:          s.deps.Updates.Installed(),
		Maintenance:  settings.MaintenanceMode,
		EULA:         settings.EULAAccepted,
		Generation:   s.deps.Generation.Status(),
		ServerTime:   time.Now().Format(time.RFC3339),
	}
	if settings.ActiveWorld != "" {
		if info, err := s.deps.Worlds.Get(settings.ActiveWorld); err == nil {
			resp.WorldName = info.Name
		}
	}
	if telemetry, fresh := s.deps.Bridge.Latest(); fresh {
		resp.Bridge = BridgeStatus{
			Connected: true, PluginVersion: telemetry.PluginVersion,
			LastSeen: telemetry.ReceivedAt.UTC().Format(time.RFC3339),
		}
	} else {
		resp.Bridge.Connected = s.deps.Bridge.Connected()
	}

	if records, err := s.deps.Store.ListBackups(200); err == nil {
		resp.Backups.Count = len(records)
		for _, rec := range records {
			if rec.Status == store.BackupComplete {
				resp.Backups.LastBackupAt = rec.CreatedAt.UTC().Format(time.RFC3339)
				resp.Backups.LastKind = rec.Kind
				resp.Backups.LastStatus = rec.Status
				break
			}
		}
	}
	resp.Backups.SizeBytes = s.deps.Stats.Size("backups").Bytes
	if _, kind, _, _, running := s.deps.Backups.Current(); running {
		resp.Backups.Running = true
		resp.Backups.RunningKind = kind
	}

	if !settings.EULAAccepted {
		resp.Warnings = append(resp.Warnings, "The Minecraft EULA has not been accepted yet, so the server cannot start.")
	}
	if !resp.Jar.Present {
		resp.Warnings = append(resp.Warnings, "No server JAR is installed. Install PaperMC from the Server tab.")
	}
	if snapshot.SaveDisabled {
		resp.Warnings = append(resp.Warnings, "World saving is currently disabled. If no backup is running, re-enable it from the console.")
	}
	s.ok(w, resp)
}

// StatsResponse is polled by nothing: it is sent over the event stream every few
// seconds and is available here for scripts and debugging.
type StatsResponse struct {
	System    stats.System               `json:"system"`
	Telemetry bridge.Telemetry           `json:"telemetry"`
	Fresh     bool                       `json:"telemetry_fresh"`
	Sizes     map[string]stats.SizeEntry `json:"sizes"`
	Server    supervisor.Snapshot        `json:"server"`
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	telemetry, fresh := s.deps.Bridge.Latest()
	s.ok(w, StatsResponse{
		System:    s.deps.Stats.System(),
		Telemetry: telemetry,
		Fresh:     fresh,
		Sizes:     s.deps.Stats.Sizes(),
		Server:    s.deps.Supervisor.Snapshot(),
	})
}

func (s *Server) handlePlayers(w http.ResponseWriter, r *http.Request) {
	telemetry, fresh := s.deps.Bridge.Latest()
	players := telemetry.Players
	if !fresh {
		players = s.deps.Supervisor.PlayerNames()
	}
	max := telemetry.MaxPlayers
	if max == 0 {
		if props, err := s.deps.Config.Properties(); err == nil {
			max = props.GetInt("max-players", 0)
		}
	}
	s.ok(w, map[string]any{
		"players": players, "online": len(players), "max": max, "source": sourceOf(fresh),
	})
}

func sourceOf(fresh bool) string {
	if fresh {
		return "bridge"
	}
	return "console"
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request) {
	after := uint64(intParam(r, "after", 0))
	limit := intParam(r, "limit", 300)
	s.ok(w, map[string]any{
		"lines": s.deps.Supervisor.Console(after, limit),
	})
}

// handleEvents is the Server-Sent Events stream. One connection carries every
// event type; the client filters. Heartbeats keep proxies from closing it.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, http.StatusInternalServerError, errors.New("streaming is not supported by this connection"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Ingress sits behind nginx; without this it would buffer the stream.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, cancel := s.deps.Bus.Subscribe(256)
	defer cancel()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	statsTicker := time.NewTicker(3 * time.Second)
	defer statsTicker.Stop()

	send := func(ev events.Event) bool {
		payload, err := json.Marshal(ev)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "event: %s\nid: %d\ndata: %s\n\n", ev.Type, ev.Seq, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Prime the client with the current state so it does not have to wait for the
	// first change.
	if !send(events.Event{Type: events.TypeServerState, Time: time.Now().UTC().Format(time.RFC3339),
		Data: s.deps.Supervisor.Snapshot()}) {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-ch:
			if !open {
				return
			}
			if !send(ev) {
				return
			}
		case <-statsTicker.C:
			telemetry, fresh := s.deps.Bridge.Latest()
			if !send(events.Event{Type: events.TypeStatsUpdate, Time: time.Now().UTC().Format(time.RFC3339),
				Data: StatsResponse{
					System: s.deps.Stats.System(), Telemetry: telemetry, Fresh: fresh,
					Sizes: s.deps.Stats.Sizes(), Server: s.deps.Supervisor.Snapshot(),
				}}) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	entries, err := s.deps.Store.RecentAudit(intParam(r, "limit", 100), r.URL.Query().Get("prefix"))
	if err != nil {
		s.fail(w, http.StatusInternalServerError, err)
		return
	}
	s.ok(w, map[string]any{"entries": entries})
}

func (s *Server) handleJournal(w http.ResponseWriter, r *http.Request) {
	entries, err := s.deps.Store.RecentJournals(intParam(r, "limit", 50))
	if err != nil {
		s.fail(w, http.StatusInternalServerError, err)
		return
	}
	s.ok(w, map[string]any{"entries": entries})
}

// -------------------------------------------------------------- control ------

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Commands.Start(s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"state": s.deps.Supervisor.Snapshot().State})
}

type stopRequest struct {
	Force   bool   `json:"force"`
	Confirm string `json:"confirm"`
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	var req stopRequest
	if !s.decodeOptional(w, r, &req) {
		return
	}
	// The HTTP request must not be what bounds a graceful stop: a browser tab that
	// closes should never turn into a half-stopped server.
	ctx, cancel := contextWithTimeout(r, 10*time.Minute)
	defer cancel()
	if err := s.deps.Commands.Stop(ctx, s.actor(r), req.Force, req.Confirm); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"state": s.deps.Supervisor.Snapshot().State})
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 15*time.Minute)
	defer cancel()
	if err := s.deps.Commands.Restart(ctx, s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"state": s.deps.Supervisor.Snapshot().State})
}

type commandRequest struct {
	Command string `json:"command"`
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	if !s.decode(w, r, &req) {
		return
	}
	if err := s.deps.Commands.Command(s.actor(r), req.Command); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"sent": true, "console_seq": s.deps.Supervisor.Snapshot().ConsoleSeq})
}

type eulaRequest struct {
	Accepted bool   `json:"accepted"`
	Confirm  string `json:"confirm"`
}

func (s *Server) handleEULA(w http.ResponseWriter, r *http.Request) {
	var req eulaRequest
	if !s.decode(w, r, &req) {
		return
	}
	if err := s.deps.Commands.AcceptEULA(s.actor(r), req.Accepted, req.Confirm); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"eula_accepted": s.deps.Settings.Get().EULAAccepted})
}

type maintenanceRequest struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) handleMaintenance(w http.ResponseWriter, r *http.Request) {
	var req maintenanceRequest
	if !s.decode(w, r, &req) {
		return
	}
	if err := s.deps.Commands.SetMaintenance(s.actor(r), req.Enabled); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"maintenance_mode": s.deps.Settings.Get().MaintenanceMode})
}

// ---------------------------------------------------------------- updates ----

func (s *Server) handleServerVersions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 90*time.Second)
	defer cancel()
	s.ok(w, s.deps.Updates.Check(ctx, r.URL.Query().Get("version")))
}

func (s *Server) handleServerInstall(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 30*time.Minute)
	defer cancel()
	result, err := s.deps.Commands.InstallServerJar(ctx, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func (s *Server) handleFlavours(w http.ResponseWriter, r *http.Request) {
	s.ok(w, s.deps.Commands.FlavourStatus())
}

type flavourRequest struct {
	Flavour string `json:"flavour"`
	Confirm string `json:"confirm"`
}

func (s *Server) handleSwitchFlavour(w http.ResponseWriter, r *http.Request) {
	var req flavourRequest
	if !s.decode(w, r, &req) {
		return
	}
	status, err := s.deps.Commands.SwitchFlavour(s.actor(r), req.Flavour, req.Confirm)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, status)
}

type updateRequest struct {
	Version string `json:"version"`
	Build   int    `json:"build"`
	Confirm string `json:"confirm"`
}

func (s *Server) handleServerUpdate(w http.ResponseWriter, r *http.Request) {
	var req updateRequest
	if !s.decode(w, r, &req) {
		return
	}
	ctx, cancel := contextWithTimeout(r, 45*time.Minute)
	defer cancel()
	result, err := s.deps.Commands.InstallServerUpdate(ctx, s.actor(r), req.Version, req.Build, req.Confirm)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

// --------------------------------------------------------------- settings ----

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	s.ok(w, map[string]any{
		"settings":            s.deps.Settings.Get(),
		"options":             s.redactedOptions(),
		"jvm_profiles":        []string{"low_power", "balanced", "performance", "custom"},
		"generation_profiles": []string{"gentle", "balanced", "maximum"},
	})
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	var patch commands.SettingsPatch
	if !s.decode(w, r, &patch) {
		return
	}
	settings, err := s.deps.Commands.UpdateSettings(s.actor(r), patch)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"settings": settings})
}

// redactedOptions never exposes the MQTT password.
func (s *Server) redactedOptions() map[string]any {
	o := s.deps.Options
	mqttSecret := ""
	if o.MQTTPassword != "" {
		mqttSecret = "***"
	}
	return map[string]any{
		"server_port":           o.ServerPort,
		"jvm_flags_profile":     o.JVMFlagsProfile,
		"mqtt_enabled":          o.MQTTEnabled,
		"mqtt_host":             o.MQTTHost,
		"mqtt_port":             o.MQTTPort,
		"mqtt_username":         o.MQTTUsername,
		"mqtt_password":         mqttSecret,
		"mqtt_discovery_prefix": o.MQTTDiscoveryPrefix,
		"chunky_source":         o.ChunkySource,
		"allow_direct_access":   o.AllowDirectAccess,
		"log_level":             o.LogLevel,
	}
}
