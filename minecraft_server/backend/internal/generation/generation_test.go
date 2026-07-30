package generation

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

type harness struct {
	env       *testsupport.Env
	manager   *Manager
	sup       *supervisor.Supervisor
	system    stats.System
	telemetry bridge.Telemetry
	fresh     bool
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	env := testsupport.NewEnv(t)
	env.AcceptEULA()
	env.WriteFakeJar()

	h := &harness{env: env}
	h.system = stats.System{
		CPUPercent: 20, CPUTemperatureC: 55, DiskFreeBytes: 200 << 30, DiskTotalBytes: 500 << 30,
	}
	h.telemetry = bridge.Telemetry{TPS: []float64{20, 20, 20}, MSPT: 10, ReceivedAt: time.Now()}
	h.fresh = true

	fake := testsupport.FakeBinary(t, "fakepaper")
	h.sup = supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: paper.New(), Log: env.Log, JavaBin: fake, Flags: paper.FlagProfile,
		ReadyTimeout: 8 * time.Second,
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = h.sup.Shutdown(ctx)
	})

	h.manager = NewManager(Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Supervisor: h.sup, Backend: paper.New(), Options: env.Options, Log: env.Log,
		Stats:     func() stats.System { return h.system },
		Telemetry: func() (bridge.Telemetry, bool) { return h.telemetry, h.fresh },
		WorldDir: func(id string) (string, error) {
			return appcfg.Confine(env.Paths.Worlds(), id)
		},
		ServerVersion: func() string { return "1.21.4" },
		GuardInterval: 20 * time.Millisecond,
	})
	return h
}

func TestChunkCountMatchesShape(t *testing.T) {
	// A square of radius 1600 blocks is 201x201 chunks.
	if got := ChunkCount("square", 1600); got != 201*201 {
		t.Fatalf("square: got %d", got)
	}
	circle := ChunkCount("circle", 1600)
	expected := int64(math.Ceil(math.Pi * 100 * 100))
	if circle != expected {
		t.Fatalf("circle: got %d, want %d", circle, expected)
	}
	if ChunkCount("square", 0) != 0 {
		t.Fatal("a zero radius must produce no chunks")
	}
}

func TestMeasureBytesPerChunkReadsRegionHeaders(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "world")
	regionDir := filepath.Join(dir, "region")
	if err := os.MkdirAll(regionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 100 present chunks in a 1 MiB region file: 10.24 KiB per chunk.
	const present = 100
	header := make([]byte, 8192)
	for i := 0; i < present; i++ {
		offset := uint32(2 + i)
		binary.BigEndian.PutUint32(header[i*4:], offset<<8|1)
	}
	body := make([]byte, (1<<20)-len(header))
	if err := os.WriteFile(filepath.Join(regionDir, "r.0.0.mca"), append(header, body...), 0o644); err != nil {
		t.Fatal(err)
	}

	bpc, chunks, err := MeasureBytesPerChunk(dir)
	if err != nil {
		t.Fatalf("measure: %v", err)
	}
	if chunks != present {
		t.Fatalf("expected %d chunks, counted %d", present, chunks)
	}
	if bpc < 10_000 || bpc > 11_000 {
		t.Fatalf("expected about 10.5 KiB per chunk, got %.0f", bpc)
	}
}

