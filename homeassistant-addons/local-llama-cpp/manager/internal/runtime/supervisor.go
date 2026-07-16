package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"remindme.local/model-manager/internal/hardware"
	"remindme.local/model-manager/internal/state"
)

const (
	CodeActivationRolledBack = "activation_failed_rolled_back"
	CodeRollbackFailed       = "rollback_failed"
)

type Config struct {
	Binary   string
	Target   string
	ModelDir string
	Stdout   io.Writer
	Stderr   io.Writer
}

type Process interface {
	Stop(time.Duration) error
	Wait() error
}

type Launcher interface {
	Start(context.Context, string, []string) (Process, error)
}

type Probe func(context.Context) error

type Supervisor struct {
	mu             sync.RWMutex
	config         Config
	launcher       Launcher
	store          state.Store
	probe          Probe
	target         *url.URL
	process        Process
	current        *state.Installed
	currentRuntime hardware.Runtime
	persisted      state.State
}

func NewSupervisor(config Config, launcher Launcher, store state.Store, probe Probe) (*Supervisor, error) {
	if config.Binary == "" || config.ModelDir == "" {
		return nil, errors.New("llama binary and model directory are required")
	}
	target, err := url.Parse(config.Target)
	if err != nil || target.Scheme != "http" || target.Host == "" {
		return nil, errors.New("valid internal llama target is required")
	}
	if launcher == nil {
		launcher = ExecLauncher{Stdout: config.Stdout, Stderr: config.Stderr}
	}
	if probe == nil {
		probe = HTTPProbe(target, &http.Client{Timeout: 10 * time.Second})
	}
	persisted, loadErr := store.Load()
	if loadErr != nil && persisted.Phase != state.PhaseDegraded {
		return nil, loadErr
	}
	return &Supervisor{config: config, launcher: launcher, store: store, probe: probe, target: target, persisted: persisted}, nil
}

func (supervisor *Supervisor) ProxyTarget() *url.URL {
	copy := *supervisor.target
	return &copy
}

func (supervisor *Supervisor) ActiveID() string {
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	if supervisor.current == nil {
		return ""
	}
	return supervisor.current.ID
}

func (supervisor *Supervisor) State() state.State {
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	return cloneState(supervisor.persisted)
}

func (supervisor *Supervisor) Persist(current state.State) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if err := supervisor.store.Save(current); err != nil {
		return err
	}
	supervisor.persisted = cloneState(current)
	return nil
}

func (supervisor *Supervisor) Start(ctx context.Context, installed state.Installed, runtime hardware.Runtime) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.startLocked(ctx, installed, runtime, true)
}

func (supervisor *Supervisor) startLocked(ctx context.Context, installed state.Installed, runtime hardware.Runtime, persist bool) error {
	process, err := supervisor.launcher.Start(ctx, supervisor.config.Binary, llamaArgs(installed, runtime))
	if err != nil {
		return fmt.Errorf("start llama server: %w", err)
	}
	supervisor.process = process
	supervisor.current = copyInstalled(&installed)
	supervisor.currentRuntime = runtime
	if err := supervisor.probeWithTimeout(ctx); err != nil {
		_ = process.Stop(5 * time.Second)
		supervisor.process = nil
		supervisor.current = nil
		return fmt.Errorf("probe llama server: %w", err)
	}
	installed.Healthy = true
	if installed.ActivatedAt.IsZero() {
		installed.ActivatedAt = time.Now().UTC()
	}
	supervisor.current = copyInstalled(&installed)
	if persist {
		supervisor.persisted = supervisor.persisted.Succeed(installed)
		if err := supervisor.store.Save(supervisor.persisted); err != nil {
			return fmt.Errorf("persist active model: %w", err)
		}
	}
	return nil
}

