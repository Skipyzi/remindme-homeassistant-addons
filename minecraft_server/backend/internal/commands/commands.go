// Package commands is the single place where state-changing operations are
// authorized, validated and audited.
//
// The REST API and the Home Assistant MQTT integration both call into this
// service, so a button in Home Assistant goes through exactly the same checks as
// the same button in the web UI.
package commands

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/flavours"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/updates"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

// ErrConfirmation is returned when a destructive action lacks its confirmation.
type ErrConfirmation struct {
	Expected string
	Action   string
}

func (e ErrConfirmation) Error() string {
	return fmt.Sprintf("%s requires confirmation: send confirm=%q", e.Action, e.Expected)
}

var ErrMaintenance = errors.New("maintenance mode is enabled; disable it first")

type Deps struct {
	Paths    appcfg.Paths
	Settings *appcfg.Store
	// Backend is the switchable backend every manager was given, so a flavour
	// switch is a pointer swap here rather than a rebuild of the controller.
	Backend *flavours.Switchable
	// ServerPort comes from the add-on options; a backend without a launch
	// argument for it needs it written into its properties file.
	ServerPort int
	Store      *store.Store
	Supervisor *supervisor.Supervisor
	Config     *mcconfig.Manager
	Presets    *presets.Manager
	Worlds     *worlds.Manager
	Backups    *backups.Manager
	Generation *generation.Manager
	Updates    *updates.Manager
	Log        *slog.Logger
}

type Service struct {
	deps Deps
	log  *slog.Logger
}

func New(d Deps) *Service {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	return &Service{deps: d, log: d.Log.With("component", "commands")}
}

func confirm(expected, given, action string) error {
	if strings.TrimSpace(given) == expected {
		return nil
	}
	return ErrConfirmation{Expected: expected, Action: action}
}

// ------------------------------------------------------------ server control --

func (s *Service) Start(actor string) error {
	if err := s.deps.Worlds.PrepareRuntime(); err != nil {
		return err
	}
	return s.deps.Supervisor.Start()
}

// Stop performs a graceful stop. Force is a separate, confirmed action because it
// can lose up to one autosave interval of world data.
func (s *Service) Stop(ctx context.Context, actor string, force bool, confirmation string) error {
	if force {
		if err := confirm("FORCE-STOP", confirmation, "force stop"); err != nil {
			return err
		}
	}
	return s.deps.Supervisor.Stop(ctx, supervisor.StopOptions{
		Force:  force,
		Reason: "requested by " + actor,
	})
}

func (s *Service) Restart(ctx context.Context, actor string) error {
	if err := s.deps.Worlds.PrepareRuntime(); err != nil {
		return err
	}
	return s.deps.Supervisor.Restart(ctx, "requested by "+actor)
}

// Command sends a console command. Commands are audited because they can do
// anything an operator can do in game.
func (s *Service) Command(actor, command string) error {
	if err := supervisor.ValidateCommand(command); err != nil {
		return err
	}
	if err := s.deps.Supervisor.Send(command); err != nil {
		return err
	}
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "server.command",
		Target: firstWord(command), Detail: store.Redact(command)})
	return nil
}

// AcceptEULA records the operator's acceptance. It is never set automatically.
func (s *Service) AcceptEULA(actor string, accepted bool, confirmation string) error {
	if accepted {
		if err := confirm("I-ACCEPT", confirmation, "accepting the Minecraft EULA"); err != nil {
			return err
		}
	}
	settings, err := s.deps.Settings.Update(func(cfg *appcfg.Settings) {
		cfg.EULAAccepted = accepted
		if accepted {
			cfg.EULAAcceptedAt = nowRFC3339()
		} else {
			cfg.EULAAcceptedAt = ""
		}
	})
	if err != nil {
		return err
	}
	action := "server.eula_accepted"
	if !accepted {
		action = "server.eula_revoked"
	}
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: action, Target: "eula.txt",
		Detail: "accepted_at=" + settings.EULAAcceptedAt})
	return nil
}

func (s *Service) SetMaintenance(actor string, enabled bool) error {
	if _, err := s.deps.Settings.Update(func(cfg *appcfg.Settings) { cfg.MaintenanceMode = enabled }); err != nil {
		return err
	}
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "server.maintenance",
		Target: fmt.Sprint(enabled)})
	// A running server also gets its whitelist toggled so the setting has an
	// immediate effect in game.
	if s.deps.Supervisor.IsRunning() {
		cmd := "whitelist off"
		if enabled {
			cmd = "whitelist on"
		}
		if err := s.deps.Supervisor.Send(cmd); err != nil {
			s.log.Warn("could not toggle the whitelist", "error", err)
		}
	}
	return nil
}

// ------------------------------------------------------------ configuration ---