func TestEstimateRefusesWithoutEnoughSpace(t *testing.T) {
	h := newHarness(t)
	worldDir := filepath.Join(h.env.Paths.Worlds(), "survival")
	if err := os.MkdirAll(filepath.Join(worldDir, "world"), 0o755); err != nil {
		t.Fatal(err)
	}

	params := Params{WorldID: "survival", Shape: "square", RadiusBlocks: 3000, Profile: ProfileGentle}
	estimate, err := h.manager.Estimate(params)
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if estimate.Measured {
		t.Error("a fresh world has nothing to measure")
	}
	if estimate.LowBytes >= estimate.HighBytes {
		t.Error("the estimate must be a range")
	}
	if !estimate.Sufficient {
		t.Fatalf("200 GB free should be enough for %s", humanBytes(estimate.SafeBytes))
	}

	h.system.DiskFreeBytes = 5 << 30
	estimate, err = h.manager.Estimate(params)
	if err != nil {
		t.Fatal(err)
	}
	if estimate.Sufficient {
		t.Fatal("5 GB free must not be reported as sufficient")
	}

	// An unknown free space figure is treated as unsafe, never as unlimited.
	h.system.DiskFreeBytes = 0
	estimate, _ = h.manager.Estimate(params)
	if estimate.Sufficient {
		t.Fatal("unknown free space must not be reported as sufficient")
	}
}

func TestEstimateWarnsWhenTheBorderExceedsGeneratedTerrain(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	estimate, err := h.manager.Estimate(Params{
		WorldID: "survival", Shape: "square", RadiusBlocks: 4000,
		BorderRadiusBlocks: 4000, SafetyMarginBlocks: 500, Profile: ProfileGentle,
	})
	if err != nil {
		t.Fatal(err)
	}
	if estimate.BorderWarning == "" {
		t.Fatal("expected a warning when the playable border reaches the generated edge")
	}

	estimate, err = h.manager.Estimate(Params{
		WorldID: "survival", Shape: "square", RadiusBlocks: 4500,
		BorderRadiusBlocks: 4000, SafetyMarginBlocks: 500, Profile: ProfileGentle,
	})
	if err != nil {
		t.Fatal(err)
	}
	if estimate.BorderWarning != "" {
		t.Fatalf("a 500 block margin should not warn: %s", estimate.BorderWarning)
	}
}

func TestParamsValidation(t *testing.T) {
	valid := Params{WorldID: "survival", RadiusBlocks: 1000}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}
	cases := []Params{
		{RadiusBlocks: 1000},
		{WorldID: "w", RadiusBlocks: 5},
		{WorldID: "w", RadiusBlocks: 1000, SafetyMarginBlocks: 2000},
		{WorldID: "w", RadiusBlocks: 1000, Profile: "turbo"},
		{WorldID: "w", RadiusBlocks: 1000, Dimensions: []string{"nether"}},
		{WorldID: "w", RadiusBlocks: 1000, CenterX: 99_000_000},
	}
	for i, params := range cases {
		if err := params.Validate(); err == nil {
			t.Errorf("case %d should have been rejected", i)
		}
	}
}

func TestDimensionListIsCanonicallyOrdered(t *testing.T) {
	params := Params{Dimensions: []string{"world_the_end", "world"}}
	got := params.dimensionList()
	if len(got) != 2 || got[0] != "world" || got[1] != "world_the_end" {
		t.Fatalf("unexpected order %v", got)
	}
	if only := (Params{}).dimensionList(); len(only) != 1 || only[0] != "world" {
		t.Fatalf("expected the Overworld by default, got %v", only)
	}
}

func TestGuardsPauseOnPlayersTemperatureAndTPS(t *testing.T) {
	policy := appcfg.DefaultGenerationPolicy()
	guard := GuardSnapshot{TPS: 20, MSPT: 10, CPUTemperatureC: 50, SystemCPUPct: 20, WithinHours: true}
	rt := &runtime{}

	if reasons := pauseReasons(policy, guard, rt); len(reasons) != 0 {
		t.Fatalf("a healthy server should not pause: %v", reasons)
	}

	guard.PlayersOnline = 1
	if reasons := pauseReasons(policy, guard, rt); !contains(reasons, ReasonPlayersOnline) {
		t.Fatalf("expected a player pause, got %v", reasons)
	}
	guard.PlayersOnline = 0

	guard.TPS = 17
	if reasons := pauseReasons(policy, guard, rt); !contains(reasons, ReasonLowTPS) {
		t.Fatalf("expected a TPS pause, got %v", reasons)
	}
	guard.TPS = 20

	guard.CPUTemperatureC = 80
	if reasons := pauseReasons(policy, guard, rt); !contains(reasons, ReasonTemperature) {
		t.Fatalf("expected a temperature pause, got %v", reasons)
	}
	guard.CPUTemperatureC = 50

	guard.SystemCPUPct = 90
	if reasons := pauseReasons(policy, guard, rt); !contains(reasons, ReasonSystemCPU) {
		t.Fatalf("expected a system CPU pause, got %v", reasons)
	}
	guard.SystemCPUPct = 20

	guard.WithinHours = false
	if reasons := pauseReasons(policy, guard, rt); !contains(reasons, ReasonOutsideHours) {
		t.Fatalf("expected an allowed-hours pause, got %v", reasons)
	}
}