func (supervisor *Supervisor) Activate(ctx context.Context, candidate state.Installed, runtime hardware.Runtime) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.current == nil || supervisor.process == nil {
		return errors.New("no healthy active model is available for rollback")
	}
	previous := *supervisor.current
	previousRuntime := supervisor.currentRuntime
	previousFallback := copyInstalled(supervisor.persisted.Fallback)

	operationID := fmt.Sprintf("activate-%d", time.Now().UnixNano())
	supervisor.persisted = supervisor.persisted.Begin(operationID, candidate.ID, candidate.Path, 0)
	supervisor.persisted.Fallback = copyInstalled(&previous)
	supervisor.persisted.Active = copyInstalled(&candidate)
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseActivating, 0)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return err
	}
	if err := supervisor.process.Stop(20 * time.Second); err != nil {
		return supervisor.rollbackLocked(ctx, previous, previousRuntime, previousFallback, candidate, fmt.Errorf("stop active model: %w", err))
	}
	supervisor.process = nil
	supervisor.current = nil

	process, err := supervisor.launcher.Start(ctx, supervisor.config.Binary, llamaArgs(candidate, runtime))
	if err != nil {
		return supervisor.rollbackLocked(ctx, previous, previousRuntime, previousFallback, candidate, fmt.Errorf("start candidate: %w", err))
	}
	supervisor.process = process
	supervisor.current = copyInstalled(&candidate)
	supervisor.currentRuntime = runtime
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseProbing, 0)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		_ = process.Stop(5 * time.Second)
		return supervisor.rollbackLocked(ctx, previous, previousRuntime, previousFallback, candidate, err)
	}
	if err := supervisor.probeWithTimeout(ctx); err != nil {
		_ = process.Stop(5 * time.Second)
		supervisor.process = nil
		supervisor.current = nil
		return supervisor.rollbackLocked(ctx, previous, previousRuntime, previousFallback, candidate, err)
	}

	candidate.Healthy = true
	candidate.ActivatedAt = time.Now().UTC()
	supervisor.persisted.Active = copyInstalled(&previous)
	supervisor.persisted.Fallback = previousFallback
	supervisor.persisted = supervisor.persisted.Succeed(candidate)
	supervisor.current = copyInstalled(&candidate)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return err
	}
	return supervisor.PruneLocked(supervisor.persisted)
}

func (supervisor *Supervisor) rollbackLocked(ctx context.Context, previous state.Installed, previousRuntime hardware.Runtime, previousFallback *state.Installed, failed state.Installed, cause error) error {
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseRollback, 0)
	failed.Healthy = false
	supervisor.persisted.Failed = append(supervisor.persisted.Failed, failed)
	_ = supervisor.store.Save(supervisor.persisted)

	process, startErr := supervisor.launcher.Start(ctx, supervisor.config.Binary, llamaArgs(previous, previousRuntime))
	if startErr == nil {
		supervisor.process = process
		supervisor.current = copyInstalled(&previous)
		supervisor.currentRuntime = previousRuntime
		startErr = supervisor.probeWithTimeout(ctx)
	}
	if startErr != nil {
		if process != nil {
			_ = process.Stop(5 * time.Second)
		}
		supervisor.process = nil
		supervisor.current = nil
		supervisor.persisted.Phase = state.PhaseDegraded
		supervisor.persisted.Active = nil
		supervisor.persisted.Fallback = previousFallback
		supervisor.persisted.Operation = nil
		supervisor.persisted.LastError = &state.LastError{Code: CodeRollbackFailed, Message: "Candidate and fallback models failed to start.", At: time.Now().UTC()}
		_ = supervisor.store.Save(supervisor.persisted)
		return fmt.Errorf("activation failed (%v) and rollback failed (%v)", cause, startErr)
	}
	previous.Healthy = true
	supervisor.persisted.Phase = state.PhaseActive
	supervisor.persisted.Active = copyInstalled(&previous)
	supervisor.persisted.Fallback = previousFallback
	supervisor.persisted.Operation = nil
	supervisor.persisted.LastError = &state.LastError{Code: CodeActivationRolledBack, Message: "Candidate activation failed; the previous model was restored.", At: time.Now().UTC()}
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return err
	}
	return fmt.Errorf("candidate activation failed; previous model restored: %w", cause)
}

func (supervisor *Supervisor) probeWithTimeout(ctx context.Context) error {
	probeCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	return supervisor.probe(probeCtx)
}

func (supervisor *Supervisor) Stop(timeout time.Duration) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.process == nil {
		return nil
	}
	err := supervisor.process.Stop(timeout)
	supervisor.process = nil
	supervisor.current = nil
	return err
}

func llamaArgs(model state.Installed, runtime hardware.Runtime) []string {
	args := []string{
		"--model", model.Path,
		"--host", "127.0.0.1",
		"--port", "8081",
		"--ctx-size", strconv.Itoa(runtime.Context),
		"--threads", strconv.Itoa(runtime.Threads),
		"--threads-batch", strconv.Itoa(runtime.Threads),
		"--batch-size", strconv.Itoa(runtime.Batch),
		"--ubatch-size", strconv.Itoa(runtime.UBatch),
		"--cache-prompt", "--parallel", "1", "--jinja",
	}
	if runtime.ReasoningFormat != "" && runtime.ReasoningFormat != "none" {
		args = append(args, "--reasoning-format", runtime.ReasoningFormat)
	}
	if runtime.ReasoningMode != "" {
		args = append(args, "--reasoning", runtime.ReasoningMode)
	}
	return args
}

