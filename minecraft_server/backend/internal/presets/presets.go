// Package presets applies reusable configuration overlays.
//
// A preset is a set of named settings, never a whole file. Applying one therefore
// never discards a value the preset does not mention, and the user always sees a
// diff of exactly what will change before anything is written.
package presets

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

var ErrNotFound = errors.New("preset not found")

// Settings is the controller-side part of a preset. Pointers distinguish "not
// mentioned" from "set to zero".
type Settings struct {
	MemoryMinMB     *int    `json:"memory_min_mb,omitempty"`
	MemoryMaxMB     *int    `json:"memory_max_mb,omitempty"`
	JVMFlagsProfile *string `json:"jvm_flags_profile,omitempty"`
	MaintenanceMode *bool   `json:"maintenance_mode,omitempty"`
}

type Preset struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	BuiltIn     bool           `json:"built_in"`
	Knobs       map[string]any `json:"knobs"`
	Settings    Settings       `json:"settings"`
}

// Change is one line of the diff shown before applying.
type Change struct {
	Scope           string `json:"scope"` // knob | setting
	Key             string `json:"key"`
	Label           string `json:"label"`
	File            string `json:"file,omitempty"`
	Current         any    `json:"current"`
	New             any    `json:"new"`
	RestartRequired bool   `json:"restart_required"`
	// UserOverride marks values the user changed by hand after the last preset
	// was applied. They are kept unless the caller asks to override them.
	UserOverride bool `json:"user_override"`
}

type Diff struct {
	PresetID        string   `json:"preset_id"`
	Changes         []Change `json:"changes"`
	Unchanged       int      `json:"unchanged"`
	RestartRequired bool     `json:"restart_required"`
	Overrides       int      `json:"overrides"`
}

type Manager struct {
	paths     appcfg.Paths
	assetsDir string
	config    *mcconfig.Manager
	settings  *appcfg.Store
	store     *store.Store
	bus       *events.Bus
	log       *slog.Logger
}

func NewManager(paths appcfg.Paths, assetsDir string, cfg *mcconfig.Manager, settings *appcfg.Store,
	st *store.Store, bus *events.Bus, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	return &Manager{
		paths: paths, assetsDir: assetsDir, config: cfg, settings: settings,
		store: st, bus: bus, log: log.With("component", "presets"),
	}
}

// List returns built-in presets first, then user presets. A user preset with the
// same id as a built-in one replaces it, which is how a user customises a
// built-in without losing the ability to reset by deleting their copy.
func (m *Manager) List() ([]Preset, error) {
	byID := map[string]Preset{}
	order := []string{}

	builtinDir := filepath.Join(m.assetsDir, "presets")
	for _, p := range m.loadDir(builtinDir, true) {
		if _, seen := byID[p.ID]; !seen {
			order = append(order, p.ID)
		}
		byID[p.ID] = p
	}
	for _, p := range m.loadDir(m.paths.Presets(), false) {
		if _, seen := byID[p.ID]; !seen {
			order = append(order, p.ID)
		}
		byID[p.ID] = p
	}
	sort.Strings(order)
	out := make([]Preset, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out, nil
}

func (m *Manager) loadDir(dir string, builtIn bool) []Preset {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Preset
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			m.log.Warn("could not read preset", "file", e.Name(), "error", err)
			continue
		}
		var p Preset
		if err := json.Unmarshal(raw, &p); err != nil {
			m.log.Warn("invalid preset file", "file", e.Name(), "error", err)
			continue
		}
		if p.ID == "" {
			p.ID = strings.TrimSuffix(e.Name(), ".json")
		}
		if err := atomicfs.SafeName(p.ID); err != nil {
			m.log.Warn("preset id rejected", "id", p.ID, "error", err)
			continue
		}
		p.BuiltIn = builtIn
		out = append(out, p)
	}
	return out
}