func TestHysteresisKeepsAJobPausedInsideTheDeadBand(t *testing.T) {
	policy := appcfg.DefaultGenerationPolicy() // pause below 18 TPS, resume above 19
	rt := &runtime{}
	// 18.5 TPS is above the pause threshold but below the resume threshold: a
	// running job stays running, a paused job stays paused. That gap is what stops
	// a job from flapping.
	guard := GuardSnapshot{TPS: 18.5, MSPT: 10, CPUTemperatureC: 60, SystemCPUPct: 30, WithinHours: true}
	if reasons := pauseReasons(policy, guard, rt); len(reasons) != 0 {
		t.Fatalf("18.5 TPS should not trigger a pause: %v", reasons)
	}
	if blockers := resumeBlockers(policy, guard, rt); !contains(blockers, ReasonLowTPS) {
		t.Fatalf("18.5 TPS should still block a resume: %v", blockers)
	}
	guard.TPS = 19.5
	if blockers := resumeBlockers(policy, guard, rt); len(blockers) != 0 {
		t.Fatalf("19.5 TPS should allow a resume: %v", blockers)
	}
}

func TestResumeWaitsForTheEmptyServerDelay(t *testing.T) {
	policy := appcfg.DefaultGenerationPolicy()
	policy.ResumeAfterEmptyMinutes = 10
	guard := GuardSnapshot{TPS: 20, CPUTemperatureC: 50, SystemCPUPct: 20, WithinHours: true}

	justLeft := &runtime{lastPlayerAt: time.Now()}
	if blockers := resumeBlockers(policy, guard, justLeft); !contains(blockers, ReasonEmptyDelay) {
		t.Fatalf("expected the empty-server delay to block a resume: %v", blockers)
	}
	longGone := &runtime{lastPlayerAt: time.Now().Add(-20 * time.Minute)}
	if blockers := resumeBlockers(policy, guard, longGone); len(blockers) != 0 {
		t.Fatalf("expected a resume after the delay: %v", blockers)
	}
}

func TestProfilesWidenOrTightenThePolicy(t *testing.T) {
	h := newHarness(t)

	gentle := h.manager.policyFor(ProfileGentle)
	if !gentle.AllowedHours.Enabled || !gentle.OnlyWhenNoPlayers {
		t.Fatal("gentle must keep the configured restrictions")
	}
	balanced := h.manager.policyFor(ProfileBalanced)
	if balanced.AllowedHours.Enabled {
		t.Error("balanced should ignore the allowed hours window")
	}
	if !balanced.OnlyWhenNoPlayers {
		t.Error("balanced should still yield to players")
	}
	maximum := h.manager.policyFor(ProfileMaximum)
	if !maximum.MaintenanceBlocksPlayers || !maximum.RestartAfterCompletion {
		t.Error("maximum should block players and restart afterwards")
	}
	if maximum.PauseWhen.TPSBelow != 0 || maximum.PauseWhen.SystemCPUAbovePct != 0 {
		t.Error("maximum should only respect the physical limits")
	}
	if maximum.PauseWhen.CPUTemperatureAboveC < 78 {
		t.Error("maximum must keep a thermal limit")
	}
}

