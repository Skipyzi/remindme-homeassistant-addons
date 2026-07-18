package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const CurrentVersion = 1

const (
	PhaseIdle        = "idle"
	PhasePreflight   = "preflight"
	PhaseDownloading = "downloading"
	PhaseVerifying   = "verifying"
	PhaseActivating  = "activating"
	PhaseProbing     = "probing"
	PhaseRollback    = "rollback"
	PhaseActive      = "active"
	PhaseFailed      = "failed"
	PhaseDegraded    = "degraded"
)

const (
	ActionNone     = "none"
	ActionStart    = "start"
	ActionRestore  = "restore"
	ActionResume   = "resume"
	ActionDegraded = "degraded"
)

type Installed struct {
	ID          string    `json:"id"`
	Repo        string    `json:"repo"`
	File        string    `json:"file"`
	Path        string    `json:"path"`
	Healthy     bool      `json:"healthy"`
	ActivatedAt time.Time `json:"activatedAt"`
}

type Operation struct {
	ID           string    `json:"id"`
	VariantID    string    `json:"variantId"`
	ModelPath    string    `json:"modelPath"`
	Phase        string    `json:"phase"`
	BytesDone    int64     `json:"bytesDone"`
	BytesTotal   int64     `json:"bytesTotal"`
	StartedAt    time.Time `json:"startedAt"`
	ErrorCode    string    `json:"errorCode,omitempty"`
	ErrorMessage string    `json:"errorMessage,omitempty"`
}

type LastError struct {
	Code    string    `json:"code"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

type State struct {
	Version              int         `json:"version"`
	Phase                string      `json:"phase"`
	Active               *Installed  `json:"active,omitempty"`
	Fallback             *Installed  `json:"fallback,omitempty"`
	Operation            *Operation  `json:"operation,omitempty"`
	Failed               []Installed `json:"failed,omitempty"`
	CredentialConfigured bool        `json:"credentialConfigured"`
	LastError            *LastError  `json:"lastError,omitempty"`
}

type Store struct {
	Path string
	Now  func() time.Time
}

type Decision struct {
	Action    string
	Model     *Installed
	Operation *Operation
	Degraded  bool
	Reason    string
}

func (store Store) now() time.Time {
	if store.Now != nil {
		return store.Now().UTC()
	}
	return time.Now().UTC()
}

func (store Store) Load() (State, error) {
	data, err := os.ReadFile(store.Path)
	if errors.Is(err, os.ErrNotExist) {
		return State{Version: CurrentVersion, Phase: PhaseIdle}, nil
	}
	if err != nil {
		return State{}, err
	}
	var result State
	if err := json.Unmarshal(data, &result); err != nil {
		quarantine := fmt.Sprintf("%s.corrupt-%d", store.Path, store.now().Unix())
		renameErr := os.Rename(store.Path, quarantine)
		if renameErr != nil {
			return State{Version: CurrentVersion, Phase: PhaseDegraded}, fmt.Errorf("decode state: %w; quarantine: %v", err, renameErr)
		}
		return State{Version: CurrentVersion, Phase: PhaseDegraded}, fmt.Errorf("state was quarantined: %w", err)
	}
	if result.Version != CurrentVersion {
		return State{Version: CurrentVersion, Phase: PhaseDegraded}, fmt.Errorf("unsupported state version %d", result.Version)
	}
	if !validPhase(result.Phase) {
		return State{Version: CurrentVersion, Phase: PhaseDegraded}, fmt.Errorf("invalid state phase %q", result.Phase)
	}
	return result, nil
}

func (store Store) Save(value State) error {
	value.Version = CurrentVersion
	if !validPhase(value.Phase) {
		return fmt.Errorf("invalid state phase %q", value.Phase)
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(store.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temporary := store.Path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, store.Path)
}

func (current State) Begin(operationID, variantID, modelPath string, totalBytes int64) State {
	current.Phase = PhasePreflight
	current.Operation = &Operation{
		ID: operationID, VariantID: variantID, ModelPath: modelPath,
		Phase: PhasePreflight, BytesTotal: totalBytes, StartedAt: time.Now().UTC(),
	}
	current.LastError = nil
	return current
}

func (current State) Transition(phase string, bytesDone int64) State {
	current.Phase = phase
	if current.Operation != nil {
		operation := *current.Operation
		operation.Phase = phase
		operation.BytesDone = bytesDone
		current.Operation = &operation
	}
	return current
}

func (current State) CompleteDownload() State {
	current.Phase = PhaseIdle
	current.Operation = nil
	current.LastError = nil
	return current
}

func (current State) Fail(code, message string) State {
	current.Phase = PhaseFailed
	now := time.Now().UTC()
	current.LastError = &LastError{Code: code, Message: message, At: now}
	if current.Operation != nil {
		operation := *current.Operation
		operation.Phase = PhaseFailed
		operation.ErrorCode = code
		operation.ErrorMessage = message
		current.Operation = &operation
	}
	return current
}

func (current State) Succeed(installed Installed) State {
	installed.Healthy = true
	if installed.ActivatedAt.IsZero() {
		installed.ActivatedAt = time.Now().UTC()
	}
	if current.Active != nil && current.Active.ID != installed.ID && current.Active.Healthy {
		fallback := *current.Active
		current.Fallback = &fallback
	}
	current.Active = &installed
	current.Phase = PhaseActive
	current.Operation = nil
	current.LastError = nil
	return current
}

func Recovery(current State, fileExists func(string) bool) Decision {
	if current.Phase == PhaseDownloading && current.Operation != nil && current.Operation.ModelPath != "" && fileExists(current.Operation.ModelPath) {
		operation := *current.Operation
		return Decision{Action: ActionResume, Operation: &operation}
	}
	critical := current.Phase == PhaseActivating || current.Phase == PhaseProbing || current.Phase == PhaseRollback
	if critical && usable(current.Fallback, fileExists) {
		model := *current.Fallback
		return Decision{Action: ActionRestore, Model: &model, Reason: "activation was interrupted"}
	}
	if usable(current.Active, fileExists) {
		model := *current.Active
		return Decision{Action: ActionStart, Model: &model}
	}
	if usable(current.Fallback, fileExists) {
		model := *current.Fallback
		return Decision{Action: ActionRestore, Model: &model, Reason: "active model is unavailable"}
	}
	return Decision{Action: ActionDegraded, Degraded: true, Reason: "no healthy retained model is available"}
}

func usable(model *Installed, fileExists func(string) bool) bool {
	return model != nil && model.Healthy && model.Path != "" && fileExists(model.Path)
}

func validPhase(phase string) bool {
	switch phase {
	case PhaseIdle, PhasePreflight, PhaseDownloading, PhaseVerifying, PhaseActivating, PhaseProbing, PhaseRollback, PhaseActive, PhaseFailed, PhaseDegraded:
		return true
	default:
		return false
	}
}