func (m *Manager) Get(id string) (Preset, error) {
	all, err := m.List()
	if err != nil {
		return Preset{}, err
	}
	for _, p := range all {
		if p.ID == id {
			return p, nil
		}
	}
	return Preset{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}

// catalog is the knob set of the flavour in use; a preset can only name settings
// that flavour actually has.
func (m *Manager) catalog() map[string]mcconfig.Knob {
	return mcconfig.KnobsByKeyFor(m.config.BackendName())
}

// Save stores a user preset. Built-in ids may be shadowed deliberately.
func (m *Manager) Save(p Preset, actor string) (Preset, error) {
	if err := atomicfs.SafeName(p.ID); err != nil {
		return Preset{}, fmt.Errorf("invalid preset id: %w", err)
	}
	if p.Name == "" {
		p.Name = p.ID
	}
	catalog := m.catalog()
	for key := range p.Knobs {
		if _, ok := catalog[key]; !ok {
			return Preset{}, fmt.Errorf("unknown setting %q in preset", key)
		}
	}
	p.BuiltIn = false
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return Preset{}, err
	}
	path, err := appcfg.Confine(m.paths.Presets(), p.ID+".json")
	if err != nil {
		return Preset{}, err
	}
	if err := atomicfs.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return Preset{}, err
	}
	_ = m.store.Audit(store.AuditEntry{Actor: actor, Action: "preset.save", Target: p.ID,
		Detail: fmt.Sprintf("knobs=%d", len(p.Knobs))})
	return p, nil
}

// Delete removes a user preset. Built-in presets cannot be deleted, only shadowed.
func (m *Manager) Delete(id, actor string) error {
	path, err := appcfg.Confine(m.paths.Presets(), id+".json")
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return err
	}
	_ = m.store.Audit(store.AuditEntry{Actor: actor, Action: "preset.delete", Target: id})
	return nil
}

// Diff compares a preset against the live configuration.
func (m *Manager) Diff(id string) (Diff, error) {
	preset, err := m.Get(id)
	if err != nil {
		return Diff{}, err
	}
	current, err := m.config.KnobValues()
	if err != nil {
		return Diff{}, err
	}
	catalog := m.catalog()
	settings := m.settings.Get()
	overrides := settings.PresetOverrides["knobs"]

	out := Diff{PresetID: id}
	keys := make([]string, 0, len(preset.Knobs))
	for k := range preset.Knobs {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		knob, ok := catalog[key]
		if !ok {
			continue
		}
		newValue := preset.Knobs[key]
		currentValue := current[key]
		if sameValue(currentValue, newValue) {
			out.Unchanged++
			continue
		}
		change := Change{
			Scope: "knob", Key: key, Label: knob.Label, File: knob.File,
			Current: currentValue, New: newValue, RestartRequired: knob.Restart,
		}
		if _, isOverride := overrides[key]; isOverride {
			change.UserOverride = true
			out.Overrides++
		}
		if knob.Restart {
			out.RestartRequired = true
		}
		out.Changes = append(out.Changes, change)
	}

	// Controller settings.
	addSetting := func(key, label string, current, next any, restart bool) {
		if sameValue(current, next) {
			out.Unchanged++
			return
		}
		out.Changes = append(out.Changes, Change{
			Scope: "setting", Key: key, Label: label, Current: current, New: next, RestartRequired: restart,
		})
		if restart {
			out.RestartRequired = true
		}
	}
	if preset.Settings.MemoryMinMB != nil {
		addSetting("memory_min_mb", "Minimum heap (MB)", settings.MemoryMinMB, *preset.Settings.MemoryMinMB, true)
	}
	if preset.Settings.MemoryMaxMB != nil {
		addSetting("memory_max_mb", "Maximum heap (MB)", settings.MemoryMaxMB, *preset.Settings.MemoryMaxMB, true)
	}
	if preset.Settings.JVMFlagsProfile != nil {
		addSetting("jvm_flags_profile", "JVM flag profile", settings.JVMFlagsProfile, *preset.Settings.JVMFlagsProfile, true)
	}
	if preset.Settings.MaintenanceMode != nil {
		addSetting("maintenance_mode", "Maintenance mode", settings.MaintenanceMode, *preset.Settings.MaintenanceMode, false)
	}
	return out, nil
}

