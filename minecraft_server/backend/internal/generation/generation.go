package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// Profiles.
const (
	ProfileGentle   = "gentle"
	ProfileBalanced = "balanced"
	ProfileMaximum  = "maximum"
)

// Pause reasons, surfaced in the UI and over MQTT.
const (
	ReasonPlayersOnline  = "players_online"
	ReasonLowTPS         = "low_tps"
	ReasonHighMSPT       = "high_mspt"
	ReasonTemperature    = "cpu_temperature"
	ReasonSystemCPU      = "system_cpu"
	ReasonOutsideHours   = "outside_allowed_hours"
	ReasonServerStopped  = "server_stopped"
	ReasonManual         = "manual"
	ReasonEmptyDelay     = "waiting_for_empty_server_delay"
	ReasonAddonRestarted = "addon_restarted"
)

var (
	ErrNoActiveJob   = errors.New("no terrain generation job is active")
	ErrJobRunning    = errors.New("a terrain generation job is already active")
	ErrServerStopped = errors.New("Minecraft must be running to generate terrain")
	ErrNoPlugin      = errors.New("the Chunky plugin is not installed")
	ErrLowDisk       = errors.New("not enough free disk space for this generation job")
)

// Params is a generation request.
type Params struct {
	WorldID            string   `json:"world_id"`
	Dimensions         []string `json:"dimensions"`
	Shape              string   `json:"shape"`
	RadiusBlocks       int      `json:"radius_blocks"`
	CenterX            int      `json:"center_x"`
	CenterZ            int      `json:"center_z"`
	CenterAtSpawn      bool     `json:"center_at_spawn"`
	BorderRadiusBlocks int      `json:"border_radius_blocks"`
	SafetyMarginBlocks int      `json:"safety_margin_blocks"`
	Profile            string   `json:"profile"`
	// ApplyWorldBorder issues a worldborder command once generation finishes so
	// the playable area matches what was generated.
	ApplyWorldBorder bool `json:"apply_world_border"`
}

func (p Params) Validate() error {
	if p.WorldID == "" {
		return errors.New("a world must be selected")
	}
	if p.RadiusBlocks < 16 || p.RadiusBlocks > 100_000 {
		return errors.New("radius must be between 16 and 100000 blocks")
	}
	if p.SafetyMarginBlocks < 0 || p.SafetyMarginBlocks > p.RadiusBlocks {
		return errors.New("safety margin must be between 0 and the radius")
	}
	if p.CenterX < -30_000_000 || p.CenterX > 30_000_000 || p.CenterZ < -30_000_000 || p.CenterZ > 30_000_000 {
		return errors.New("center coordinates are outside the world limits")
	}
	switch p.Profile {
	case ProfileGentle, ProfileBalanced, ProfileMaximum, "":
	default:
		return fmt.Errorf("unknown generation profile %q", p.Profile)
	}
	for _, dim := range p.Dimensions {
		switch dim {
		case "world", "world_nether", "world_the_end":
		default:
			return fmt.Errorf("unknown dimension %q", dim)
		}
	}
	return nil
}

func (p Params) dimensionList() []string {
	if len(p.Dimensions) == 0 {
		return []string{"world"}
	}
	// Keep the canonical order so sequential generation is predictable.
	order := []string{"world", "world_nether", "world_the_end"}
	out := make([]string, 0, len(p.Dimensions))
	for _, dim := range order {
		for _, requested := range p.Dimensions {
			if requested == dim {
				out = append(out, dim)
				break
			}
		}
	}
	return out
}

type Deps struct {
	Paths      appcfg.Paths
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Backend    adapter.Backend
	Options    appcfg.Options
	Log        *slog.Logger

	Stats         func() stats.System
	Telemetry     func() (bridge.Telemetry, bool)
	WorldDir      func(id string) (string, error)
	ServerVersion func() string
	// Backup is used for the pre- and post-generation backups.
	Backup func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error
	// UpdateWorldMeta records generation results on the world.
	UpdateWorldMeta func(worldID string, generatedRadius, borderRadius int, status, jobID string) error
	// GuardInterval is how often the safety guards are evaluated.
	GuardInterval time.Duration
}