func (s *Service) SetKnobs(actor string, changes map[string]any) ([]mcconfig.WriteResult, error) {
	results, err := s.deps.Config.SetKnobs(changes, actor)
	if err != nil {
		return results, err
	}
	s.deps.Config.AuditKnobChange(actor, changes)
	// Remember these as manual overrides so a preset does not silently revert them.
	s.deps.Presets.RecordOverrides(changes)

	// A few settings can be applied to the running server immediately, which saves
	// a restart for exactly the changes people make most often.
	if s.deps.Supervisor.IsRunning() {
		for key, value := range changes {
			s.deps.Config.ApplyRuntimeToggle(key, value, s.deps.Supervisor.Send)
		}
	}
	return results, nil
}

func (s *Service) WriteConfigFile(actor, name, content string) (mcconfig.WriteResult, error) {
	return s.deps.Config.Write(name, content, actor)
}

func (s *Service) ApplyPreset(actor, id string, overrideUser bool) (presets.ApplyResult, error) {
	return s.deps.Presets.Apply(id, actor, overrideUser)
}

// ------------------------------------------------------------------- worlds ---

func (s *Service) ActivateWorld(ctx context.Context, actor string, req worlds.ActivateRequest) (worlds.ActivateResult, error) {
	return s.deps.Worlds.Activate(ctx, req, actor)
}

func (s *Service) DeleteWorld(actor, id, confirmation string) (string, error) {
	if err := confirm(id, confirmation, "moving a world to the trash"); err != nil {
		return "", err
	}
	return s.deps.Worlds.Delete(id, actor)
}

// PurgeWorld permanently deletes a trashed world. This is the only operation that
// destroys data without a copy anywhere, so the confirmation is deliberately
// awkward to type.
func (s *Service) PurgeWorld(actor, trashName, confirmation string) error {
	if err := confirm("DELETE-PERMANENTLY", confirmation, "permanently deleting a world"); err != nil {
		return err
	}
	return s.deps.Worlds.PurgeTrash(trashName, actor)
}

// ------------------------------------------------------------------ backups ---

func (s *Service) Backup(ctx context.Context, actor string, req backups.CreateRequest) (store.BackupRecord, error) {
	return s.deps.Backups.Create(ctx, req, actor, nil)
}

func (s *Service) RestoreBackup(ctx context.Context, actor string, req backups.RestoreRequest, confirmation string) (backups.RestoreResult, error) {
	if err := confirm("RESTORE", confirmation, "restoring a backup"); err != nil {
		return backups.RestoreResult{}, err
	}
	return s.deps.Backups.Restore(ctx, req, actor)
}

func (s *Service) DeleteBackup(ctx context.Context, actor, id, confirmation string) error {
	if err := confirm("DELETE", confirmation, "deleting a backup"); err != nil {
		return err
	}
	return s.deps.Backups.Delete(ctx, id, actor)
}

// ---------------------------------------------------------------- generation --

func (s *Service) StartGeneration(ctx context.Context, actor string, params generation.Params) (store.JobRecord, error) {
	if params.Profile == "" {
		params.Profile = s.deps.Settings.Get().GenerationProfile
	}
	return s.deps.Generation.Start(ctx, params, actor)
}

func (s *Service) PauseGeneration(actor string) error {
	return s.deps.Generation.Pause(generation.ReasonManual, actor)
}

func (s *Service) ResumeGeneration(actor string) error {
	return s.deps.Generation.Resume(actor)
}

func (s *Service) CancelGeneration(ctx context.Context, actor, confirmation string) error {
	if err := confirm("CANCEL", confirmation, "cancelling terrain generation"); err != nil {
		return err
	}
	return s.deps.Generation.Cancel(ctx, actor, "cancelled by "+actor)
}

func (s *Service) SetGenerationProfile(actor, profile string) error {
	switch profile {
	case generation.ProfileGentle, generation.ProfileBalanced, generation.ProfileMaximum:
	default:
		return fmt.Errorf("unknown generation profile %q", profile)
	}
	if _, err := s.deps.Settings.Update(func(cfg *appcfg.Settings) { cfg.GenerationProfile = profile }); err != nil {
		return err
	}
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.profile", Target: profile})
	return nil
}

func (s *Service) InstallGenerationPlugin(ctx context.Context, actor string) (generation.PluginStatus, error) {
	return s.deps.Generation.InstallPlugin(ctx, actor)
}

// ------------------------------------------------------------------ updates ---

func (s *Service) InstallServerUpdate(ctx context.Context, actor, version string, build int, confirmation string) (updates.Result, error) {
	if err := confirm("UPDATE", confirmation, "updating the server JAR"); err != nil {
		return updates.Result{}, err
	}
	return s.deps.Updates.Install(ctx, version, build, actor)
}

func (s *Service) InstallServerJar(ctx context.Context, actor string) (updates.Result, error) {
	return s.deps.Updates.EnsureInstalled(ctx, actor)
}

