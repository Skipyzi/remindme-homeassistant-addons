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
	"sync"
	"sync/atomic"
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
	Binary           string
	Target           string
	ModelDir         string
	Stdout           io.Writer
	Stderr           io.Writer
	ReadinessTimeout time.Duration
	ProbeInterval    time.Duration
	// PresetPath is where the router's model list is written. Defaults to
	// router-models.ini beside the model directory.
	PresetPath string
	// MaxModels is how many models the router keeps loaded at once; the least
	// recently used one is unloaded past it.
	MaxModels int
	// Identify maps a model file name to its catalog ID, or "" when unknown.
	Identify func(file string) string
}

type Process interface {
	Stop(time.Duration) error
	Wait() error
}

type ProcessStatus interface {
	Exited() bool
}

type Launcher interface {
	Start(context.Context, string, []string) (Process, error)
}

// Probe checks that the router can answer with the named model, loading it
// if it is not resident yet.
type Probe func(ctx context.Context, model string) error

// Supervisor runs llama.cpp as a router over every downloaded model. The
// "active" model is the default: requests that name no model, or a model the
// router does not know, are served by it. Switching the default is a pointer
// move plus a load, not a restart, and no model file is ever deleted by a
// switch — so a dictation app on one model and a chat console on another
// can share the add-on without evicting each other.
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
	models         []RouterModel
	names          ModelNames
	persisted      state.State
	emit           func(state.State)
}

// SetEmitter registers a callback invoked with the persisted state after every
// phase transition, so a switch streams activating → probing → active live.
// The callback runs while the supervisor lock is held, so it must not call back
// into the supervisor; publishing to a separate hub is the intended use.
func (supervisor *Supervisor) SetEmitter(emit func(state.State)) {
	supervisor.mu.Lock()
	supervisor.emit = emit
	supervisor.mu.Unlock()
}

// emitState reports the current persisted state to the emitter, if any. Called
// with the lock held.
func (supervisor *Supervisor) emitState() {
	if supervisor.emit != nil {
		supervisor.emit(cloneState(supervisor.persisted))
	}
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
	if config.ReadinessTimeout <= 0 {
		config.ReadinessTimeout = 120 * time.Second
	}
	if config.ProbeInterval <= 0 {
		config.ProbeInterval = 500 * time.Millisecond
	}
	if config.PresetPath == "" {
		config.PresetPath = filepath.Join(filepath.Dir(filepath.Clean(config.ModelDir)), "router-models.ini")
	}
	if config.MaxModels <= 0 {
		config.MaxModels = 2
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

// ResolveModel maps a request's `model` field to a model the router serves;
// empty and unknown names resolve to the default model.
func (supervisor *Supervisor) ResolveModel(requested string) string {
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	return supervisor.names.Resolve(requested)
}

// ResidentLimit is how many models the router keeps loaded at once.
func (supervisor *Supervisor) ResidentLimit() int {
	return supervisor.config.MaxModels
}

// ModelIDs lists the models the router serves, by canonical ID.
func (supervisor *Supervisor) ModelIDs() []string {
	supervisor.mu.RLock()
	defer supervisor.mu.RUnlock()
	ids := make([]string, 0, len(supervisor.models))
	for _, model := range supervisor.models {
		ids = append(ids, model.ID)
	}
	return ids
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
	if err := supervisor.launchRouterLocked(ctx, installed, runtime); err != nil {
		return err
	}
	installed.Healthy = true
	if installed.ActivatedAt.IsZero() {
		installed.ActivatedAt = time.Now().UTC()
	}
	supervisor.current = copyInstalled(&installed)
	supervisor.persisted = supervisor.persisted.Succeed(installed)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return fmt.Errorf("persist active model: %w", err)
	}
	return nil
}

// Reload restarts the router so it picks up models added to or removed from
// the model directory. The default model is unchanged.
func (supervisor *Supervisor) Reload(ctx context.Context) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.current == nil {
		return errors.New("no default model to serve")
	}
	return supervisor.launchRouterLocked(ctx, *supervisor.current, supervisor.currentRuntime)
}

