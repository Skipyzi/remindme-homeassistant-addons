package appcfg

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
)

// Retention describes how many restic snapshots to keep per bucket.
type Retention struct {
	KeepLast    int `json:"keep_last"`
	KeepDaily   int `json:"keep_daily"`
	KeepWeekly  int `json:"keep_weekly"`
	KeepMonthly int `json:"keep_monthly"`
}

// GenThresholds are the values that pause a running generation job.
type GenThresholds struct {
	TPSBelow             float64 `json:"tps_below"`
	MSPTAbove            float64 `json:"mspt_above"`
	CPUTemperatureAboveC float64 `json:"cpu_temperature_above_c"`
	SystemCPUAbovePct    float64 `json:"system_cpu_above_percent"`
	DiskFreeBelowGB      float64 `json:"disk_free_below_gb"`
}

// GenResume are the recovery thresholds. They are deliberately stricter than the
// pause thresholds so a job cannot oscillate.
type GenResume struct {
	TPSAbove             float64 `json:"tps_above"`
	CPUTemperatureBelowC float64 `json:"cpu_temperature_below_c"`
	SystemCPUBelowPct    float64 `json:"system_cpu_below_percent"`
}

type AllowedHours struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

// GenerationPolicy is the safety envelope for terrain pre-generation.
type GenerationPolicy struct {
	OnlyWhenNoPlayers       bool          `json:"only_when_no_players"`
	ResumeAfterEmptyMinutes int           `json:"resume_after_empty_minutes"`
	PauseWhen               GenThresholds `json:"pause_when"`
	ResumeWhen              GenResume     `json:"resume_when"`
	AllowedHours            AllowedHours  `json:"allowed_hours"`
	DimensionsSequential    bool          `json:"dimensions_sequential"`
	BackupBeforeStart       bool          `json:"backup_before_start"`
	BackupAfterCompletion   bool          `json:"backup_after_completion"`
	// MinDwellSeconds is the minimum time a job stays paused or running before
	// the guard loop is allowed to flip it again (hysteresis in the time
	// domain, on top of the separate pause/resume thresholds).
	MinDwellSeconds int `json:"min_dwell_seconds"`
	// SafetyMarginBlocks is how much further than the world border terrain is
	// generated.
	SafetyMarginBlocks int `json:"safety_margin_blocks"`
	// StorageSafetyMarginPercent inflates the storage estimate before the
	// free-space check.
	StorageSafetyMarginPercent int `json:"storage_safety_margin_percent"`
	// MaintenanceBlocksPlayers is used by the Maximum profile.
	MaintenanceBlocksPlayers bool `json:"maintenance_blocks_players"`
	RestartAfterCompletion   bool `json:"restart_after_completion"`
	StopAfterCompletion      bool `json:"stop_after_completion"`
}

func DefaultGenerationPolicy() GenerationPolicy {
	return GenerationPolicy{
		OnlyWhenNoPlayers:       true,
		ResumeAfterEmptyMinutes: 10,
		PauseWhen: GenThresholds{
			TPSBelow:             18.0,
			MSPTAbove:            45.0,
			CPUTemperatureAboveC: 78,
			SystemCPUAbovePct:    75,
			DiskFreeBelowGB:      15,
		},
		ResumeWhen: GenResume{
			TPSAbove:             19.0,
			CPUTemperatureBelowC: 70,
			SystemCPUBelowPct:    55,
		},
		AllowedHours:               AllowedHours{Enabled: true, Start: "00:30", End: "06:00"},
		DimensionsSequential:       true,
		BackupBeforeStart:          true,
		BackupAfterCompletion:      true,
		MinDwellSeconds:            120,
		SafetyMarginBlocks:         500,
		StorageSafetyMarginPercent: 30,
	}
}

// FlavourState is the per-flavour half of the settings. It is swapped in and out
// of the top-level fields when the flavour changes, so the rest of the
// controller never has to know a flavour is involved.
type FlavourState struct {
	ActiveWorld   string `json:"active_world"`
	ServerVersion string `json:"server_version"`
	ServerBuild   int    `json:"server_build"`
	EULAAccepted  bool   `json:"eula_accepted"`
	ActivePreset  string `json:"active_preset"`
}