// runtime holds the in-memory state of the active job.
type runtime struct {
	job          store.JobRecord
	params       Params
	dimensions   []string
	lease        *supervisor.Lease
	startedAt    time.Time
	lastFlip     time.Time
	lastProgress time.Time
	lastPlayerAt time.Time
	chunkStart   int64
	rateSamples  []float64
	pausedManual bool
}

type Manager struct {
	deps Deps
	log  *slog.Logger

	mu  sync.Mutex
	cur *runtime
}

func NewManager(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.GuardInterval <= 0 {
		d.GuardInterval = 5 * time.Second
	}
	return &Manager{deps: d, log: d.Log.With("component", "generation")}
}

// policyFor merges the configured policy with the selected profile.
//
// Gentle is the configured policy as-is. Balanced trades some safety margin for
// throughput but still yields to players. Maximum assumes the server is closed
// for business and only respects the physical limits: temperature and disk.
func (m *Manager) policyFor(profile string) appcfg.GenerationPolicy {
	policy := m.deps.Settings.Get().Generation
	switch profile {
	case ProfileBalanced:
		policy.AllowedHours.Enabled = false
		policy.PauseWhen.TPSBelow = minFloat(policy.PauseWhen.TPSBelow, 17)
		policy.PauseWhen.MSPTAbove = maxFloat(policy.PauseWhen.MSPTAbove, 48)
		policy.PauseWhen.CPUTemperatureAboveC = maxFloat(policy.PauseWhen.CPUTemperatureAboveC, 80)
		policy.PauseWhen.SystemCPUAbovePct = maxFloat(policy.PauseWhen.SystemCPUAbovePct, 85)
		policy.ResumeWhen.TPSAbove = minFloat(policy.ResumeWhen.TPSAbove, 18.5)
		policy.ResumeWhen.SystemCPUBelowPct = maxFloat(policy.ResumeWhen.SystemCPUBelowPct, 70)
		policy.ResumeAfterEmptyMinutes = minInt(policy.ResumeAfterEmptyMinutes, 5)
	case ProfileMaximum:
		policy.AllowedHours.Enabled = false
		policy.OnlyWhenNoPlayers = false
		policy.MaintenanceBlocksPlayers = true
		policy.DimensionsSequential = true
		policy.RestartAfterCompletion = true
		policy.BackupAfterCompletion = true
		// Only the physical limits remain.
		policy.PauseWhen.TPSBelow = 0
		policy.PauseWhen.MSPTAbove = 0
		policy.PauseWhen.SystemCPUAbovePct = 0
		policy.PauseWhen.CPUTemperatureAboveC = maxFloat(policy.PauseWhen.CPUTemperatureAboveC, 82)
		policy.ResumeWhen.CPUTemperatureBelowC = minFloat(policy.ResumeWhen.CPUTemperatureBelowC, 74)
	}
	return policy
}

// Status is the API view of terrain generation.
type Status struct {
	Active          bool             `json:"active"`
	Job             *store.JobRecord `json:"job,omitempty"`
	Params          *Params          `json:"params,omitempty"`
	Dimension       string           `json:"dimension,omitempty"`
	Profile         string           `json:"profile,omitempty"`
	PauseReasons    []string         `json:"pause_reasons,omitempty"`
	Guard           GuardSnapshot    `json:"guard"`
	Plugin          PluginStatus     `json:"plugin"`
	EstimatedFinish string           `json:"estimated_finish,omitempty"`
	RemainingSecs   int64            `json:"remaining_seconds,omitempty"`
}