// launchRouterLocked (re)writes the model list, (re)starts the router and
// waits until it answers with the default model.
func (supervisor *Supervisor) launchRouterLocked(ctx context.Context, defaultModel state.Installed, runtime hardware.Runtime) error {
	models, err := ScanModels(filepath.Dir(defaultModel.Path), supervisor.config.Identify)
	if err != nil {
		return fmt.Errorf("scan models: %w", err)
	}
	defaultID := routerIDForPath(models, defaultModel.Path)
	if defaultID == "" {
		return fmt.Errorf("default model %s is not in the model directory", filepath.Base(defaultModel.Path))
	}
	if err := writeFileAtomic(supervisor.config.PresetPath, []byte(RenderPreset(models))); err != nil {
		return fmt.Errorf("write router presets: %w", err)
	}
	if supervisor.process != nil {
		_ = supervisor.process.Stop(20 * time.Second)
		supervisor.process = nil
	}
	process, err := supervisor.launcher.Start(ctx, supervisor.config.Binary, routerArgs(runtime, supervisor.config.PresetPath, supervisor.config.MaxModels))
	if err != nil {
		return fmt.Errorf("start llama router: %w", err)
	}
	supervisor.process = process
	supervisor.models = models
	supervisor.names = NewModelNames(models, defaultID)
	supervisor.current = copyInstalled(&defaultModel)
	supervisor.currentRuntime = runtime
	if err := supervisor.probeWithTimeout(ctx, process, defaultID); err != nil {
		_ = process.Stop(5 * time.Second)
		supervisor.process = nil
		supervisor.current = nil
		return fmt.Errorf("probe llama router: %w", err)
	}
	return nil
}

// Activate makes candidate the default model. The router already serves every
// downloaded model, so this loads the candidate and moves the default to it;
// nothing is restarted unless the candidate was downloaded after the router
// started, and no other model is unloaded from disk.
func (supervisor *Supervisor) Activate(ctx context.Context, candidate state.Installed, runtime hardware.Runtime) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.current == nil || supervisor.process == nil {
		return errors.New("no healthy active model is available for rollback")
	}
	previous := *supervisor.current
	previousFallback := copyInstalled(supervisor.persisted.Fallback)

	operationID := fmt.Sprintf("activate-%d", time.Now().UnixNano())
	supervisor.persisted = supervisor.persisted.Begin(operationID, candidate.ID, candidate.Path, 0)
	supervisor.persisted.Fallback = copyInstalled(&previous)
	supervisor.persisted.Active = copyInstalled(&candidate)
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseActivating, 0)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return err
	}
	supervisor.emitState()

	candidateID := routerIDForPath(supervisor.models, candidate.Path)
	if candidateID == "" {
		// Downloaded after the router started: restart it with the new list,
		// still defaulting to the previous model until the candidate proves out.
		if err := supervisor.launchRouterLocked(ctx, previous, supervisor.currentRuntime); err != nil {
			return supervisor.restoreLocked(ctx, previous, previousFallback, candidate, err)
		}
		candidateID = routerIDForPath(supervisor.models, candidate.Path)
		if candidateID == "" {
			return supervisor.restoreLocked(ctx, previous, previousFallback, candidate, errors.New("candidate file is not in the model directory"))
		}
	}
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseProbing, 0)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return supervisor.restoreLocked(ctx, previous, previousFallback, candidate, err)
	}
	supervisor.emitState()
	if err := supervisor.probeWithTimeout(ctx, supervisor.process, candidateID); err != nil {
		return supervisor.restoreLocked(ctx, previous, previousFallback, candidate, err)
	}

	candidate.Healthy = true
	candidate.ActivatedAt = time.Now().UTC()
	supervisor.persisted.Active = copyInstalled(&previous)
	supervisor.persisted.Fallback = previousFallback
	supervisor.persisted = supervisor.persisted.Succeed(candidate)
	supervisor.current = copyInstalled(&candidate)
	supervisor.names = NewModelNames(supervisor.models, candidateID)
	if err := supervisor.store.Save(supervisor.persisted); err != nil {
		return err
	}
	supervisor.emitState()
	return nil
}

