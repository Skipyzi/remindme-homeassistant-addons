package commands

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

func newService(t *testing.T) (*Service, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	sup := supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: paper.New(), Log: env.Log, Flags: paper.FlagProfile,
	})
	return New(Deps{
		Settings: env.Settings, Store: env.Store, Supervisor: sup, Log: env.Log,
	}), env
}

func TestEULARequiresTheExactConfirmation(t *testing.T) {
	service, env := newService(t)

	err := service.AcceptEULA("tester", true, "")
	var confirmErr ErrConfirmation
	if !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if confirmErr.Expected != "I-ACCEPT" {
		t.Fatalf("unexpected phrase %q", confirmErr.Expected)
	}
	if env.Settings.Get().EULAAccepted {
		t.Fatal("the EULA must not be accepted without the confirmation")
	}

	if err := service.AcceptEULA("tester", true, "i-accept"); err == nil {
		t.Fatal("the confirmation must be case sensitive")
	}
	if err := service.AcceptEULA("tester", true, "I-ACCEPT"); err != nil {
		t.Fatalf("accept: %v", err)
	}
	settings := env.Settings.Get()
	if !settings.EULAAccepted || settings.EULAAcceptedAt == "" {
		t.Fatalf("expected acceptance to be recorded: %+v", settings)
	}

	entries, err := env.Store.RecentAudit(10, "server.eula")
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected an audit entry, got %d (%v)", len(entries), err)
	}

	// Revoking needs no confirmation: it only makes the server refuse to start.
	if err := service.AcceptEULA("tester", false, ""); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if env.Settings.Get().EULAAccepted {
		t.Fatal("expected the EULA flag to be cleared")
	}
}

func TestForceStopRequiresConfirmation(t *testing.T) {
	service, _ := newService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var confirmErr ErrConfirmation
	if err := service.Stop(ctx, "tester", true, ""); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if confirmErr.Expected != "FORCE-STOP" {
		t.Fatalf("unexpected phrase %q", confirmErr.Expected)
	}
	// A graceful stop of an already stopped server is a no-op, not an error.
	if err := service.Stop(ctx, "tester", false, ""); err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
}

func TestDestructiveWorldAndBackupActionsRequireTheirPhrases(t *testing.T) {
	service, _ := newService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var confirmErr ErrConfirmation
	if _, err := service.DeleteWorld("tester", "survival", "wrong"); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if confirmErr.Expected != "survival" {
		t.Fatalf("deleting a world should require its name, got %q", confirmErr.Expected)
	}
	if err := service.PurgeWorld("tester", "survival-2026", "DELETE"); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if confirmErr.Expected != "DELETE-PERMANENTLY" {
		t.Fatalf("unexpected phrase %q", confirmErr.Expected)
	}
	if _, err := service.RestoreBackup(ctx, "tester", backupRestoreRequest(), ""); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if err := service.DeleteBackup(ctx, "tester", "bk-1", ""); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if err := service.CancelGeneration(ctx, "tester", ""); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if _, err := service.InstallServerUpdate(ctx, "tester", "1.21.4", 0, ""); !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
}

func TestGenerationProfileIsValidated(t *testing.T) {
	service, env := newService(t)
	if err := service.SetGenerationProfile("tester", "turbo"); err == nil {
		t.Fatal("expected an unknown profile to be rejected")
	}
	if err := service.SetGenerationProfile("tester", "balanced"); err != nil {
		t.Fatalf("set profile: %v", err)
	}
	if got := env.Settings.Get().GenerationProfile; got != "balanced" {
		t.Fatalf("expected the profile to be stored, got %q", got)
	}
}

func TestCommandValidationAndAuditing(t *testing.T) {
	service, env := newService(t)
	// The server is not running, so the command cannot be delivered, but invalid
	// commands must be refused before that even matters.
	if err := service.Command("tester", "op me\nstop"); err == nil {
		t.Fatal("expected a command with a line break to be rejected")
	}
	if err := service.Command("tester", "list"); !errors.Is(err, supervisor.ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning, got %v", err)
	}
	entries, err := env.Store.RecentAudit(10, "server.command")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("a command that was never delivered must not be audited as executed")
	}
}

func TestSettingsPatchOnlyTouchesProvidedFields(t *testing.T) {
	service, env := newService(t)
	before := env.Settings.Get()

	maxHeap := 2048
	schedule := "04:30"
	patch := SettingsPatch{MemoryMaxMB: &maxHeap, RestartSchedule: &schedule}
	after, err := service.UpdateSettings("tester", patch)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if after.MemoryMaxMB != 2048 || after.RestartSchedule != "04:30" {
		t.Fatalf("patch was not applied: %+v", after)
	}
	if after.MemoryMinMB != before.MemoryMinMB || after.StopTimeoutSeconds != before.StopTimeoutSeconds {
		t.Fatalf("unrelated fields changed: %+v", after)
	}

	// Validation still applies to a patch.
	bad := "25:99"
	if _, err := service.UpdateSettings("tester", SettingsPatch{RestartSchedule: &bad}); err == nil {
		t.Fatal("expected an invalid schedule to be rejected")
	}
	tooSmall := 100
	if _, err := service.UpdateSettings("tester", SettingsPatch{MemoryMinMB: &tooSmall}); err == nil {
		t.Fatal("expected an unusable heap size to be rejected")
	}
	if env.Settings.Get().RestartSchedule != "04:30" {
		t.Fatal("a rejected patch must leave the stored settings untouched")
	}
}

func TestMaintenanceModeIsRecorded(t *testing.T) {
	service, env := newService(t)
	if err := service.SetMaintenance("tester", true); err != nil {
		t.Fatalf("maintenance: %v", err)
	}
	if !env.Settings.Get().MaintenanceMode {
		t.Fatal("expected maintenance mode to be enabled")
	}
	entries, err := env.Store.RecentAudit(10, "server.maintenance")
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected an audit entry, got %d (%v)", len(entries), err)
	}
}

func TestValidateJavaFlagsRejectsManagedAndUnsafeFlags(t *testing.T) {
	if _, err := appcfg.ValidateJavaFlags("-XX:+UseG1GC -XX:MaxGCPauseMillis=100"); err != nil {
		t.Fatalf("valid flags rejected: %v", err)
	}
	for _, flags := range []string{"-Xmx4G", "-jar evil.jar", "notaflag", "-XX:+Use;rm -rf /"} {
		if _, err := appcfg.ValidateJavaFlags(flags); err == nil {
			t.Errorf("expected %q to be rejected", flags)
		}
	}
}

func backupRestoreRequest() backups.RestoreRequest {
	return backups.RestoreRequest{BackupID: "bk-1"}
}