// GuardSnapshot is what the guards currently see, so the UI can explain a pause.
type GuardSnapshot struct {
	PlayersOnline   int     `json:"players_online"`
	TPS             float64 `json:"tps"`
	MSPT            float64 `json:"mspt"`
	CPUTemperatureC float64 `json:"cpu_temperature_c"`
	SystemCPUPct    float64 `json:"system_cpu_percent"`
	DiskFreeGB      float64 `json:"disk_free_gb"`
	WithinHours     bool    `json:"within_allowed_hours"`
	Thresholds      appcfg.GenerationPolicy `json:"thresholds"`
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	cur := m.cur
	m.mu.Unlock()

	status := Status{Guard: m.guardSnapshot(m.policyFor(profileOf(cur))), Plugin: m.PluginStatus()}
	if cur == nil {
		if job, ok, _ := m.deps.Store.ActiveJob(); ok {
			status.Job = &job
			status.Active = true
			status.Profile = job.Profile
			var params Params
			if err := json.Unmarshal(job.Params, &params); err == nil {
				status.Params = &params
			}
		}
		return status
	}
	job := cur.job
	status.Active = true
	status.Job = &job
	params := cur.params
	status.Params = &params
	status.Profile = job.Profile
	if job.DimensionIndex < len(cur.dimensions) {
		status.Dimension = cur.dimensions[job.DimensionIndex]
	}
	if job.PauseReason != "" {
		status.PauseReasons = strings.Split(job.PauseReason, ",")
	}
	if job.Rate > 0 && job.ChunksTotal > job.ChunksDone {
		remaining := float64(job.ChunksTotal-job.ChunksDone) / job.Rate
		status.RemainingSecs = int64(remaining)
		status.EstimatedFinish = time.Now().Add(time.Duration(remaining) * time.Second).UTC().Format(time.RFC3339)
	}
	return status
}

func profileOf(r *runtime) string {
	if r == nil {
		return ""
	}
	return r.job.Profile
}

func (m *Manager) guardSnapshot(policy appcfg.GenerationPolicy) GuardSnapshot {
	system := m.deps.Stats()
	snap := GuardSnapshot{
		CPUTemperatureC: system.CPUTemperatureC,
		SystemCPUPct:    system.CPUPercent,
		DiskFreeGB:      float64(system.DiskFreeBytes) / (1 << 30),
		Thresholds:      policy,
		WithinHours:     true,
	}
	if policy.AllowedHours.Enabled {
		snap.WithinHours = appcfg.WithinWindow(time.Now(), policy.AllowedHours.Start, policy.AllowedHours.End)
	}
	if telemetry, fresh := m.deps.Telemetry(); fresh {
		snap.PlayersOnline = telemetry.OnlinePlayers
		snap.TPS = telemetry.TPS1m()
		snap.MSPT = telemetry.MSPT
	} else {
		snap.PlayersOnline = len(m.deps.Supervisor.PlayerNames())
	}
	return snap
}

// ------------------------------------------------------------------- start ----