// restoreLocked keeps the previous default after a failed switch. The router
// is only relaunched if it is no longer running.
func (supervisor *Supervisor) restoreLocked(ctx context.Context, previous state.Installed, previousFallback *state.Installed, failed state.Installed, cause error) error {
	supervisor.persisted = supervisor.persisted.Transition(state.PhaseRollback, 0)
	failed.Healthy = false
	supervisor.persisted.Failed = append(supervisor.persisted.Failed, failed)
	_ = supervisor.store.Save(supervisor.persisted)

	var restartErr error
	if status, ok := supervisor.process.(ProcessStatus); supervisor.process == nil || (ok && status.Exited()) {
		restartErr = supervisor.launchRouterLocked(ctx, previous, supervisor.currentRuntime)
	} else {
		supervisor.current = copyInstalled(&previous)
		supervisor.names = NewModelNames(supervisor.models, routerIDForPath(supervisor.models, previous.Path))
	}
	if restartErr != nil {
		supervisor.persisted.Phase = state.PhaseDegraded
		supervisor.persisted.Active = nil
		supervisor.persisted.Fallback = previousFallback
		supervisor.persisted.Operation = nil
		supervisor.persisted.LastError = &state.LastError{Code: CodeRollbackFailed, Message: "Candidate and fallback models failed to start.", At: time.Now().UTC()}
		_ = supervisor.store.Save(supervisor.persisted)
		supervisor.emitState()
		return fmt.Errorf("activation failed (%v) and rollback failed (%v)", cause, restartErr)
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
	supervisor.emitState()
	return fmt.Errorf("candidate activation failed; previous model restored: %w", cause)
}

func routerIDForPath(models []RouterModel, path string) string {
	for _, model := range models {
		if sameFile(model.Path, path) {
			return model.ID
		}
	}
	return ""
}

func sameFile(left, right string) bool {
	leftPath, leftErr := filepath.Abs(left)
	rightPath, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && filepath.Clean(leftPath) == filepath.Clean(rightPath)
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func (supervisor *Supervisor) probeWithTimeout(ctx context.Context, process Process, model string) error {
	probeCtx, cancel := context.WithTimeout(ctx, supervisor.config.ReadinessTimeout)
	defer cancel()
	var lastErr error
	for {
		if err := supervisor.probe(probeCtx, model); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if status, ok := process.(ProcessStatus); ok && status.Exited() {
			return fmt.Errorf("llama server exited before readiness: %w", lastErr)
		}
		timer := time.NewTimer(supervisor.config.ProbeInterval)
		select {
		case <-probeCtx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("readiness timeout: %w", lastErr)
			}
			return fmt.Errorf("readiness canceled: %w", lastErr)
		case <-timer.C:
		}
	}
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

// routerArgs starts llama-server as a router: models come from the preset
// file, and every flag here is passed down to each model it loads.
func routerArgs(runtime hardware.Runtime, presetPath string, maxModels int) []string {
	threadsBatch := runtime.ThreadsBatch
	if threadsBatch <= 0 {
		threadsBatch = runtime.Threads
	}
	// Without a unified KV cache the context is split between slots, and two
	// slots would halve what each request can see. One slot is the safe choice.
	slots := min(max(runtime.Parallel, 1), 4)
	if !runtime.KVUnified {
		slots = 1
	}
	args := []string{
		"--models-preset", presetPath,
		"--models-max", strconv.Itoa(min(max(maxModels, 1), 4)),
		"--host", "127.0.0.1",
		"--port", "8081",
		"--ctx-size", strconv.Itoa(runtime.Context),
		"--threads", strconv.Itoa(runtime.Threads),
		"--threads-batch", strconv.Itoa(threadsBatch),
		"--batch-size", strconv.Itoa(runtime.Batch),
		"--ubatch-size", strconv.Itoa(runtime.UBatch),
		"--cache-prompt", "--parallel", strconv.Itoa(slots),
	}
	if runtime.CacheReuse > 0 {
		args = append(args, "--cache-reuse", strconv.Itoa(runtime.CacheReuse))
	}
	if runtime.Jinja {
		args = append(args, "--jinja")
	}
	if runtime.KVUnified {
		args = append(args, "--kv-unified")
	}
	if runtime.FlashAttention {
		args = append(args, "--flash-attn", "on")
	}
	if runtime.ReasoningFormat != "" && runtime.ReasoningFormat != "none" {
		args = append(args, "--reasoning-format", runtime.ReasoningFormat)
	}
	if runtime.ReasoningMode != "" {
		args = append(args, "--reasoning", runtime.ReasoningMode)
	}
	return args
}

func HTTPProbe(target *url.URL, client *http.Client) Probe {
	return func(ctx context.Context, model string) error {
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
		// A real completion with the model named: this is what loads it into
		// the router, and what proves it can answer.
		payload, _ := json.Marshal(map[string]any{
			"model":      model,
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
	go func() {
		err := command.Wait()
		process.exited.Store(true)
		process.done <- err
	}()
	return process, nil
}

type commandProcess struct {
	command *exec.Cmd
	done    chan error
	exited  atomic.Bool
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

func (process *commandProcess) Exited() bool {
	return process.exited.Load()
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
