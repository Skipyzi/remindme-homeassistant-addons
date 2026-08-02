package supervisor

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

func newSupervisor(t *testing.T, mode string) (*Supervisor, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	env.AcceptEULA()
	env.WriteFakeJar()

	fake := testsupport.FakeBinary(t, "fakepaper")
	t.Setenv("FAKEPAPER_MODE", mode)

	sup := New(Deps{
		Paths:          env.Paths,
		Settings:       env.Settings,
		Store:          env.Store,
		Bus:            env.Bus,
		Backend:        paper.New(),
		Log:            env.Log,
		JavaBin:        fake,
		ServerPort:     25565,
		Flags:          paper.FlagProfile,
		ConsoleHistory: 500,
		ReadyTimeout:   10 * time.Second,
		ExtraEnv:       func() []string { return []string{"FAKEPAPER_MODE=" + os.Getenv("FAKEPAPER_MODE")} },
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = sup.Shutdown(ctx)
	})
	return sup, env
}

func TestStartReachesRunningAndCapturesConsole(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")

	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := sup.WaitReady(ctx); err != nil {
		t.Fatalf("wait ready: %v", err)
	}

	snapshot := sup.Snapshot()
	if snapshot.State != StateRunning {
		t.Fatalf("expected running, got %s", snapshot.State)
	}
	if snapshot.PID == 0 {
		t.Fatal("expected a pid")
	}
	if snapshot.Version != "1.21.4" {
		t.Fatalf("expected the version to be parsed from the console, got %q", snapshot.Version)
	}
	if !hasConsoleLine(sup, "Done (") {
		t.Fatal("expected the ready line in the console history")
	}
	if _, err := os.Stat(sup.deps.Paths.PidFile()); err != nil {
		t.Fatalf("expected a pid file: %v", err)
	}
}

func TestStartRefusesWithoutEULAOrJar(t *testing.T) {
	sup, env := newSupervisor(t, "ready")

	if _, err := env.Settings.Update(func(s *appcfg.Settings) { s.EULAAccepted = false }); err != nil {
		t.Fatal(err)
	}
	if err := sup.Start(); !errors.Is(err, ErrEULANotAccepted) {
		t.Fatalf("expected ErrEULANotAccepted, got %v", err)
	}

	env.AcceptEULA()
	if err := os.Remove(env.Paths.ServerJar()); err != nil {
		t.Fatal(err)
	}
	if err := sup.Start(); !errors.Is(err, ErrJarMissing) {
		t.Fatalf("expected ErrJarMissing, got %v", err)
	}
}

func TestDuplicateStartIsRefused(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")
	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitReady(t, sup)
	if err := sup.Start(); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("expected ErrAlreadyRunning, got %v", err)
	}
}

func TestGracefulStopFlushesAndExitsCleanly(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")
	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitReady(t, sup)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := sup.Stop(ctx, StopOptions{Reason: "test"}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	snapshot := sup.Snapshot()
	if snapshot.State != StateStopped {
		t.Fatalf("expected stopped, got %s", snapshot.State)
	}
	if snapshot.LastExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", snapshot.LastExitCode)
	}
	if !hasConsoleLine(sup, "Saved the game") {
		t.Fatal("expected the world to be flushed before the stop command")
	}
	if _, err := os.Stat(sup.deps.Paths.PidFile()); !os.IsNotExist(err) {
		t.Fatal("expected the pid file to be removed")
	}
}

func TestStopTimeoutEscalatesToASignal(t *testing.T) {
	sup, _ := newSupervisor(t, "ignore_stop")
	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitReady(t, sup)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	start := time.Now()
	if err := sup.Stop(ctx, StopOptions{Reason: "test", Timeout: 2 * time.Second}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 2*time.Second {
		t.Fatalf("stop returned before the timeout elapsed (%s)", elapsed)
	}
	if state := sup.State(); state != StateStopped {
		t.Fatalf("expected stopped after escalation, got %s", state)
	}
}

func TestCrashIsDetectedWithItsExitCode(t *testing.T) {
	sup, _ := newSupervisor(t, "crash_late")
	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if sup.State() == StateCrashed {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	snapshot := sup.Snapshot()
	if snapshot.State != StateCrashed {
		t.Fatalf("expected crashed, got %s", snapshot.State)
	}
	if snapshot.LastExitCode == 0 {
		t.Fatal("expected a non-zero exit code")
	}
	if snapshot.CrashCount != 1 {
		t.Fatalf("expected one crash, got %d", snapshot.CrashCount)
	}
	if sup.DesiredRunning() {
		t.Fatal("a crash must not leave desired_running set for the reconciler")
	}
}

func TestIntentionalStopIsNotACrash(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")
	if err := sup.Start(); err != nil {
		t.Fatal(err)
	}
	waitReady(t, sup)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := sup.Stop(ctx, StopOptions{Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	if snapshot := sup.Snapshot(); snapshot.CrashCount != 0 {
		t.Fatalf("an intentional stop was counted as a crash (%d)", snapshot.CrashCount)
	}
}

func TestSaveDisabledFlagTracksTheConsole(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")
	if err := sup.Start(); err != nil {
		t.Fatal(err)
	}
	waitReady(t, sup)

	if err := sup.Send("save-off"); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool { return sup.SaveDisabled() })

	sup.EnsureSaveOn()
	waitFor(t, 5*time.Second, func() bool { return !sup.SaveDisabled() })
}

func TestLeasesAreExclusive(t *testing.T) {
	sup, _ := newSupervisor(t, "ready")
	lease, err := sup.Acquire(ActivityBackup)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := sup.Acquire(ActivityRestore); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy, got %v", err)
	}
	// A nested operation reuses the parent lease instead of deadlocking.
	reused, mine, err := sup.AcquireOrReuse(lease, ActivityRestore)
	if err != nil || mine || reused != lease {
		t.Fatalf("expected the parent lease to be reused: reused=%v mine=%v err=%v", reused == lease, mine, err)
	}
	if snapshot := sup.Snapshot(); snapshot.State != State(ActivityBackup) {
		t.Fatalf("expected the activity to be the reported state, got %s", snapshot.State)
	}
	sup.Release(lease)
	if _, err := sup.Acquire(ActivityRestore); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
}

func TestValidateCommandRejectsInjection(t *testing.T) {
	if err := ValidateCommand("say hello"); err != nil {
		t.Fatalf("valid command rejected: %v", err)
	}
	for _, bad := range []string{"", "op me\nstop", "op me\r\nstop", "bad\x00command", strings.Repeat("x", 513)} {
		if err := ValidateCommand(bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func waitReady(t *testing.T, sup *Supervisor) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := sup.WaitReady(ctx); err != nil {
		t.Fatalf("wait ready: %v", err)
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition was not met in time")
}

func hasConsoleLine(sup *Supervisor, substring string) bool {
	for _, line := range sup.Console(0, 500) {
		if strings.Contains(line.Text, substring) {
			return true
		}
	}
	return false
}