// Start begins a generation job.
func (m *Manager) Start(ctx context.Context, params Params, actor string) (store.JobRecord, error) {
	if err := params.Validate(); err != nil {
		return store.JobRecord{}, err
	}
	if params.Profile == "" {
		params.Profile = ProfileGentle
	}
	if params.Shape == "" {
		params.Shape = "square"
	}
	if params.SafetyMarginBlocks == 0 {
		params.SafetyMarginBlocks = m.deps.Settings.Get().Generation.SafetyMarginBlocks
	}

	m.mu.Lock()
	if m.cur != nil {
		m.mu.Unlock()
		return store.JobRecord{}, ErrJobRunning
	}
	m.mu.Unlock()

	if existing, ok, _ := m.deps.Store.ActiveJob(); ok {
		return store.JobRecord{}, fmt.Errorf("%w: %s", ErrJobRunning, existing.ID)
	}
	if !m.PluginStatus().Installed {
		return store.JobRecord{}, ErrNoPlugin
	}
	if !m.deps.Supervisor.IsRunning() {
		return store.JobRecord{}, ErrServerStopped
	}

	estimate, err := m.Estimate(params)
	if err != nil {
		return store.JobRecord{}, err
	}
	if !estimate.Sufficient {
		return store.JobRecord{}, fmt.Errorf("%w: needs up to %s, %s free",
			ErrLowDisk, humanBytes(estimate.SafeBytes), humanBytes(estimate.FreeBytes))
	}

	policy := m.policyFor(params.Profile)
	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityGenerating)
	if err != nil {
		return store.JobRecord{}, err
	}

	release := func() { m.deps.Supervisor.Release(lease) }

	// Maximum keeps players out for the whole run.
	if policy.MaintenanceBlocksPlayers {
		if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.MaintenanceMode = true }); err != nil {
			release()
			return store.JobRecord{}, err
		}
	}

	if policy.BackupBeforeStart && m.deps.Backup != nil {
		m.deps.Supervisor.Note("backing up %s before terrain generation", params.WorldID)
		if err := m.deps.Backup(ctx, params.WorldID, "pre_generation", "before terrain generation", lease); err != nil {
			release()
			return store.JobRecord{}, fmt.Errorf("pre-generation backup failed: %w", err)
		}
	}

	raw, _ := json.Marshal(params)
	dims := params.dimensionList()
	job := store.JobRecord{
		ID: newJobID(), WorldID: params.WorldID, Profile: params.Profile,
		Status: store.JobRunning, Params: raw,
		ChunksTotal: estimate.Chunks, CreatedAt: time.Now().UTC(),
	}
	if err := m.deps.Store.PutJob(job); err != nil {
		release()
		return store.JobRecord{}, err
	}
	journalID, _ := m.deps.Store.JournalBegin(store.OpGeneration, "start", map[string]any{
		"job": job.ID, "world": params.WorldID, "profile": params.Profile, "actor": actor,
	})
	_ = m.deps.Store.SetKV("generation.journal", fmt.Sprint(journalID))

	rt := &runtime{
		job: job, params: params, dimensions: dims, lease: lease,
		startedAt: time.Now(), lastFlip: time.Now(), lastProgress: time.Now(),
	}
	m.mu.Lock()
	m.cur = rt
	m.mu.Unlock()

	if err := m.startDimension(rt, 0); err != nil {
		m.finish(context.WithoutCancel(ctx), store.JobFailed, err.Error())
		return job, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.start", Target: params.WorldID,
		Detail: fmt.Sprintf("job=%s profile=%s radius=%d shape=%s dimensions=%s chunks=%d estimate=%s",
			job.ID, params.Profile, params.RadiusBlocks, params.Shape, strings.Join(dims, "+"),
			estimate.Chunks, humanBytes(estimate.HighBytes))})
	m.deps.Bus.Publish(events.TypeGenerationProgress, m.progressPayload(rt))
	return job, nil
}

// startDimension configures and starts Chunky for one dimension.
func (m *Manager) startDimension(rt *runtime, index int) error {
	if index >= len(rt.dimensions) {
		return errors.New("no dimension to generate")
	}
	dim := rt.dimensions[index]
	centerX, centerZ := rt.params.CenterX, rt.params.CenterZ
	if rt.params.CenterAtSpawn {
		// Chunky's own default centre is the world spawn; passing 0,0 explicitly
		// would move it, so the centre command is skipped instead.
		centerX, centerZ = 0, 0
	}
	action := adapter.GenerationAction{
		Verb: "configure", World: dim, Shape: rt.params.Shape,
		Radius: rt.params.RadiusBlocks, CenterX: centerX, CenterZ: centerZ,
	}
	commands := m.deps.Backend.GenerationCommands(action)
	if rt.params.CenterAtSpawn {
		filtered := commands[:0]
		for _, c := range commands {
			if strings.HasPrefix(c, "chunky center") {
				continue
			}
			filtered = append(filtered, c)
		}
		commands = filtered
	}
	commands = append(commands, m.deps.Backend.GenerationCommands(adapter.GenerationAction{Verb: "quiet"})...)
	commands = append(commands, m.deps.Backend.GenerationCommands(adapter.GenerationAction{Verb: "start"})...)

	m.deps.Supervisor.Note("starting terrain generation for %s (radius %d, %s)", dim, rt.params.RadiusBlocks, rt.params.Shape)
	if err := m.deps.Supervisor.SendMany(commands); err != nil {
		return err
	}
	rt.job.DimensionIndex = index
	rt.job.Status = store.JobRunning
	rt.job.PauseReason = ""
	rt.chunkStart = rt.job.ChunksDone
	return m.deps.Store.PutJob(rt.job)
}

