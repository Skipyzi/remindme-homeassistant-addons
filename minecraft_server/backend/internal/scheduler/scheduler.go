// Package scheduler runs the time-based jobs: nightly restarts, scheduled
// backups, idle shutdown and (only when enabled) update checks.
//
// It intentionally does not implement cron. A Minecraft server on a home Pi needs
// "every day at 04:30", and a daily HH:MM schedule is much harder to get wrong.
package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/updates"
)

type Deps struct {
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Commands   *commands.Service
	Backups    *backups.Manager
	Updates    *updates.Manager
	Telemetry  func() (bridge.Telemetry, bool)
	Log        *slog.Logger
	Interval   time.Duration
}

type Scheduler struct {
	deps Deps
	log  *slog.Logger

	emptySince   time.Time
	warned       map[string]bool
	restartNotes int
}

func New(d Deps) *Scheduler {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Interval <= 0 {
		d.Interval = 30 * time.Second
	}
	return &Scheduler{deps: d, log: d.Log.With("component", "scheduler"), warned: map[string]bool{}}
}

func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.deps.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx, time.Now())
		}
	}
}

// tick is separated from Run so tests can drive it with a fixed clock.
func (s *Scheduler) tick(ctx context.Context, now time.Time) {
	settings := s.deps.Settings.Get()

	if busy, _ := s.deps.Supervisor.Busy(); busy {
		// Never start a scheduled job on top of a backup, restore or generation.
		return
	}

	s.maybeRestart(ctx, settings, now)
	s.maybeBackup(ctx, settings, now)
	s.maybeIdleShutdown(ctx, settings, now)
	s.maybeUpdateCheck(ctx, settings, now)
}

// dueOnce reports whether a daily HH:MM schedule is due, using a per-key marker in
// the database so a restart of the add-on cannot cause a double run.
func (s *Scheduler) dueOnce(key, hhmm string, now time.Time) bool {
	if hhmm == "" {
		return false
	}
	target, ok := appcfg.ClockToday(now, hhmm)
	if !ok {
		return false
	}
	if now.Before(target) {
		return false
	}
	// Ignore a schedule we missed by more than an hour (the add-on was off).
	if now.Sub(target) > time.Hour {
		return false
	}
	stamp := target.Format("2006-01-02T15:04")
	last, _, _ := s.deps.Store.GetKV("scheduler." + key)
	if last == stamp {
		return false
	}
	_ = s.deps.Store.SetKV("scheduler."+key, stamp)
	return true
}

func (s *Scheduler) maybeRestart(ctx context.Context, settings appcfg.Settings, now time.Time) {
	if settings.RestartSchedule == "" {
		return
	}
	// Warn players in the ten minutes before the restart.
	if target, ok := appcfg.ClockToday(now, settings.RestartSchedule); ok && s.deps.Supervisor.IsRunning() {
		remaining := target.Sub(now)
		for _, minutes := range []int{10, 5, 1} {
			warnKey := fmt.Sprintf("restart-warn-%d-%s", minutes, target.Format("2006-01-02"))
			window := time.Duration(minutes) * time.Minute
			if remaining > 0 && remaining <= window && remaining > window-s.deps.Interval && !s.warned[warnKey] {
				s.warned[warnKey] = true
				_ = s.deps.Supervisor.Send(fmt.Sprintf("say Server restart in %d minute(s)", minutes))
			}
		}
	}
	if !s.dueOnce("restart", settings.RestartSchedule, now) {
		return
	}
	if !s.deps.Supervisor.IsRunning() {
		return
	}
	s.log.Info("running scheduled restart")
	s.deps.Supervisor.Note("scheduled restart")
	if err := s.deps.Commands.Restart(ctx, "scheduler"); err != nil {
		s.deps.Bus.Warn("scheduler", "scheduled restart failed: "+err.Error())
	}
}

func (s *Scheduler) maybeBackup(ctx context.Context, settings appcfg.Settings, now time.Time) {
	if settings.BackupSchedule == "" {
		return
	}
	if !s.dueOnce("backup", settings.BackupSchedule, now) {
		return
	}
	s.log.Info("running scheduled backup")
	go func() {
		jobCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Hour)
		defer cancel()
		if _, err := s.deps.Commands.Backup(jobCtx, "scheduler", backups.CreateRequest{
			Kind: "scheduled", Label: "scheduled backup", AllowLive: false,
		}); err != nil {
			s.deps.Bus.Warn("scheduler", "scheduled backup failed: "+err.Error())
		}
	}()
}

// maybeIdleShutdown stops the server when nobody has played for a while, which is
// the single most effective way to keep a Pi cool and quiet.
func (s *Scheduler) maybeIdleShutdown(ctx context.Context, settings appcfg.Settings, now time.Time) {
	if settings.IdleShutdownMinutes <= 0 || !s.deps.Supervisor.IsRunning() {
		s.emptySince = time.Time{}
		return
	}
	online := len(s.deps.Supervisor.PlayerNames())
	if telemetry, fresh := s.deps.Telemetry(); fresh {
		online = telemetry.OnlinePlayers
	}
	if online > 0 {
		s.emptySince = time.Time{}
		return
	}
	if s.emptySince.IsZero() {
		s.emptySince = now
		return
	}
	if now.Sub(s.emptySince) < time.Duration(settings.IdleShutdownMinutes)*time.Minute {
		return
	}
	s.emptySince = time.Time{}
	s.log.Info("stopping the server after idle timeout", "minutes", settings.IdleShutdownMinutes)
	s.deps.Supervisor.Note("no players for %d minutes, stopping the server", settings.IdleShutdownMinutes)
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: "scheduler", Action: "server.idle_shutdown",
		Detail: fmt.Sprintf("idle_minutes=%d", settings.IdleShutdownMinutes)})
	if err := s.deps.Commands.Stop(ctx, "scheduler", false, ""); err != nil {
		s.deps.Bus.Warn("scheduler", "idle shutdown failed: "+err.Error())
	}
}

// maybeUpdateCheck only looks for updates; installing still requires the operator
// unless they explicitly enabled scheduled updates.
func (s *Scheduler) maybeUpdateCheck(ctx context.Context, settings appcfg.Settings, now time.Time) {
	if !s.dueOnce("update_check", "05:15", now) {
		return
	}
	go func() {
		checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		available := s.deps.Updates.Check(checkCtx, settings.PaperVersion)
		if available.Error != "" {
			s.log.Debug("update check failed", "error", available.Error)
			return
		}
		if !available.UpdateAvailable {
			return
		}
		s.deps.Bus.Warn("updates", fmt.Sprintf("PaperMC build %d is available for %s",
			available.LatestBuild, available.TargetVersion))
		if !settings.ScheduledUpdate {
			return
		}
		if s.deps.Supervisor.IsRunning() && len(s.deps.Supervisor.PlayerNames()) > 0 {
			s.deps.Bus.Warn("updates", "skipping the scheduled update: players are online")
			return
		}
		installCtx, cancelInstall := context.WithTimeout(context.WithoutCancel(ctx), time.Hour)
		defer cancelInstall()
		if _, err := s.deps.Updates.Install(installCtx, available.TargetVersion, available.LatestBuild, "scheduler"); err != nil {
			s.deps.Bus.Warn("updates", "scheduled update failed: "+err.Error())
		}
	}()
}