func TestStartRequiresPluginServerAndSpace(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	params := Params{WorldID: "survival", RadiusBlocks: 1000, Profile: ProfileGentle}

	if _, err := h.manager.Start(t.Context(), params, "tester"); !errors.Is(err, ErrNoPlugin) {
		t.Fatalf("expected ErrNoPlugin, got %v", err)
	}

	// Install a fake plugin jar so the next check is reached.
	if err := os.WriteFile(filepath.Join(h.env.Paths.Plugins(), "Chunky.jar"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.Start(t.Context(), params, "tester"); !errors.Is(err, ErrServerStopped) {
		t.Fatalf("expected ErrServerStopped, got %v", err)
	}
}

func TestGenerationRunAdvancesAndCompletes(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.env.Paths.Plugins(), "Chunky.jar"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Settings.Update(func(s *appcfg.Settings) {
		s.Generation.BackupBeforeStart = false
		s.Generation.BackupAfterCompletion = false
		s.Generation.AllowedHours.Enabled = false
		s.Generation.MinDwellSeconds = 1
	}); err != nil {
		t.Fatal(err)
	}

	if err := h.sup.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	if err := h.sup.WaitReady(t.Context()); err != nil {
		t.Fatalf("wait ready: %v", err)
	}
	// Chunky output drives the manager, exactly as in production.
	go func() { _ = h.sup.Watch(t.Context(), func(ev adapter.LogEvent) bool { h.manager.HandleLog(ev); return false }) }()

	job, err := h.manager.Start(t.Context(), Params{
		WorldID: "survival", RadiusBlocks: 500, Profile: ProfileGentle, Shape: "square",
	}, "tester")
	if err != nil {
		t.Fatalf("start job: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		record, ok, err := h.env.Store.GetJob(job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if ok && record.Status == store.JobCompleted {
			if record.Progress < 99 {
				t.Fatalf("a completed job should report full progress, got %.1f", record.Progress)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	record, _, _ := h.env.Store.GetJob(job.ID)
	t.Fatalf("job did not complete in time, last state %+v", record)
}

func TestPauseAndResumeAreRecorded(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.env.Paths.Plugins(), "Chunky.jar"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Settings.Update(func(s *appcfg.Settings) {
		s.Generation.BackupBeforeStart = false
		s.Generation.AllowedHours.Enabled = false
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.Start(); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.WaitReady(t.Context()); err != nil {
		t.Fatal(err)
	}

	if _, err := h.manager.Start(t.Context(), Params{
		WorldID: "survival", RadiusBlocks: 500, Profile: ProfileGentle,
	}, "tester"); err != nil {
		t.Fatalf("start job: %v", err)
	}
	if err := h.manager.Pause(ReasonManual, "tester"); err != nil {
		t.Fatalf("pause: %v", err)
	}
	status := h.manager.Status()
	if status.Job.Status != store.JobPaused {
		t.Fatalf("expected paused, got %s", status.Job.Status)
	}
	// A manual pause is not undone by the guard loop.
	h.manager.evaluate(t.Context())
	if h.manager.Status().Job.Status != store.JobPaused {
		t.Fatal("the guard loop must not resume a manual pause")
	}
	if err := h.manager.Resume("tester"); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if h.manager.Status().Job.Status != store.JobRunning {
		t.Fatal("expected the job to run again")
	}
}

func TestGuardLoopPausesWhenAPlayerJoins(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.env.Paths.Plugins(), "Chunky.jar"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Settings.Update(func(s *appcfg.Settings) {
		s.Generation.BackupBeforeStart = false
		s.Generation.AllowedHours.Enabled = false
		s.Generation.MinDwellSeconds = 1
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.Start(); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.WaitReady(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.Start(t.Context(), Params{
		WorldID: "survival", RadiusBlocks: 500, Profile: ProfileGentle,
	}, "tester"); err != nil {
		t.Fatal(err)
	}

	// A player joins: the guard loop must pause on the very next tick.
	h.telemetry.OnlinePlayers = 1
	h.manager.evaluate(t.Context())

	status := h.manager.Status()
	if status.Job.Status != store.JobPaused {
		t.Fatalf("expected the job to pause, got %s", status.Job.Status)
	}
	if status.Job.PauseReason != ReasonPlayersOnline {
		t.Fatalf("unexpected pause reason %q", status.Job.PauseReason)
	}
}

func TestLowDiskCancelsTheJob(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.env.Paths.Plugins(), "Chunky.jar"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.Settings.Update(func(s *appcfg.Settings) {
		s.Generation.BackupBeforeStart = false
		s.Generation.BackupAfterCompletion = false
		s.Generation.AllowedHours.Enabled = false
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.Start(); err != nil {
		t.Fatal(err)
	}
	if err := h.sup.WaitReady(t.Context()); err != nil {
		t.Fatal(err)
	}
	job, err := h.manager.Start(t.Context(), Params{
		WorldID: "survival", RadiusBlocks: 500, Profile: ProfileGentle,
	}, "tester")
	if err != nil {
		t.Fatal(err)
	}

	// The disk fills up below the safety threshold.
	h.system.DiskFreeBytes = 2 << 30
	h.manager.evaluate(t.Context())

	record, ok, err := h.env.Store.GetJob(job.ID)
	if err != nil || !ok {
		t.Fatalf("job missing: %v", err)
	}
	if record.Status != store.JobCancelled {
		t.Fatalf("expected the job to be cancelled, got %s", record.Status)
	}
	if h.manager.Status().Active {
		t.Fatal("the manager should have no active job after a cancellation")
	}
}

func TestReconcileAdoptsAnInterruptedJobAsPaused(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.env.Paths.Worlds(), "survival", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	params, err := os.ReadFile(filepath.Join("testdata", "missing"))
	_ = params
	_ = err

	record := store.JobRecord{
		ID: "gen-old", WorldID: "survival", Profile: ProfileGentle, Status: store.JobRunning,
		Params:      []byte(`{"world_id":"survival","radius_blocks":1000,"profile":"gentle"}`),
		Progress:    42,
		ChunksTotal: 1000, ChunksDone: 420,
	}
	if err := h.env.Store.PutJob(record); err != nil {
		t.Fatal(err)
	}

	h.manager.Reconcile(t.Context())

	adopted, ok, err := h.env.Store.GetJob("gen-old")
	if err != nil || !ok {
		t.Fatalf("job missing: %v", err)
	}
	if adopted.Status != store.JobPaused {
		t.Fatalf("expected the job to be paused after a restart, got %s", adopted.Status)
	}
	if adopted.PauseReason != ReasonAddonRestarted {
		t.Fatalf("unexpected pause reason %q", adopted.PauseReason)
	}
	if busy, activity := h.sup.Busy(); !busy || activity != supervisor.ActivityGenerating {
		t.Fatalf("expected the generating lease to be held, got busy=%v activity=%s", busy, activity)
	}
}

func TestVerifyHashRejectsMismatch(t *testing.T) {
	data := []byte("chunky jar")
	if err := verifyHash(data, "sha256:0000"); err == nil {
		t.Fatal("expected a checksum mismatch to be rejected")
	}
	if err := verifyHash(data, "md5:abcd"); err == nil {
		t.Fatal("expected an unsupported algorithm to be rejected")
	}
	// Correct sha256 of the payload above.
	if err := verifyHash(data, "sha256:"+sha256Hex(data)); err != nil {
		t.Fatalf("valid checksum rejected: %v", err)
	}
}

func TestLooksLikeJar(t *testing.T) {
	if !looksLikeJar([]byte{'P', 'K', 3, 4, 0}) {
		t.Error("a zip header should be accepted")
	}
	if looksLikeJar([]byte("<html>not a jar")) {
		t.Error("an HTML error page must not be accepted as a jar")
	}
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