// ------------------------------------------------------------------ control ----

// Pause stops generation. Manual pauses are not resumed automatically.
func (m *Manager) Pause(reason, actor string) error {
	m.mu.Lock()
	rt := m.cur
	m.mu.Unlock()
	if rt == nil {
		return ErrNoActiveJob
	}
	if rt.job.Status == store.JobPaused {
		return nil
	}
	if err := m.deps.Supervisor.SendMany(m.deps.Backend.GenerationCommands(adapter.GenerationAction{Verb: "pause"})); err != nil {
		return err
	}
	m.mu.Lock()
	rt.job.Status = store.JobPaused
	rt.job.PauseReason = reason
	rt.lastFlip = time.Now()
	if reason == ReasonManual {
		rt.pausedManual = true
	}
	job := rt.job
	m.mu.Unlock()

	_ = m.deps.Store.PutJob(job)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.pause", Target: job.ID,
		Detail: "reason=" + reason})
	m.deps.Bus.Publish(events.TypeGenerationPaused, map[string]any{"job": job.ID, "reason": reason})
	m.deps.Supervisor.Note("terrain generation paused: %s", reason)
	return nil
}

// Resume continues a paused job.
func (m *Manager) Resume(actor string) error {
	m.mu.Lock()
	rt := m.cur
	m.mu.Unlock()
	if rt == nil {
		return ErrNoActiveJob
	}
	if rt.job.Status == store.JobRunning {
		return nil
	}
	if !m.deps.Supervisor.IsRunning() {
		return ErrServerStopped
	}
	if err := m.deps.Supervisor.SendMany(m.deps.Backend.GenerationCommands(adapter.GenerationAction{Verb: "resume"})); err != nil {
		return err
	}
	m.mu.Lock()
	rt.job.Status = store.JobRunning
	rt.job.PauseReason = ""
	rt.pausedManual = false
	rt.lastFlip = time.Now()
	job := rt.job
	m.mu.Unlock()

	_ = m.deps.Store.PutJob(job)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.resume", Target: job.ID})
	m.deps.Bus.Publish(events.TypeGenerationResumed, map[string]any{"job": job.ID})
	m.deps.Supervisor.Note("terrain generation resumed")
	return nil
}

// Cancel ends a job. Chunky keeps the chunks it already generated.
func (m *Manager) Cancel(ctx context.Context, actor, reason string) error {
	m.mu.Lock()
	rt := m.cur
	m.mu.Unlock()
	if rt == nil {
		return ErrNoActiveJob
	}
	if m.deps.Supervisor.IsRunning() {
		if err := m.deps.Supervisor.SendMany(m.deps.Backend.GenerationCommands(adapter.GenerationAction{Verb: "cancel"})); err != nil {
			m.log.Warn("could not send the cancel command", "error", err)
		}
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.cancel", Target: rt.job.ID,
		Detail: "reason=" + reason})
	m.finish(ctx, store.JobCancelled, reason)
	return nil
}