// ApplyResult reports what an apply actually did.
type ApplyResult struct {
	PresetID        string   `json:"preset_id"`
	Applied         []Change `json:"applied"`
	Skipped         []Change `json:"skipped"`
	RestartRequired bool     `json:"restart_required"`
}

// Apply writes the preset. User overrides are preserved unless overrideUser is
// true, so a preset can never silently undo a deliberate manual change.
func (m *Manager) Apply(id, actor string, overrideUser bool) (ApplyResult, error) {
	diff, err := m.Diff(id)
	if err != nil {
		return ApplyResult{}, err
	}
	result := ApplyResult{PresetID: id}
	knobChanges := map[string]any{}

	for _, change := range diff.Changes {
		if change.UserOverride && !overrideUser {
			result.Skipped = append(result.Skipped, change)
			continue
		}
		if change.Scope == "knob" {
			knobChanges[change.Key] = change.New
		}
		result.Applied = append(result.Applied, change)
		if change.RestartRequired {
			result.RestartRequired = true
		}
	}

	if len(knobChanges) > 0 {
		if _, err := m.config.SetKnobs(knobChanges, actor); err != nil {
			return result, err
		}
	}

	preset, err := m.Get(id)
	if err != nil {
		return result, err
	}
	if _, err := m.settings.Update(func(s *appcfg.Settings) {
		if preset.Settings.MemoryMinMB != nil {
			s.MemoryMinMB = *preset.Settings.MemoryMinMB
		}
		if preset.Settings.MemoryMaxMB != nil {
			s.MemoryMaxMB = *preset.Settings.MemoryMaxMB
		}
		if preset.Settings.JVMFlagsProfile != nil {
			s.JVMFlagsProfile = *preset.Settings.JVMFlagsProfile
		}
		if preset.Settings.MaintenanceMode != nil {
			s.MaintenanceMode = *preset.Settings.MaintenanceMode
		}
		s.ActivePreset = id
		if overrideUser {
			// The user asked the preset to win, so the override list is cleared.
			delete(s.PresetOverrides, "knobs")
		} else {
			// Values the preset applied are no longer overrides.
			if overrides := s.PresetOverrides["knobs"]; overrides != nil {
				for key := range knobChanges {
					delete(overrides, key)
				}
			}
		}
	}); err != nil {
		return result, err
	}

	_ = m.store.Audit(store.AuditEntry{Actor: actor, Action: "preset.apply", Target: id,
		Detail: fmt.Sprintf("applied=%d skipped=%d restart_required=%t",
			len(result.Applied), len(result.Skipped), result.RestartRequired)})
	m.bus.Publish(events.TypeSettingsChanged, map[string]any{"preset": id})
	return result, nil
}

// RecordOverrides is called when the user edits knobs by hand so a later preset
// application can leave those values alone.
func (m *Manager) RecordOverrides(changes map[string]any) {
	if len(changes) == 0 {
		return
	}
	_, _ = m.settings.Update(func(s *appcfg.Settings) {
		if s.PresetOverrides == nil {
			s.PresetOverrides = map[string]map[string]string{}
		}
		if s.PresetOverrides["knobs"] == nil {
			s.PresetOverrides["knobs"] = map[string]string{}
		}
		for key, value := range changes {
			s.PresetOverrides["knobs"][key] = fmt.Sprint(value)
		}
	})
}

// ClearOverrides forgets the manual-change list.
func (m *Manager) ClearOverrides() {
	_, _ = m.settings.Update(func(s *appcfg.Settings) {
		delete(s.PresetOverrides, "knobs")
	})
}

// sameValue compares values that come from JSON (float64), YAML (int) and
// properties (string) without reporting spurious differences.
func sameValue(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return fmt.Sprint(normalizeNumber(a)) == fmt.Sprint(normalizeNumber(b))
}

func normalizeNumber(v any) any {
	switch n := v.(type) {
	case float64:
		if n == float64(int64(n)) {
			return int64(n)
		}
		return n
	case float32:
		return normalizeNumber(float64(n))
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	default:
		return v
	}
}