// Settings is the controller state the user edits in the web UI. It is stored in
// /data/config/settings.json and survives add-on restarts and updates.
type Settings struct {
	MemoryMinMB        int    `json:"memory_min_mb"`
	MemoryMaxMB        int    `json:"memory_max_mb"`
	JVMFlagsProfile    string `json:"jvm_flags_profile"`
	JVMFlagsCustom     string `json:"jvm_flags_custom"`
	AutoRestartOnCrash bool   `json:"auto_restart_on_crash"`
	StopTimeoutSeconds int    `json:"stop_timeout_seconds"`
	StartOnBoot        bool   `json:"start_on_boot"`

	IdleShutdownMinutes int    `json:"idle_shutdown_minutes"`
	RestartSchedule     string `json:"restart_schedule"` // "" or HH:MM local time
	BackupSchedule      string `json:"backup_schedule"`  // "" or HH:MM local time

	BackupRetention        Retention `json:"backup_retention"`
	BackupVerifyAfterWrite bool      `json:"backup_verify_after_write"`
	BackupBeforeConfigEdit bool      `json:"backup_before_config_edit"`

	// Flavour is the server flavour in use ("paper", "bta"). Each flavour has its
	// own runtime directory, JAR, worlds and active-world setting, because their
	// world formats are mutually unreadable.
	Flavour string `json:"flavour"`
	// PerFlavour keeps the settings that only make sense for one flavour, so
	// switching back and forth does not lose the other one's active world or
	// installed version.
	PerFlavour map[string]FlavourState `json:"per_flavour"`

	ActiveWorld     string `json:"active_world"`
	EULAAccepted    bool   `json:"eula_accepted"`
	EULAAcceptedAt  string `json:"eula_accepted_at"`
	MaintenanceMode bool   `json:"maintenance_mode"`
	ActivePreset    string `json:"active_preset"`

	// PaperVersion and PaperBuild are the installed server version of the active
	// flavour. The names predate multi-flavour support and are kept so an
	// existing settings.json still loads.
	PaperVersion    string `json:"paper_version"`
	PaperBuild      int    `json:"paper_build"`
	ScheduledUpdate bool   `json:"scheduled_update"`
	// IncludePreReleases offers release candidates and other pre-release builds
	// in the version list. Off by default: a home server should not be steered
	// onto one by accident.
	IncludePreReleases bool `json:"include_pre_releases"`

	Generation GenerationPolicy `json:"generation"`
	// GenerationProfile is the profile new generation jobs default to, and what
	// the Home Assistant select entity controls.
	GenerationProfile string `json:"generation_profile"`

	// PresetOverrides records values the user changed after applying a preset so
	// re-applying a preset never silently reverts a deliberate change.
	PresetOverrides map[string]map[string]string `json:"preset_overrides"`
}

func defaultSettings(o Options) Settings {
	return Settings{
		MemoryMinMB:            o.MemoryMinMB,
		MemoryMaxMB:            o.MemoryMaxMB,
		JVMFlagsProfile:        o.JVMFlagsProfile,
		JVMFlagsCustom:         o.JVMFlagsCustom,
		AutoRestartOnCrash:     o.AutoRestartOnCrash,
		StopTimeoutSeconds:     o.StopTimeoutSeconds,
		StartOnBoot:            false,
		IdleShutdownMinutes:    0,
		BackupRetention:        Retention{KeepLast: 5, KeepDaily: 7, KeepWeekly: 4, KeepMonthly: 3},
		BackupVerifyAfterWrite: true,
		BackupBeforeConfigEdit: false,
		ActiveWorld:            "",
		Flavour:                o.Flavour,
		PerFlavour:             map[string]FlavourState{},
		PaperVersion:           o.PaperVersion,
		Generation:             DefaultGenerationPolicy(),
		GenerationProfile:      "gentle",
		PresetOverrides:        map[string]map[string]string{},
	}
}

// Store persists Settings. All mutations go through Update so writes are
// serialized and atomic.
type Store struct {
	mu   sync.RWMutex
	path string
	cur  Settings
}

func LoadSettings(path string, o Options) (*Store, error) {
	s := &Store{path: path, cur: defaultSettings(o)}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		// Unmarshal on top of the defaults so new fields get sane values after
		// an add-on update.
		if err := json.Unmarshal(raw, &s.cur); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	case os.IsNotExist(err):
		if err := s.persist(); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	if s.cur.PresetOverrides == nil {
		s.cur.PresetOverrides = map[string]map[string]string{}
	}
	s.normalize()
	return s, nil
}

func (s *Store) normalize() {
	if s.cur.Flavour == "" {
		s.cur.Flavour = DefaultFlavour
	}
	if s.cur.PerFlavour == nil {
		s.cur.PerFlavour = map[string]FlavourState{}
	}
	if s.cur.StopTimeoutSeconds < 15 {
		s.cur.StopTimeoutSeconds = 15
	}
	if s.cur.MemoryMaxMB < s.cur.MemoryMinMB {
		s.cur.MemoryMaxMB = s.cur.MemoryMinMB
	}
	if s.cur.Generation.MinDwellSeconds <= 0 {
		s.cur.Generation.MinDwellSeconds = 60
	}
}

func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur.clone()
}

// Update applies fn to a copy of the settings, validates and persists it.
func (s *Store) Update(fn func(*Settings)) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cur.clone()
	fn(&next)
	if err := next.Validate(); err != nil {
		return s.cur.clone(), err
	}
	prev := s.cur
	s.cur = next
	s.normalize()
	if err := s.persist(); err != nil {
		s.cur = prev
		return prev.clone(), err
	}
	return s.cur.clone(), nil
}

func (s *Store) persist() error {
	raw, err := json.MarshalIndent(s.cur, "", "  ")
	if err != nil {
		return err
	}
	return atomicfs.WriteFile(s.path, append(raw, '\n'), 0o644)
}