// finish closes out the active job and runs the profile's post-run actions.
func (m *Manager) finish(ctx context.Context, status, detail string) {
	m.mu.Lock()
	rt := m.cur
	m.cur = nil
	m.mu.Unlock()
	if rt == nil {
		return
	}

	rt.job.Status = status
	rt.job.Detail = detail
	rt.job.ElapsedMs = time.Since(rt.startedAt).Milliseconds()
	if status == store.JobCompleted {
		rt.job.Progress = 100
	}
	_ = m.deps.Store.PutJob(rt.job)

	if journalRaw, ok, _ := m.deps.Store.GetKV("generation.journal"); ok {
		var journalID int64
		if _, err := fmt.Sscanf(journalRaw, "%d", &journalID); err == nil && journalID > 0 {
			journalStatus := store.JournalDone
			if status != store.JobCompleted {
				journalStatus = store.JournalFailed
			}
			_ = m.deps.Store.JournalEnd(journalID, journalStatus, detail)
		}
		_ = m.deps.Store.SetKV("generation.journal", "")
	}

	policy := m.policyFor(rt.job.Profile)
	if status == store.JobCompleted {
		generatedStatus := "partial"
		if rt.job.DimensionIndex+1 >= len(rt.dimensions) {
			generatedStatus = "complete"
		}
		if m.deps.UpdateWorldMeta != nil {
			if err := m.deps.UpdateWorldMeta(rt.job.WorldID, rt.params.RadiusBlocks,
				rt.params.BorderRadiusBlocks, generatedStatus, rt.job.ID); err != nil {
				m.log.Warn("could not record generation result on the world", "error", err)
			}
		}
		if rt.params.ApplyWorldBorder && rt.params.BorderRadiusBlocks > 0 && m.deps.Supervisor.IsRunning() {
			diameter := rt.params.BorderRadiusBlocks * 2
			if err := m.deps.Supervisor.Send(fmt.Sprintf("worldborder set %d", diameter)); err != nil {
				m.log.Warn("could not set the world border", "error", err)
			}
		}
	}

	m.deps.Bus.Publish(events.TypeGenerationDone, map[string]any{
		"job": rt.job.ID, "status": status, "detail": detail,
		"chunks": rt.job.ChunksDone, "elapsed_ms": rt.job.ElapsedMs,
	})

	// Post-run actions run after the lease is released so a restart is not
	// blocked by the generation activity.
	postBackup := policy.BackupAfterCompletion && status == store.JobCompleted && m.deps.Backup != nil
	restart := policy.RestartAfterCompletion && status == store.JobCompleted
	stopAfter := policy.StopAfterCompletion && status == store.JobCompleted
	clearMaintenance := policy.MaintenanceBlocksPlayers

	if postBackup {
		if err := m.deps.Backup(ctx, rt.job.WorldID, "post_generation", "after terrain generation", rt.lease); err != nil {
			m.deps.Bus.Warn("generation", "post-generation backup failed: "+err.Error())
		}
	}
	m.deps.Supervisor.Release(rt.lease)

	if clearMaintenance {
		if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.MaintenanceMode = false }); err != nil {
			m.log.Warn("could not clear maintenance mode", "error", err)
		}
	}
	switch {
	case stopAfter:
		m.deps.Supervisor.Note("stopping Minecraft after terrain generation")
		if err := m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "after terrain generation"}); err != nil {
			m.deps.Bus.Warn("generation", "could not stop the server after generation: "+err.Error())
		}
	case restart:
		m.deps.Supervisor.Note("restarting Minecraft after terrain generation")
		if err := m.deps.Supervisor.Restart(ctx, "after terrain generation"); err != nil {
			m.deps.Bus.Warn("generation", "could not restart the server after generation: "+err.Error())
		}
	}
}

// ------------------------------------------------------------------ progress --

// HandleLog consumes console events. It is wired into the supervisor so Chunky's
// own output drives the job state.
func (m *Manager) HandleLog(ev adapter.LogEvent) {
	switch ev.Kind {
	case adapter.KindGenProgress:
		m.updateProgress(ev)
	case adapter.KindGenTaskDone:
		m.advance()
	case adapter.KindGenTaskCancelled:
		m.mu.Lock()
		active := m.cur != nil
		manual := m.cur != nil && m.cur.pausedManual
		m.mu.Unlock()
		// Chunky reports a cancellation for our own pause command too; only treat
		// it as a cancellation when we did not ask for a pause.
		if active && !manual {
			m.log.Info("chunky reported the task was cancelled")
		}
	case adapter.KindGenNotInstalled:
		m.deps.Bus.Fail("generation", "the server does not know the chunky command; install the plugin and restart")
	case adapter.KindPlayerJoin:
		m.mu.Lock()
		if m.cur != nil {
			m.cur.lastPlayerAt = time.Now()
		}
		m.mu.Unlock()
	case adapter.KindPlayerLeave:
		m.mu.Lock()
		if m.cur != nil {
			m.cur.lastPlayerAt = time.Now()
		}
		m.mu.Unlock()
	}
}

