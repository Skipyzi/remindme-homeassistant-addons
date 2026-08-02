package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// genProgressAction asks the generation plugin to print its own view of the task.
var genProgressAction = adapter.GenerationAction{Verb: "progress"}

// Run evaluates the safety guards until the context ends.
//
// Two mechanisms prevent flapping: the pause and resume thresholds are different
// (classic hysteresis), and a job may not change state more often than the
// configured dwell time. Together they mean a Pi hovering around 78 degrees does
// not toggle generation every five seconds.
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(m.deps.GuardInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.evaluate(ctx)
		}
	}
}

func (m *Manager) evaluate(ctx context.Context) {
	m.mu.Lock()
	rt := m.cur
	m.mu.Unlock()
	if rt == nil {
		return
	}

	policy := m.policyFor(rt.job.Profile)
	guard := m.guardSnapshot(policy)

	// The server going away ends the job: Chunky's task died with it.
	if !m.deps.Supervisor.IsRunning() {
		m.deps.Bus.Warn("generation", "Minecraft stopped, terrain generation was interrupted")
		m.finish(ctx, store.JobPaused, ReasonServerStopped)
		m.markInterrupted(rt, ReasonServerStopped)
		return
	}

	// Low disk cancels rather than pauses: waiting would not free anything, and a
	// full disk corrupts region files.
	if policy.PauseWhen.DiskFreeBelowGB > 0 && guard.DiskFreeGB > 0 &&
		guard.DiskFreeGB < policy.PauseWhen.DiskFreeBelowGB {
		m.deps.Bus.Fail("generation", fmt.Sprintf(
			"cancelling terrain generation: only %.1f GB free, threshold is %.1f GB",
			guard.DiskFreeGB, policy.PauseWhen.DiskFreeBelowGB))
		_ = m.Cancel(ctx, "controller", "low_disk_space")
		return
	}

	reasons := pauseReasons(policy, guard, rt)
	dwell := time.Duration(policy.MinDwellSeconds) * time.Second
	sinceFlip := time.Since(rt.lastFlip)

	switch rt.job.Status {
	case store.JobRunning:
		if len(reasons) == 0 {
			return
		}
		// Player joins and thermal events are acted on immediately; softer
		// signals respect the dwell time so noise does not stop a job.
		if !urgent(reasons) && sinceFlip < dwell {
			return
		}
		if err := m.Pause(strings.Join(reasons, ","), "controller"); err != nil {
			m.log.Warn("could not pause generation", "error", err)
		}
	case store.JobPaused:
		if rt.pausedManual {
			return
		}
		if blockers := resumeBlockers(policy, guard, rt); len(blockers) > 0 {
			m.mu.Lock()
			if rt.job.PauseReason != strings.Join(blockers, ",") {
				rt.job.PauseReason = strings.Join(blockers, ",")
				job := rt.job
				m.mu.Unlock()
				_ = m.deps.Store.PutJob(job)
			} else {
				m.mu.Unlock()
			}
			return
		}
		if sinceFlip < dwell {
			return
		}
		if err := m.Resume("controller"); err != nil {
			m.log.Warn("could not resume generation", "error", err)
		}
	}
}

// pauseReasons lists every guard that is currently tripped.
func pauseReasons(policy appcfg.GenerationPolicy, guard GuardSnapshot, rt *runtime) []string {
	var reasons []string
	if policy.OnlyWhenNoPlayers && guard.PlayersOnline > 0 {
		reasons = append(reasons, ReasonPlayersOnline)
	}
	if policy.PauseWhen.TPSBelow > 0 && guard.TPS > 0 && guard.TPS < policy.PauseWhen.TPSBelow {
		reasons = append(reasons, ReasonLowTPS)
	}
	if policy.PauseWhen.MSPTAbove > 0 && guard.MSPT > policy.PauseWhen.MSPTAbove {
		reasons = append(reasons, ReasonHighMSPT)
	}
	if policy.PauseWhen.CPUTemperatureAboveC > 0 && guard.CPUTemperatureC > policy.PauseWhen.CPUTemperatureAboveC {
		reasons = append(reasons, ReasonTemperature)
	}
	if policy.PauseWhen.SystemCPUAbovePct > 0 && guard.SystemCPUPct > policy.PauseWhen.SystemCPUAbovePct {
		reasons = append(reasons, ReasonSystemCPU)
	}
	if policy.AllowedHours.Enabled && !guard.WithinHours {
		reasons = append(reasons, ReasonOutsideHours)
	}
	_ = rt
	return reasons
}