func (supervisor *Supervisor) Prune(current state.State) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.PruneLocked(current)
}

func (supervisor *Supervisor) PruneLocked(current state.State) error {
	modelDir, err := filepath.Abs(supervisor.config.ModelDir)
	if err != nil {
		return err
	}
	protected := make(map[string]bool)
	protect := func(path string) {
		if path == "" {
			return
		}
		absolute, absErr := filepath.Abs(path)
		if absErr == nil {
			protected[filepath.Clean(absolute)] = true
		}
	}
	if current.Active != nil {
		protect(current.Active.Path)
	}
	if current.Fallback != nil {
		protect(current.Fallback.Path)
	}
	if current.Operation != nil {
		protect(current.Operation.ModelPath)
	}
	entries, err := os.ReadDir(modelDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(strings.ToLower(entry.Name()), ".gguf") {
			continue
		}
		path := filepath.Join(modelDir, entry.Name())
		if protected[filepath.Clean(path)] {
			continue
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}

func HTTPProbe(target *url.URL, client *http.Client) Probe {
	return func(ctx context.Context) error {
		healthURL := target.ResolveReference(&url.URL{Path: "/health"})
		healthRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL.String(), nil)
		if err != nil {
			return err
		}
		healthResponse, err := client.Do(healthRequest)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, healthResponse.Body)
		healthResponse.Body.Close()
		if healthResponse.StatusCode != http.StatusOK {
			return fmt.Errorf("health status %d", healthResponse.StatusCode)
		}
		payload, _ := json.Marshal(map[string]any{
			"messages":   []map[string]string{{"role": "user", "content": "Reply OK"}},
			"max_tokens": 8, "temperature": 0, "stream": false,
		})
		completionURL := target.ResolveReference(&url.URL{Path: "/v1/chat/completions"})
		completionRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, completionURL.String(), bytes.NewReader(payload))
		if err != nil {
			return err
		}
		completionRequest.Header.Set("Content-Type", "application/json")
		completionResponse, err := client.Do(completionRequest)
		if err != nil {
			return err
		}
		defer completionResponse.Body.Close()
		if completionResponse.StatusCode != http.StatusOK {
			return fmt.Errorf("completion status %d", completionResponse.StatusCode)
		}
		var body struct {
			Choices []json.RawMessage `json:"choices"`
		}
		if err := json.NewDecoder(io.LimitReader(completionResponse.Body, 1024*1024)).Decode(&body); err != nil || len(body.Choices) == 0 {
			return errors.New("completion probe returned no choices")
		}
		return nil
	}
}

type ExecLauncher struct {
	Stdout io.Writer
	Stderr io.Writer
}

func (launcher ExecLauncher) Start(ctx context.Context, binary string, args []string) (Process, error) {
	command := exec.CommandContext(ctx, binary, args...)
	command.Stdout = launcher.Stdout
	command.Stderr = launcher.Stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	process := &commandProcess{command: command, done: make(chan error, 1)}
	go func() { process.done <- command.Wait() }()
	return process, nil
}

type commandProcess struct {
	command *exec.Cmd
	done    chan error
}

func (process *commandProcess) Stop(timeout time.Duration) error {
	if process.command.Process == nil {
		return nil
	}
	_ = process.command.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-process.done:
		return normalizeExit(err)
	case <-timer.C:
		if err := process.command.Process.Kill(); err != nil {
			return err
		}
		return normalizeExit(<-process.done)
	}
}

func (process *commandProcess) Wait() error {
	return normalizeExit(<-process.done)
}

func normalizeExit(err error) error {
	var exitErr *exec.ExitError
	if err == nil || errors.As(err, &exitErr) {
		return nil
	}
	return err
}

func copyInstalled(model *state.Installed) *state.Installed {
	if model == nil {
		return nil
	}
	copy := *model
	return &copy
}

func cloneState(current state.State) state.State {
	current.Active = copyInstalled(current.Active)
	current.Fallback = copyInstalled(current.Fallback)
	if current.Operation != nil {
		operation := *current.Operation
		current.Operation = &operation
	}
	current.Failed = append([]state.Installed(nil), current.Failed...)
	if current.LastError != nil {
		lastError := *current.LastError
		current.LastError = &lastError
	}
	return current
}