func (m *Manager) updateProgress(ev adapter.LogEvent) {
	m.mu.Lock()
	rt := m.cur
	if rt == nil {
		m.mu.Unlock()
		return
	}
	if ev.ChunksTotal > 0 {
		// Chunky reports per-dimension numbers; the job total spans all selected
		// dimensions.
		completedDims := int64(rt.job.DimensionIndex)
		rt.job.ChunksTotal = ev.ChunksTotal * int64(len(rt.dimensions))
		rt.job.ChunksDone = completedDims*ev.ChunksTotal + ev.ChunksDone
	}
	if ev.Percent > 0 {
		perDim := 100.0 / float64(len(rt.dimensions))
		rt.job.Progress = float64(rt.job.DimensionIndex)*perDim + ev.Percent*perDim/100
	}
	if ev.Rate > 0 {
		rt.rateSamples = append(rt.rateSamples, ev.Rate)
		if len(rt.rateSamples) > 10 {
			rt.rateSamples = rt.rateSamples[len(rt.rateSamples)-10:]
		}
		var sum float64
		for _, r := range rt.rateSamples {
			sum += r
		}
		rt.job.Rate = sum / float64(len(rt.rateSamples))
	}
	rt.job.ElapsedMs = time.Since(rt.startedAt).Milliseconds()
	rt.lastProgress = time.Now()
	job := rt.job
	payload := m.progressPayload(rt)
	m.mu.Unlock()

	_ = m.deps.Store.PutJob(job)
	m.deps.Bus.Publish(events.TypeGenerationProgress, payload)
}

func (m *Manager) progressPayload(rt *runtime) map[string]any {
	dim := ""
	if rt.job.DimensionIndex < len(rt.dimensions) {
		dim = rt.dimensions[rt.job.DimensionIndex]
	}
	return map[string]any{
		"job":          rt.job.ID,
		"world":        rt.job.WorldID,
		"dimension":    dim,
		"status":       rt.job.Status,
		"progress":     rt.job.Progress,
		"chunks_done":  rt.job.ChunksDone,
		"chunks_total": rt.job.ChunksTotal,
		"rate":         rt.job.Rate,
		"elapsed_ms":   rt.job.ElapsedMs,
		"pause_reason": rt.job.PauseReason,
	}
}

// advance moves to the next dimension, or completes the job.
func (m *Manager) advance() {
	m.mu.Lock()
	rt := m.cur
	if rt == nil {
		m.mu.Unlock()
		return
	}
	next := rt.job.DimensionIndex + 1
	done := next >= len(rt.dimensions)
	m.mu.Unlock()

	if done {
		m.deps.Supervisor.Note("terrain generation finished")
		m.finish(context.Background(), store.JobCompleted, "all dimensions generated")
		return
	}
	m.deps.Supervisor.Note("dimension %s finished, continuing with %s",
		rt.dimensions[rt.job.DimensionIndex], rt.dimensions[next])
	if err := m.startDimension(rt, next); err != nil {
		m.finish(context.Background(), store.JobFailed, err.Error())
	}
}

func newJobID() string {
	return fmt.Sprintf("gen-%s", time.Now().UTC().Format("20060102T150405"))
}

func minFloat(a, b float64) float64 {
	if a == 0 {
		return b
	}
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value := float64(n)
	for _, u := range []string{"KiB", "MiB", "GiB", "TiB"} {
		value /= unit
		if value < unit {
			return fmt.Sprintf("%.1f %s", value, u)
		}
	}
	return fmt.Sprintf("%.1f PiB", value)
}