// resumeBlockers lists what still prevents a resume, using the stricter recovery
// thresholds.
func resumeBlockers(policy appcfg.GenerationPolicy, guard GuardSnapshot, rt *runtime) []string {
	var blockers []string
	if policy.OnlyWhenNoPlayers && guard.PlayersOnline > 0 {
		blockers = append(blockers, ReasonPlayersOnline)
	} else if policy.OnlyWhenNoPlayers && policy.ResumeAfterEmptyMinutes > 0 && !rt.lastPlayerAt.IsZero() {
		wait := time.Duration(policy.ResumeAfterEmptyMinutes) * time.Minute
		if time.Since(rt.lastPlayerAt) < wait {
			blockers = append(blockers, ReasonEmptyDelay)
		}
	}
	if policy.ResumeWhen.TPSAbove > 0 && guard.TPS > 0 && guard.TPS < policy.ResumeWhen.TPSAbove {
		blockers = append(blockers, ReasonLowTPS)
	}
	if policy.ResumeWhen.CPUTemperatureBelowC > 0 && guard.CPUTemperatureC > policy.ResumeWhen.CPUTemperatureBelowC {
		blockers = append(blockers, ReasonTemperature)
	}
	if policy.ResumeWhen.SystemCPUBelowPct > 0 && guard.SystemCPUPct > policy.ResumeWhen.SystemCPUBelowPct {
		blockers = append(blockers, ReasonSystemCPU)
	}
	if policy.AllowedHours.Enabled && !guard.WithinHours {
		blockers = append(blockers, ReasonOutsideHours)
	}
	return blockers
}

func urgent(reasons []string) bool {
	for _, r := range reasons {
		if r == ReasonPlayersOnline || r == ReasonTemperature {
			return true
		}
	}
	return false
}

func (m *Manager) markInterrupted(rt *runtime, reason string) {
	rt.job.Status = store.JobPaused
	rt.job.PauseReason = reason
	_ = m.deps.Store.PutJob(rt.job)
}

// Reconcile restores generation state after an add-on restart.
//
// Chunky persists its own task state and continues where it left off when the
// world loads, but it does not know about our guards, so a job found in the
// database is adopted as paused and only resumed once the guards agree - or
// manually, if the operator prefers.
func (m *Manager) Reconcile(ctx context.Context) {
	job, ok, err := m.deps.Store.ActiveJob()
	if err != nil {
		m.log.Warn("could not read generation jobs", "error", err)
		return
	}
	if !ok {
		return
	}
	var params Params
	if err := json.Unmarshal(job.Params, &params); err != nil {
		m.log.Warn("generation job parameters are unreadable, marking it failed", "job", job.ID)
		job.Status = store.JobFailed
		job.Detail = "job parameters could not be read after a restart"
		_ = m.deps.Store.PutJob(job)
		return
	}

	// A job whose world is no longer the active one cannot be continued.
	if params.WorldID != "" {
		if _, err := m.deps.WorldDir(params.WorldID); err != nil {
			job.Status = store.JobFailed
			job.Detail = "the world this job belongs to no longer exists"
			_ = m.deps.Store.PutJob(job)
			return
		}
	}

	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityGenerating)
	if err != nil {
		m.log.Warn("could not adopt the generation job", "error", err)
		return
	}
	job.Status = store.JobPaused
	if job.PauseReason == "" {
		job.PauseReason = ReasonAddonRestarted
	}
	_ = m.deps.Store.PutJob(job)

	rt := &runtime{
		job: job, params: params, dimensions: params.dimensionList(), lease: lease,
		startedAt: time.Now().Add(-time.Duration(job.ElapsedMs) * time.Millisecond),
		lastFlip:  time.Now(), lastProgress: time.Now(),
	}
	m.mu.Lock()
	m.cur = rt
	m.mu.Unlock()

	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "generation.reconciled",
		Target: job.ID, Detail: fmt.Sprintf("adopted as paused at %.1f%%", job.Progress), Result: "warning"})
	m.deps.Bus.Warn("generation",
		"a terrain generation job survived the restart and is paused; check the numbers and resume it when you are ready")

	// Ask Chunky what it thinks the state is, so the console shows the truth next
	// to our own numbers.
	if m.deps.Supervisor.IsRunning() {
		if err := m.deps.Supervisor.SendMany(m.deps.Backend.GenerationCommands(genProgressAction)); err != nil {
			m.log.Debug("could not query chunky progress", "error", err)
		}
	}
	_ = ctx
}