// ----------------------------------------------------------------- settings ---

// UpdateSettings applies a partial settings change. Only fields the UI owns are
// writable; add-on options remain the Supervisor's business.
func (s *Service) UpdateSettings(actor string, patch SettingsPatch) (appcfg.Settings, error) {
	settings, err := s.deps.Settings.Update(func(cfg *appcfg.Settings) { patch.apply(cfg) })
	if err != nil {
		return settings, err
	}
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "settings.update",
		Target: "controller", Detail: patch.describe()})
	return settings, nil
}

// SettingsPatch is a partial update; nil fields are left alone.
type SettingsPatch struct {
	MemoryMinMB         *int                     `json:"memory_min_mb"`
	MemoryMaxMB         *int                     `json:"memory_max_mb"`
	JVMFlagsProfile     *string                  `json:"jvm_flags_profile"`
	JVMFlagsCustom      *string                  `json:"jvm_flags_custom"`
	AutoRestartOnCrash  *bool                    `json:"auto_restart_on_crash"`
	StopTimeoutSeconds  *int                     `json:"stop_timeout_seconds"`
	StartOnBoot         *bool                    `json:"start_on_boot"`
	IdleShutdownMinutes *int                     `json:"idle_shutdown_minutes"`
	RestartSchedule     *string                  `json:"restart_schedule"`
	BackupSchedule      *string                  `json:"backup_schedule"`
	BackupRetention     *appcfg.Retention        `json:"backup_retention"`
	BackupVerify        *bool                    `json:"backup_verify_after_write"`
	BackupBeforeConfig  *bool                    `json:"backup_before_config_edit"`
	ScheduledUpdate     *bool                    `json:"scheduled_update"`
	IncludePreReleases  *bool                    `json:"include_pre_releases"`
	GenerationProfile   *string                  `json:"generation_profile"`
	Generation          *appcfg.GenerationPolicy `json:"generation"`
}

func (p SettingsPatch) apply(cfg *appcfg.Settings) {
	setInt(&cfg.MemoryMinMB, p.MemoryMinMB)
	setInt(&cfg.MemoryMaxMB, p.MemoryMaxMB)
	setString(&cfg.JVMFlagsProfile, p.JVMFlagsProfile)
	setString(&cfg.JVMFlagsCustom, p.JVMFlagsCustom)
	setBool(&cfg.AutoRestartOnCrash, p.AutoRestartOnCrash)
	setInt(&cfg.StopTimeoutSeconds, p.StopTimeoutSeconds)
	setBool(&cfg.StartOnBoot, p.StartOnBoot)
	setBool(&cfg.IncludePreReleases, p.IncludePreReleases)
	setInt(&cfg.IdleShutdownMinutes, p.IdleShutdownMinutes)
	setString(&cfg.RestartSchedule, p.RestartSchedule)
	setString(&cfg.BackupSchedule, p.BackupSchedule)
	if p.BackupRetention != nil {
		cfg.BackupRetention = *p.BackupRetention
	}
	setBool(&cfg.BackupVerifyAfterWrite, p.BackupVerify)
	setBool(&cfg.BackupBeforeConfigEdit, p.BackupBeforeConfig)
	setBool(&cfg.ScheduledUpdate, p.ScheduledUpdate)
	setString(&cfg.GenerationProfile, p.GenerationProfile)
	if p.Generation != nil {
		cfg.Generation = *p.Generation
	}
}

func (p SettingsPatch) describe() string {
	var parts []string
	if p.MemoryMaxMB != nil {
		parts = append(parts, fmt.Sprintf("memory_max_mb=%d", *p.MemoryMaxMB))
	}
	if p.JVMFlagsProfile != nil {
		parts = append(parts, "jvm_flags_profile="+*p.JVMFlagsProfile)
	}
	if p.IdleShutdownMinutes != nil {
		parts = append(parts, fmt.Sprintf("idle_shutdown_minutes=%d", *p.IdleShutdownMinutes))
	}
	if p.RestartSchedule != nil {
		parts = append(parts, "restart_schedule="+*p.RestartSchedule)
	}
	if p.BackupSchedule != nil {
		parts = append(parts, "backup_schedule="+*p.BackupSchedule)
	}
	if p.Generation != nil {
		parts = append(parts, "generation_policy=updated")
	}
	if len(parts) == 0 {
		return "no visible changes"
	}
	return strings.Join(parts, " ")
}

func setInt(dst *int, src *int) {
	if src != nil {
		*dst = *src
	}
}

func setBool(dst *bool, src *bool) {
	if src != nil {
		*dst = *src
	}
}

func setString(dst *string, src *string) {
	if src != nil {
		*dst = *src
	}
}

func firstWord(s string) string {
	if idx := strings.IndexByte(s, ' '); idx > 0 {
		return s[:idx]
	}
	return s
}