// SwitchFlavour parks the current flavour's state, restores the target's and
// makes it active. The caller has already stopped Minecraft and is holding the
// supervisor lease.
func (s *Store) SwitchFlavour(target string) (Settings, error) {
	if target == "" {
		return s.Get(), fmt.Errorf("a server flavour is required")
	}
	return s.Update(func(next *Settings) {
		if next.PerFlavour == nil {
			next.PerFlavour = map[string]FlavourState{}
		}
		current := next.Flavour
		if current == "" {
			current = DefaultFlavour
		}
		if current == target {
			return
		}
		next.PerFlavour[current] = FlavourState{
			ActiveWorld:   next.ActiveWorld,
			ServerVersion: next.PaperVersion,
			ServerBuild:   next.PaperBuild,
			EULAAccepted:  next.EULAAccepted,
			ActivePreset:  next.ActivePreset,
		}
		restored := next.PerFlavour[target]
		next.Flavour = target
		next.ActiveWorld = restored.ActiveWorld
		next.PaperVersion = restored.ServerVersion
		next.PaperBuild = restored.ServerBuild
		next.EULAAccepted = restored.EULAAccepted
		next.ActivePreset = restored.ActivePreset
		if !restored.EULAAccepted {
			next.EULAAcceptedAt = ""
		}
	})
}

func (s Settings) clone() Settings {
	out := s
	out.PerFlavour = make(map[string]FlavourState, len(s.PerFlavour))
	for name, state := range s.PerFlavour {
		out.PerFlavour[name] = state
	}
	out.PresetOverrides = make(map[string]map[string]string, len(s.PresetOverrides))
	for scope, kv := range s.PresetOverrides {
		m := make(map[string]string, len(kv))
		for k, v := range kv {
			m[k] = v
		}
		out.PresetOverrides[scope] = m
	}
	return out
}

func (s Settings) Validate() error {
	if s.MemoryMinMB < 512 {
		return fmt.Errorf("minimum heap must be at least 512 MB")
	}
	if s.MemoryMaxMB < s.MemoryMinMB {
		return fmt.Errorf("maximum heap must not be lower than the minimum heap")
	}
	if s.StopTimeoutSeconds < 15 || s.StopTimeoutSeconds > 900 {
		return fmt.Errorf("stop timeout must be between 15 and 900 seconds")
	}
	if s.IdleShutdownMinutes < 0 {
		return fmt.Errorf("idle shutdown must not be negative")
	}
	if s.JVMFlagsProfile == "custom" {
		if _, err := ValidateJavaFlags(s.JVMFlagsCustom); err != nil {
			return err
		}
	}
	if err := validateClock(s.RestartSchedule); err != nil {
		return fmt.Errorf("restart schedule: %w", err)
	}
	if err := validateClock(s.BackupSchedule); err != nil {
		return fmt.Errorf("backup schedule: %w", err)
	}
	if s.Generation.AllowedHours.Enabled {
		if err := validateClock(s.Generation.AllowedHours.Start); err != nil {
			return fmt.Errorf("generation allowed hours start: %w", err)
		}
		if err := validateClock(s.Generation.AllowedHours.End); err != nil {
			return fmt.Errorf("generation allowed hours end: %w", err)
		}
	}
	if s.Generation.ResumeWhen.TPSAbove < s.Generation.PauseWhen.TPSBelow {
		return fmt.Errorf("generation resume TPS must be at or above the pause TPS threshold")
	}
	if s.Generation.ResumeWhen.CPUTemperatureBelowC > s.Generation.PauseWhen.CPUTemperatureAboveC {
		return fmt.Errorf("generation resume temperature must be at or below the pause temperature")
	}
	if s.Generation.SafetyMarginBlocks < 0 {
		return fmt.Errorf("safety margin must not be negative")
	}
	return nil
}

func validateClock(v string) error {
	if v == "" {
		return nil
	}
	if _, err := time.Parse("15:04", v); err != nil {
		return fmt.Errorf("%q is not a HH:MM time", v)
	}
	return nil
}

// ClockToday resolves an HH:MM string against a reference day.
func ClockToday(ref time.Time, hhmm string) (time.Time, bool) {
	t, err := time.Parse("15:04", hhmm)
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(ref.Year(), ref.Month(), ref.Day(), t.Hour(), t.Minute(), 0, 0, ref.Location()), true
}

// WithinWindow reports whether now falls inside [start,end), correctly handling
// windows that wrap past midnight (00:30 - 06:00 does not wrap, 23:00 - 02:00
// does).
func WithinWindow(now time.Time, start, end string) bool {
	s, ok1 := ClockToday(now, start)
	e, ok2 := ClockToday(now, end)
	if !ok1 || !ok2 {
		return true
	}
	if s.Equal(e) {
		return true
	}
	if s.Before(e) {
		return !now.Before(s) && now.Before(e)
	}
	return !now.Before(s) || now.Before(e)
}
