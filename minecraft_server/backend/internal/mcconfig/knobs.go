package mcconfig

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// Knob is a single named setting the UI and the presets can read and write
// without knowing which file it lives in or how that file is formatted.
//
// Only settings that genuinely matter on a Raspberry Pi are exposed here. Every
// value has a documented source; nothing is included because a forum post
// claimed it helps.
type Knob struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Group       string   `json:"group"`
	File        string   `json:"file"`
	Path        string   `json:"path"` // dotted YAML path, or the property key
	Type        string   `json:"type"` // int | float | bool | string | enum
	Min         float64  `json:"min,omitempty"`
	Max         float64  `json:"max,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Unit        string   `json:"unit,omitempty"`
	Description string   `json:"description"`
	Restart     bool     `json:"restart_required"`
}

// KnobCatalog is the full set of managed settings.
func KnobCatalog() []Knob {
	return []Knob{
		// --- gameplay (server.properties) ---
		{Key: "motd", Label: "MOTD", Group: "gameplay", File: "server.properties", Path: "motd", Type: "string",
			Description: "Message shown in the server list", Restart: true},
		{Key: "gamemode", Label: "Game mode", Group: "gameplay", File: "server.properties", Path: "gamemode", Type: "enum",
			Enum: []string{"survival", "creative", "adventure", "spectator"}, Description: "Default game mode for new players", Restart: true},
		{Key: "difficulty", Label: "Difficulty", Group: "gameplay", File: "server.properties", Path: "difficulty", Type: "enum",
			Enum: []string{"peaceful", "easy", "normal", "hard"}, Description: "World difficulty", Restart: true},
		{Key: "max_players", Label: "Maximum players", Group: "gameplay", File: "server.properties", Path: "max-players",
			Type: "int", Min: 1, Max: 100, Description: "Player slots. Each online player costs memory and CPU", Restart: true},
		{Key: "online_mode", Label: "Online mode", Group: "gameplay", File: "server.properties", Path: "online-mode",
			Type: "bool", Description: "Verify players against Mojang authentication. Keep enabled unless you know why not", Restart: true},
		{Key: "whitelist", Label: "Whitelist", Group: "gameplay", File: "server.properties", Path: "white-list",
			Type: "bool", Description: "Only players on the whitelist may join", Restart: false},
		{Key: "pvp", Label: "PvP", Group: "gameplay", File: "server.properties", Path: "pvp", Type: "bool",
			Description: "Allow players to damage each other", Restart: true},
		{Key: "command_blocks", Label: "Command blocks", Group: "gameplay", File: "server.properties",
			Path: "enable-command-block", Type: "bool", Description: "Enable command blocks", Restart: true},
		{Key: "spawn_protection", Label: "Spawn protection", Group: "gameplay", File: "server.properties",
			Path: "spawn-protection", Type: "int", Min: 0, Max: 1000, Unit: "blocks",
			Description: "Radius around spawn that non-operators cannot build in", Restart: true},
		{Key: "player_idle_timeout", Label: "Player idle timeout", Group: "gameplay", File: "server.properties",
			Path: "player-idle-timeout", Type: "int", Min: 0, Max: 1440, Unit: "minutes",
			Description: "Kick idle players after this many minutes (0 disables)", Restart: true},

		// --- performance (the two that dominate CPU and memory on a Pi) ---
		{Key: "view_distance", Label: "View distance", Group: "performance", File: "server.properties",
			Path: "view-distance", Type: "int", Min: 3, Max: 32, Unit: "chunks",
			Description: "Chunks sent to players. The single most expensive setting on a Raspberry Pi", Restart: true},
		{Key: "simulation_distance", Label: "Simulation distance", Group: "performance", File: "server.properties",
			Path: "simulation-distance", Type: "int", Min: 3, Max: 32, Unit: "chunks",
			Description: "Chunks that tick entities and redstone. Keep at or below the view distance", Restart: true},
		{Key: "network_compression_threshold", Label: "Network compression threshold", Group: "performance",
			File: "server.properties", Path: "network-compression-threshold", Type: "int", Min: -1, Max: 1500, Unit: "bytes",
			Description: "Packets larger than this are compressed. Higher values trade bandwidth for CPU", Restart: true},
		{Key: "sync_chunk_writes", Label: "Synchronous chunk writes", Group: "performance", File: "server.properties",
			Path: "sync-chunk-writes", Type: "bool",
			Description: "Off is much faster on SD cards and SSDs; the add-on's own backups provide the safety net", Restart: true},

		// --- spigot.yml: entity activation ranges ---
		{Key: "activation_range_animals", Label: "Activation range: animals", Group: "entities", File: "spigot.yml",
			Path: "world-settings.default.entity-activation-range.animals", Type: "int", Min: 8, Max: 64, Unit: "blocks",
			Description: "Animals further away than this stop ticking", Restart: true},
		{Key: "activation_range_monsters", Label: "Activation range: monsters", Group: "entities", File: "spigot.yml",
			Path: "world-settings.default.entity-activation-range.monsters", Type: "int", Min: 8, Max: 64, Unit: "blocks",
			Description: "Monsters further away than this stop ticking", Restart: true},
		{Key: "activation_range_misc", Label: "Activation range: misc", Group: "entities", File: "spigot.yml",
			Path: "world-settings.default.entity-activation-range.misc", Type: "int", Min: 4, Max: 64, Unit: "blocks",
			Description: "Item frames, boats and similar entities", Restart: true},
		{Key: "mob_spawn_range", Label: "Mob spawn range", Group: "entities", File: "spigot.yml",
			Path: "world-settings.default.mob-spawn-range", Type: "int", Min: 2, Max: 8, Unit: "chunks",
			Description: "How far from a player mobs may spawn", Restart: true},

		// --- bukkit.yml: spawn limits and autosave ---
		{Key: "spawn_limit_monsters", Label: "Spawn limit: monsters", Group: "entities", File: "bukkit.yml",
			Path: "spawn-limits.monsters", Type: "int", Min: 5, Max: 200,
			Description: "Maximum monsters per player-loaded area", Restart: true},
		{Key: "spawn_limit_animals", Label: "Spawn limit: animals", Group: "entities", File: "bukkit.yml",
			Path: "spawn-limits.animals", Type: "int", Min: 2, Max: 100, Description: "Maximum animals", Restart: true},
		{Key: "spawn_limit_ambient", Label: "Spawn limit: ambient", Group: "entities", File: "bukkit.yml",
			Path: "spawn-limits.ambient", Type: "int", Min: 0, Max: 50, Description: "Maximum ambient mobs (bats)", Restart: true},
		{Key: "autosave_ticks", Label: "Autosave interval", Group: "storage", File: "bukkit.yml",
			Path: "ticks-per.autosave", Type: "int", Min: 0, Max: 72000, Unit: "ticks",
			Description: "Ticks between autosaves (6000 = 5 minutes). Paper also saves incrementally", Restart: true},

		// --- paper-world-defaults.yml: chunk rates ---
		{Key: "chunk_send_rate", Label: "Chunk send rate", Group: "chunks", File: "paper-world-defaults.yml",
			Path: "chunk-loading-basic.player-max-chunk-send-rate", Type: "float", Min: -1, Max: 200, Unit: "chunks/s",
			Description: "Chunks sent to a player per second. Lowering this smooths joins on a Pi", Restart: true},
		{Key: "chunk_load_rate", Label: "Chunk load rate", Group: "chunks", File: "paper-world-defaults.yml",
			Path: "chunk-loading-basic.player-max-chunk-load-rate", Type: "float", Min: -1, Max: 200, Unit: "chunks/s",
			Description: "Chunks generated or loaded for a player per second", Restart: true},
		{Key: "max_auto_save_chunks_per_tick", Label: "Autosave chunks per tick", Group: "storage",
			File: "paper-world-defaults.yml", Path: "chunks.max-auto-save-chunks-per-tick", Type: "int", Min: 1, Max: 96,
			Description: "How much saving work Paper does per tick", Restart: true},
		{Key: "delay_chunk_unloads_by", Label: "Delay chunk unloads by", Group: "chunks",
			File: "paper-world-defaults.yml", Path: "chunks.delay-chunk-unloads-by", Type: "string",
			Description: "Keep recently used chunks in memory (for example 10s). Costs memory, saves regeneration", Restart: true},

		// --- paper-global.yml: concurrent chunk operations ---
		{Key: "max_concurrent_chunk_loads", Label: "Max concurrent chunk loads", Group: "chunks",
			File: "paper-global.yml", Path: "chunk-loading-advanced.player-max-concurrent-chunk-loads", Type: "float",
			Min: 0, Max: 64, Description: "0 lets Paper decide. Lower values reduce I/O bursts on slow storage", Restart: true},
		{Key: "max_concurrent_chunk_generates", Label: "Max concurrent chunk generates", Group: "chunks",
			File: "paper-global.yml", Path: "chunk-loading-advanced.player-max-concurrent-chunk-generates", Type: "float",
			Min: 0, Max: 64, Description: "Caps live world generation, which is the most expensive work on a Pi", Restart: true},
	}
}

// btaKnobCatalog is the Better than Adventure! set. It is a separate list rather
// than a filtered one: BTA is a Beta 1.7.3 fork, so even the settings that exist
// in both have different names ("default-gamemode") and different types
// (difficulty is a number), and most of the Paper tuning simply has no
// counterpart.
func btaKnobCatalog() []Knob {
	return []Knob{
		{Key: "motd", Label: "MOTD", Group: "gameplay", File: "server.properties", Path: "motd", Type: "string",
			Description: "Message shown in the server list", Restart: true},
		{Key: "gamemode", Label: "Game mode", Group: "gameplay", File: "server.properties", Path: "default-gamemode",
			Type: "enum", Enum: []string{"survival", "creative"}, Description: "Default game mode for new players", Restart: true},
		{Key: "difficulty", Label: "Difficulty", Group: "gameplay", File: "server.properties", Path: "difficulty",
			Type: "int", Min: 0, Max: 3, Description: "0 peaceful, 1 easy, 2 normal, 3 hard", Restart: true},
		{Key: "max_players", Label: "Maximum players", Group: "gameplay", File: "server.properties", Path: "max-players",
			Type: "int", Min: 1, Max: 100, Description: "Player slots", Restart: true},
		{Key: "online_mode", Label: "Online mode", Group: "gameplay", File: "server.properties", Path: "online-mode",
			Type: "bool", Description: "Verify players against Mojang authentication", Restart: true},
		{Key: "whitelist", Label: "Whitelist", Group: "gameplay", File: "server.properties", Path: "white-list",
			Type: "bool", Description: "Only players on the whitelist may join", Restart: true},
		{Key: "pvp", Label: "PvP", Group: "gameplay", File: "server.properties", Path: "pvp", Type: "bool",
			Description: "Allow players to damage each other", Restart: true},
		{Key: "spawn_protection", Label: "Spawn protection", Group: "gameplay", File: "server.properties",
			Path: "spawn-protection", Type: "int", Min: 0, Max: 1000, Unit: "blocks",
			Description: "Radius around spawn that non-operators cannot build in", Restart: true},
		{Key: "view_distance", Label: "View distance", Group: "performance", File: "server.properties",
			Path: "view-distance", Type: "int", Min: 3, Max: 15, Unit: "chunks",
			Description: "Chunks sent to players. A Beta-era server ticks all of them on one thread, so this is the setting that matters", Restart: true},
		{Key: "spawn_animals", Label: "Spawn animals", Group: "entities", File: "server.properties",
			Path: "spawn-animals", Type: "bool", Description: "Allow animals to spawn", Restart: true},
		{Key: "spawn_monsters", Label: "Spawn monsters", Group: "entities", File: "server.properties",
			Path: "spawn-monsters", Type: "bool", Description: "Allow monsters to spawn", Restart: true},
		{Key: "summon_limit", Label: "Summon limit", Group: "entities", File: "server.properties",
			Path: "summon-limit", Type: "int", Min: 1, Max: 500, Description: "Maximum entities a single summon may create", Restart: true},
		{Key: "allow_nether", Label: "Allow the Nether", Group: "gameplay", File: "server.properties",
			Path: "allow-nether", Type: "bool", Description: "Enable the Nether dimension", Restart: true},
		{Key: "allow_paradise", Label: "Allow Paradise", Group: "gameplay", File: "server.properties",
			Path: "allow-paradise", Type: "bool", Description: "Enable the Paradise dimension", Restart: true},
		{Key: "sleep_percentage", Label: "Sleep percentage", Group: "gameplay", File: "server.properties",
			Path: "sleep-percentage", Type: "int", Min: 1, Max: 100, Unit: "%",
			Description: "Share of players that must sleep to skip the night", Restart: true},
	}
}

// catalog is the knob set of the active flavour.
func (m *Manager) catalog() []Knob {
	if m.backend != nil && m.backend.Name() == "bta" {
		return btaKnobCatalog()
	}
	return KnobCatalog()
}

// CatalogFor returns the knob set of a backend, for the API and the presets.
func CatalogFor(name string) []Knob {
	if name == "bta" {
		return btaKnobCatalog()
	}
	return KnobCatalog()
}

// KnobByKey indexes the catalog.
func KnobByKey() map[string]Knob { return byKey(KnobCatalog()) }

// KnobsByKeyFor indexes the catalog of one flavour.
func KnobsByKeyFor(name string) map[string]Knob { return byKey(CatalogFor(name)) }

func byKey(knobs []Knob) map[string]Knob {
	out := make(map[string]Knob, len(knobs))
	for _, k := range knobs {
		out[k.Key] = k
	}
	return out
}

// BackendName is the flavour the manager is configured for.
func (m *Manager) BackendName() string {
	if m.backend == nil {
		return ""
	}
	return m.backend.Name()
}

// Catalog is the active flavour's knob set.
func (m *Manager) Catalog() []Knob { return m.catalog() }

// KnobValue is a knob plus its current value.
type KnobValue struct {
	Knob
	Value  any    `json:"value"`
	Source string `json:"source"` // file | default | missing
}

// Knobs reads the current value of every knob. Files Paper has not generated yet
// report source "missing" instead of failing: the server writes them on first
// start.
func (m *Manager) Knobs() ([]KnobValue, error) {
	props, err := m.Properties()
	if err != nil {
		return nil, err
	}
	yamlCache := map[string][]byte{}

	catalog := m.catalog()
	out := make([]KnobValue, 0, len(catalog))
	for _, knob := range catalog {
		kv := KnobValue{Knob: knob, Source: "missing"}
		if knob.File == "server.properties" {
			if raw, ok := props.Get(knob.Path); ok {
				kv.Value = coerce(knob, raw)
				kv.Source = "file"
			}
			out = append(out, kv)
			continue
		}
		raw, ok := yamlCache[knob.File]
		if !ok {
			_, content, err := m.Read(knob.File)
			if err != nil {
				out = append(out, kv)
				continue
			}
			raw = []byte(content)
			yamlCache[knob.File] = raw
		}
		value, found, err := GetYAMLPath(raw, knob.Path)
		if err == nil && found {
			kv.Value = value
			kv.Source = "file"
		}
		out = append(out, kv)
	}
	return out, nil
}

// KnobValues returns the knob values as a flat map, used by the preset diff.
func (m *Manager) KnobValues() (map[string]any, error) {
	knobs, err := m.Knobs()
	if err != nil {
		return nil, err
	}
	out := make(map[string]any, len(knobs))
	for _, k := range knobs {
		if k.Source == "file" {
			out[k.Key] = k.Value
		}
	}
	return out, nil
}

// SetKnobs validates and applies a batch of knob changes. Changes are grouped per
// file so each file is written exactly once, atomically, with one snapshot.
func (m *Manager) SetKnobs(changes map[string]any, actor string) ([]WriteResult, error) {
	catalog := byKey(m.catalog())
	byFile := map[string]map[string]any{}
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		knob, ok := catalog[key]
		if !ok {
			return nil, fmt.Errorf("unknown setting %q", key)
		}
		value, err := validateKnobValue(knob, changes[key])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", knob.Label, err)
		}
		if byFile[knob.File] == nil {
			byFile[knob.File] = map[string]any{}
		}
		byFile[knob.File][knob.Path] = value
	}

	files := make([]string, 0, len(byFile))
	for f := range byFile {
		files = append(files, f)
	}
	sort.Strings(files)

	results := make([]WriteResult, 0, len(files))
	for _, file := range files {
		if file == "server.properties" {
			stringChanges := map[string]string{}
			for path, value := range byFile[file] {
				stringChanges[path] = fmt.Sprint(value)
			}
			res, err := m.SetProperties(stringChanges, actor)
			if err != nil {
				return results, err
			}
			results = append(results, res)
			continue
		}
		res, err := m.setYAMLKnobs(file, byFile[file], actor)
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	return results, nil
}

func (m *Manager) setYAMLKnobs(file string, changes map[string]any, actor string) (WriteResult, error) {
	_, content, err := m.Read(file)
	if err != nil {
		return WriteResult{}, err
	}
	raw := []byte(content)
	paths := make([]string, 0, len(changes))
	for p := range changes {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		raw, err = SetYAMLPath(raw, path, changes[path])
		if err != nil {
			return WriteResult{}, fmt.Errorf("%s: %w", path, err)
		}
	}
	return m.Write(file, string(raw), actor)
}

func validateKnobValue(knob Knob, value any) (any, error) {
	switch knob.Type {
	case "int":
		n, err := toFloat(value)
		if err != nil {
			return nil, err
		}
		if n != float64(int64(n)) {
			return nil, fmt.Errorf("must be a whole number")
		}
		if knob.Max > knob.Min && (n < knob.Min || n > knob.Max) {
			return nil, fmt.Errorf("must be between %g and %g", knob.Min, knob.Max)
		}
		return int(n), nil
	case "float":
		n, err := toFloat(value)
		if err != nil {
			return nil, err
		}
		if knob.Max > knob.Min && (n < knob.Min || n > knob.Max) {
			return nil, fmt.Errorf("must be between %g and %g", knob.Min, knob.Max)
		}
		return n, nil
	case "bool":
		switch v := value.(type) {
		case bool:
			return v, nil
		case string:
			b, err := strconv.ParseBool(v)
			if err != nil {
				return nil, fmt.Errorf("must be true or false")
			}
			return b, nil
		default:
			return nil, fmt.Errorf("must be true or false")
		}
	case "enum":
		s, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("must be one of %s", strings.Join(knob.Enum, ", "))
		}
		for _, allowed := range knob.Enum {
			if s == allowed {
				return s, nil
			}
		}
		return nil, fmt.Errorf("must be one of %s", strings.Join(knob.Enum, ", "))
	case "string":
		s, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("must be text")
		}
		if len(s) > 256 {
			return nil, fmt.Errorf("must be at most 256 characters")
		}
		if strings.ContainsAny(s, "\n\r\x00") {
			return nil, fmt.Errorf("must not contain line breaks")
		}
		return s, nil
	default:
		return nil, fmt.Errorf("unsupported setting type %q", knob.Type)
	}
}

func toFloat(value any) (float64, error) {
	switch v := value.(type) {
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, fmt.Errorf("must be a number")
		}
		return n, nil
	default:
		return 0, fmt.Errorf("must be a number")
	}
}

func coerce(knob Knob, raw string) any {
	switch knob.Type {
	case "int":
		if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
			return n
		}
	case "float":
		if n, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil {
			return n
		}
	case "bool":
		return strings.EqualFold(strings.TrimSpace(raw), "true")
	}
	return raw
}

// ------------------------------------------------------------ ops/whitelist --

// EnsureListFiles creates the operator and whitelist files the server has not
// written yet, so the editor never shows a missing file. The empty form differs
// per flavour: a modern server keeps them as JSON arrays, a Beta-era one as an
// empty text file with one name per line.
func (m *Manager) EnsureListFiles() error {
	for _, spec := range m.backend.ConfigFiles() {
		if !spec.CreateIfMissing {
			continue
		}
		var empty []byte
		switch spec.Format {
		case "json":
			empty = []byte("[]\n")
		case "lines":
			empty = []byte{}
		default:
			continue
		}
		_, full, err := m.resolve(spec.Name)
		if err != nil {
			return err
		}
		if _, err := os.Stat(full); err == nil {
			continue
		}
		if err := atomicfs.WriteFile(full, empty, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// ApplyRuntimeToggle applies settings that Minecraft can change live, so simple
// switches do not need a restart. Everything else is reported as
// restart_required by Write.
func (m *Manager) ApplyRuntimeToggle(key string, value any, send func(string) error) bool {
	if send == nil {
		return false
	}
	switch key {
	case "whitelist":
		enabled, ok := value.(bool)
		if !ok {
			return false
		}
		cmd := "whitelist off"
		if enabled {
			cmd = "whitelist on"
		}
		return send(cmd) == nil
	case "difficulty":
		s, ok := value.(string)
		if !ok {
			return false
		}
		return send("difficulty "+s) == nil
	default:
		return false
	}
}

// AuditKnobChange records a structured settings change.
func (m *Manager) AuditKnobChange(actor string, changes map[string]any) {
	if len(changes) == 0 {
		return
	}
	keys := make([]string, 0, len(changes))
	for k, v := range changes {
		keys = append(keys, fmt.Sprintf("%s=%v", k, v))
	}
	sort.Strings(keys)
	_ = m.store.Audit(store.AuditEntry{
		Actor: actor, Action: "config.settings", Target: "knobs",
		Detail: strings.Join(keys, " "),
	})
	m.bus.Publish(events.TypeConfigChanged, map[string]any{"knobs": len(changes)})
}

// Confine is re-exported for tests that need the same path rules.
func Confine(root, rel string) (string, error) { return appcfg.Confine(root, rel) }
