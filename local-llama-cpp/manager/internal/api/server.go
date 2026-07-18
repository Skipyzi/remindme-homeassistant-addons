package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/download"
	"remindme.local/model-manager/internal/hardware"
	"remindme.local/model-manager/internal/optionsyaml"
	"remindme.local/model-manager/internal/pairing"
	"remindme.local/model-manager/internal/state"
)

type ModelDownloader interface {
	Inspect(context.Context, catalog.Variant, string) (download.Metadata, error)
	Download(context.Context, catalog.Variant, string, func(download.Progress)) (download.Result, error)
}

type ModelSupervisor interface {
	State() state.State
	Persist(state.State) error
	ActiveID() string
}

type PairingExchanger interface {
	Exchange(string) (string, error)
}

type VerificationStore interface {
	Record(catalog.Variant, string) error
	Has(catalog.Variant) bool
	Remove(string) error
}

type Dependencies struct {
	Catalog           catalog.Catalog
	Token             func() string
	Pairing           PairingExchanger
	Facts             func() (hardware.Facts, error)
	Downloader        ModelDownloader
	Supervisor        ModelSupervisor
	Verified          VerificationStore
	ModelDir          string
	CredentialPath    string
	CustomCatalogPath string
	InferenceURL      string
	Now               func() time.Time
}

type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type OperationSnapshot struct {
	ID         string    `json:"id,omitempty"`
	VariantID  string    `json:"variantId,omitempty"`
	Phase      string    `json:"phase"`
	BytesDone  int64     `json:"bytesDone,omitempty"`
	BytesTotal int64     `json:"bytesTotal,omitempty"`
	Error      *APIError `json:"error,omitempty"`
}

type Server struct {
	dependencies Dependencies
	manager      *http.ServeMux
	proxy        *httputil.ReverseProxy
	mutation     chan struct{}
	cancelMu     sync.Mutex
	cancel       context.CancelFunc
	events       *eventHub
	catalogMu    sync.RWMutex
	catalog      catalog.Catalog
}

type modelSelection struct {
	ID       string `json:"id"`
	Context  int    `json:"context,omitempty"`
	Override bool   `json:"override,omitempty"`
}

type credentials struct {
	HuggingFaceToken string `json:"huggingFaceToken"`
}

type pairingRequest struct {
	Code string `json:"code"`
}

var modelIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,127}$`)
var huggingFaceTokenPattern = regexp.MustCompile(`^hf_[A-Za-z0-9_]{20,}$`)
var pairingCodePattern = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{6}$`)

func NewServer(dependencies Dependencies) *Server {
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	server := &Server{
		dependencies: dependencies,
		manager:      http.NewServeMux(),
		mutation:     make(chan struct{}, 1),
		events:       newEventHub(),
		catalog:      dependencies.Catalog,
	}
	server.proxy = newInferenceProxy(dependencies.InferenceURL)
	server.registerRoutes()
	initial := snapshotFromState(dependencies.Supervisor.State())
	if initial.Phase == "" {
		initial.Phase = state.PhaseIdle
	}
	server.events.publish(initial)
	return server
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if strings.HasPrefix(request.URL.Path, "/manager/v1/") || request.URL.Path == "/manager/v1" {
		server.manager.ServeHTTP(response, request)
		return
	}
	server.proxy.ServeHTTP(response, request)
}

func (server *Server) registerRoutes() {
	server.manager.HandleFunc("POST /manager/v1/pair", server.pair)
	server.manager.Handle("GET /manager/v1/status", server.auth(http.HandlerFunc(server.status)))
	server.manager.Handle("GET /manager/v1/catalog", server.auth(http.HandlerFunc(server.listCatalog)))
	server.manager.Handle("POST /manager/v1/preflight", server.auth(http.HandlerFunc(server.preflight)))
	server.manager.Handle("POST /manager/v1/install", server.auth(http.HandlerFunc(server.install)))
	server.manager.Handle("POST /manager/v1/cancel", server.auth(http.HandlerFunc(server.cancelOperation)))
	server.manager.Handle("DELETE /manager/v1/models/{id}", server.auth(http.HandlerFunc(server.removeModel)))
	server.manager.Handle("GET /manager/v1/models/{id}/options.yaml", server.auth(http.HandlerFunc(server.modelOptionsYAML)))
	server.manager.Handle("POST /manager/v1/catalog/custom", server.auth(http.HandlerFunc(server.addCustom)))
	server.manager.Handle("PUT /manager/v1/credentials/huggingface", server.auth(http.HandlerFunc(server.saveCredentials)))
	server.manager.Handle("GET /manager/v1/events", server.auth(http.HandlerFunc(server.streamEvents)))
}

func (server *Server) pair(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var body pairingRequest
	if !decodeJSON(response, request, &body) || !pairingCodePattern.MatchString(body.Code) {
		if body.Code != "" && !pairingCodePattern.MatchString(body.Code) {
			writeError(response, http.StatusBadRequest, APIError{Code: "invalid_request", Message: "Pairing request is invalid."})
		}
		return
	}
	if server.dependencies.Pairing == nil {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "pairing_unavailable", Message: "Model manager pairing is unavailable.", Retryable: true})
		return
	}
	token, err := server.dependencies.Pairing.Exchange(body.Code)
	if errors.Is(err, pairing.ErrRateLimited) {
		writeError(response, http.StatusTooManyRequests, APIError{Code: "pairing_rate_limited", Message: "Pairing attempts exceeded. Restart the llama.cpp add-on for a new code.", Retryable: true})
		return
	}
	if errors.Is(err, pairing.ErrInvalidCode) {
		writeError(response, http.StatusUnauthorized, APIError{Code: "pairing_invalid", Message: "Pairing code is invalid or expired."})
		return
	}
	if err != nil || token == "" {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "pairing_unavailable", Message: "Model manager pairing is unavailable.", Retryable: true})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"token": token})
}

func (server *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		expected := ""
		if server.dependencies.Token != nil {
			expected = server.dependencies.Token()
		}
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if expected == "" || len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeError(response, http.StatusUnauthorized, APIError{Code: "unauthorized", Message: "Model manager authentication failed."})
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (server *Server) status(response http.ResponseWriter, _ *http.Request) {
	current := server.dependencies.Supervisor.State()
	activeID := server.dependencies.Supervisor.ActiveID()
	var activeModel any
	if variant, ok := server.findVariant(activeID); ok {
		activeModel = variant.Public()
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"state":                current,
		"credentialConfigured": server.credentialConfigured(),
		"operation":            server.events.current(),
		"activeModelId":        activeID,
		"activeModel":          activeModel,
	})
}

func (server *Server) listCatalog(response http.ResponseWriter, _ *http.Request) {
	facts, err := server.dependencies.Facts()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "hardware_unavailable", Message: "Hardware information is unavailable.", Retryable: true})
		return
	}
	server.catalogMu.RLock()
	variants := append([]catalog.Variant(nil), server.catalog.Variants...)
	server.catalogMu.RUnlock()
	current := server.dependencies.Supervisor.State()
	items := make([]map[string]any, 0, len(variants))
	for _, variant := range variants {
		assessment := hardware.Assess(variant, facts, variant.RecommendedContext, false)
		item := map[string]any{"model": variant.Public(), "assessment": assessment, "installed": server.isInstalled(variant), "verified": server.isVerified(variant), "active": current.Active != nil && current.Active.ID == variant.ID, "fallback": current.Fallback != nil && current.Fallback.ID == variant.ID}
		items = append(items, item)
	}
	writeJSON(response, http.StatusOK, map[string]any{"variants": items, "hardware": facts})
}

func (server *Server) preflight(response http.ResponseWriter, request *http.Request) {
	selection, variant, facts, assessment, ok := server.selection(response, request)
	if !ok {
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"selection": selection, "model": variant.Public(), "hardware": facts, "assessment": assessment})
}

func (server *Server) install(response http.ResponseWriter, request *http.Request) {
	_, variant, _, _, ok := server.selection(response, request)
	if !ok {
		return
	}
	if !server.beginMutation(response) {
		return
	}
	operationID := fmt.Sprintf("install-%d", server.dependencies.Now().UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	server.setCancel(cancel)
	current := server.dependencies.Supervisor.State().Begin(operationID, variant.ID, filepath.Join(server.dependencies.ModelDir, variant.File+".partial"), variant.ExpectedBytes)
	current = current.Transition(state.PhaseDownloading, 0)
	if err := server.dependencies.Supervisor.Persist(current); err != nil {
		server.endMutation()
		writeError(response, http.StatusInternalServerError, APIError{Code: "state_write_failed", Message: "Model operation state could not be saved."})
		return
	}
	snapshot := snapshotFromState(current)
	server.events.publish(snapshot)
	writeJSON(response, http.StatusAccepted, map[string]any{"operation": snapshot})
	go server.runInstall(ctx, variant)
}

func (server *Server) runInstall(ctx context.Context, variant catalog.Variant) {
	defer server.endMutation()
	result, err := server.dependencies.Downloader.Download(ctx, variant, server.readCredential(), func(progress download.Progress) {
		current := server.dependencies.Supervisor.State().Transition(state.PhaseDownloading, progress.BytesDone)
		current.Operation.BytesTotal = progress.BytesTotal
		_ = server.dependencies.Supervisor.Persist(current)
		server.events.publish(snapshotFromState(current))
	})
	if err != nil {
		server.failOperation(err)
		return
	}
	current := server.dependencies.Supervisor.State().Transition(state.PhaseVerifying, result.Bytes)
	current.Operation.ModelPath = result.Path
	_ = server.dependencies.Supervisor.Persist(current)
	server.events.publish(snapshotFromState(current))
	if server.dependencies.Verified != nil {
		if err := server.dependencies.Verified.Record(variant, result.Path); err != nil {
			server.failOperation(errors.New("verification state write failed"))
			return
		}
	}
	current = current.CompleteDownload()
	_ = server.dependencies.Supervisor.Persist(current)
	server.events.publish(snapshotFromState(current))
}

func (server *Server) cancelOperation(response http.ResponseWriter, _ *http.Request) {
	server.cancelMu.Lock()
	cancel := server.cancel
	server.cancelMu.Unlock()
	current := server.events.current()
	if cancel == nil || current.Phase != state.PhaseDownloading {
		writeError(response, http.StatusConflict, APIError{Code: "operation_not_cancellable", Message: "Only an active download can be cancelled."})
		return
	}
	cancel()
	writeJSON(response, http.StatusAccepted, map[string]bool{"cancelled": true})
}

func (server *Server) modelOptionsYAML(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	if !modelIDPattern.MatchString(id) {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_model", Message: "Model identifier is invalid."})
		return
	}
	variant, ok := server.findVariant(id)
	if !ok {
		writeError(response, http.StatusNotFound, APIError{Code: "model_not_found", Message: "Model was not found."})
		return
	}
	if !server.isVerified(variant) {
		writeError(response, http.StatusConflict, APIError{Code: "model_not_verified", Message: "Download and verify this model before copying its configuration."})
		return
	}
	facts, err := server.dependencies.Facts()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "hardware_unavailable", Message: "Hardware information is unavailable.", Retryable: true})
		return
	}
	assessment := hardware.Assess(variant, facts, variant.RecommendedContext, false)
	if !assessment.Safe {
		writeError(response, http.StatusUnprocessableEntity, APIError{Code: assessment.Code, Message: firstWarning(assessment.Warnings)})
		return
	}
	body, renderErr := optionsyaml.Render(variant, assessment.Runtime, filepath.ToSlash(filepath.Join("/data/models", variant.File)))
	if renderErr != nil {
		writeError(response, http.StatusInternalServerError, APIError{Code: "options_unavailable", Message: "Model configuration could not be generated."})
		return
	}
	response.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte(body))
}

func (server *Server) removeModel(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	if !modelIDPattern.MatchString(id) {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_model", Message: "Model identifier is invalid."})
		return
	}
	variant, ok := server.findVariant(id)
	if !ok {
		writeError(response, http.StatusNotFound, APIError{Code: "model_not_found", Message: "Model was not found."})
		return
	}
	current := server.dependencies.Supervisor.State()
	if (current.Active != nil && current.Active.ID == id) || (current.Operation != nil && current.Operation.VariantID == id) {
		writeError(response, http.StatusConflict, APIError{Code: "model_protected", Message: "Running and in-progress models cannot be removed."})
		return
	}
	path := filepath.Join(server.dependencies.ModelDir, variant.File)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(response, http.StatusInternalServerError, APIError{Code: "remove_failed", Message: "The model could not be removed."})
		return
	}
	if server.dependencies.Verified != nil {
		if err := server.dependencies.Verified.Remove(id); err != nil {
			writeError(response, http.StatusInternalServerError, APIError{Code: "remove_failed", Message: "The model verification record could not be removed."})
			return
		}
	}
	response.WriteHeader(http.StatusNoContent)
}

func (server *Server) addCustom(response http.ResponseWriter, request *http.Request) {
	var input catalog.CustomInput
	if !decodeJSON(response, request, &input) {
		return
	}
	variant, err := catalog.ValidateCustom(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_custom_model", Message: err.Error()})
		return
	}
	server.catalogMu.Lock()
	if _, exists := server.catalog.Find(variant.ID); exists {
		server.catalogMu.Unlock()
		writeError(response, http.StatusConflict, APIError{Code: "model_exists", Message: "This custom model already exists."})
		return
	}
	server.catalog.Variants = append(server.catalog.Variants, variant)
	custom := make([]catalog.Variant, 0)
	for _, item := range server.catalog.Variants {
		if item.Unverified {
			custom = append(custom, item)
		}
	}
	server.catalogMu.Unlock()
	if err := saveProtectedJSON(server.dependencies.CustomCatalogPath, map[string]any{"variants": custom}); err != nil {
		writeError(response, http.StatusInternalServerError, APIError{Code: "custom_catalog_write_failed", Message: "Custom model settings could not be saved."})
		return
	}
	writeJSON(response, http.StatusCreated, variant.Public())
}

func (server *Server) saveCredentials(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	input.Token = strings.TrimSpace(input.Token)
	if !huggingFaceTokenPattern.MatchString(input.Token) {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_token", Message: "Enter a valid Hugging Face access token."})
		return
	}
	if err := saveProtectedJSON(server.dependencies.CredentialPath, credentials{HuggingFaceToken: input.Token}); err != nil {
		writeError(response, http.StatusInternalServerError, APIError{Code: "credential_write_failed", Message: "Hugging Face access could not be saved."})
		return
	}
	writeJSON(response, http.StatusOK, map[string]bool{"configured": true})
}

func (server *Server) streamEvents(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, APIError{Code: "stream_unavailable", Message: "Progress streaming is unavailable."})
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Accel-Buffering", "no")
	updates, unsubscribe := server.events.subscribe()
	defer unsubscribe()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case snapshot := <-updates:
			data, _ := json.Marshal(snapshot)
			_, _ = response.Write(append(append([]byte("event: operation\ndata: "), data...), []byte("\n\n")...))
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = response.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		case <-request.Context().Done():
			return
		}
	}
}

func (server *Server) selection(response http.ResponseWriter, request *http.Request) (modelSelection, catalog.Variant, hardware.Facts, hardware.Assessment, bool) {
	var selection modelSelection
	if !decodeJSON(response, request, &selection) {
		return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
	}
	if !modelIDPattern.MatchString(selection.ID) {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_model", Message: "Model identifier is invalid."})
		return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
	}
	variant, ok := server.findVariant(selection.ID)
	if !ok {
		writeError(response, http.StatusNotFound, APIError{Code: "model_not_found", Message: "Model was not found."})
		return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
	}
	if variant.Unverified && variant.ExpectedBytes <= 0 {
		metadata, inspectErr := server.dependencies.Downloader.Inspect(request.Context(), variant, server.readCredential())
		if inspectErr != nil {
			server.writeOperationError(response, inspectErr)
			return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
		}
		variant.ExpectedBytes = metadata.Bytes
		variant.Parameters = max(metadata.Bytes*2, 1)
		variant.MinimumRAM = metadata.Bytes + 2*1024*1024*1024
		variant.RecommendedRAM = variant.MinimumRAM + 1024*1024*1024
		server.updateVariant(variant)
	}
	facts, err := server.dependencies.Facts()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "hardware_unavailable", Message: "Hardware information is unavailable.", Retryable: true})
		return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
	}
	contextSize := selection.Context
	if contextSize == 0 {
		contextSize = variant.RecommendedContext
	}
	assessment := hardware.Assess(variant, facts, contextSize, selection.Override)
	if !assessment.Safe {
		status := http.StatusUnprocessableEntity
		writeError(response, status, APIError{Code: assessment.Code, Message: firstWarning(assessment.Warnings)})
		return modelSelection{}, catalog.Variant{}, hardware.Facts{}, hardware.Assessment{}, false
	}
	return selection, variant, facts, assessment, true
}

func (server *Server) findVariant(id string) (catalog.Variant, bool) {
	server.catalogMu.RLock()
	defer server.catalogMu.RUnlock()
	return server.catalog.Find(id)
}

func (server *Server) updateVariant(updated catalog.Variant) {
	server.catalogMu.Lock()
	defer server.catalogMu.Unlock()
	for index := range server.catalog.Variants {
		if server.catalog.Variants[index].ID == updated.ID {
			server.catalog.Variants[index] = updated
			return
		}
	}
}

func (server *Server) writeOperationError(response http.ResponseWriter, err error) {
	var safeErr *download.Error
	if errors.As(err, &safeErr) {
		writeError(response, http.StatusBadGateway, APIError{Code: safeErr.Code, Message: safeErr.SafeMessage, Retryable: safeErr.Retryable})
		return
	}
	writeError(response, http.StatusServiceUnavailable, APIError{Code: "manager_error", Message: "Model operation failed.", Retryable: true})
}

func (server *Server) isInstalled(variant catalog.Variant) bool {
	_, err := os.Stat(filepath.Join(server.dependencies.ModelDir, variant.File))
	return err == nil
}

func (server *Server) isVerified(variant catalog.Variant) bool {
	return server.dependencies.Verified != nil && server.dependencies.Verified.Has(variant)
}

func (server *Server) beginMutation(response http.ResponseWriter) bool {
	select {
	case server.mutation <- struct{}{}:
		return true
	default:
		writeError(response, http.StatusConflict, APIError{Code: "operation_in_progress", Message: "Another model operation is already in progress.", Retryable: true})
		return false
	}
}

func (server *Server) endMutation() {
	server.setCancel(nil)
	select {
	case <-server.mutation:
	default:
	}
}

func (server *Server) setCancel(cancel context.CancelFunc) {
	server.cancelMu.Lock()
	server.cancel = cancel
	server.cancelMu.Unlock()
}

func (server *Server) failOperation(err error) {
	code := "operation_failed"
	message := "Model operation failed."
	retryable := false
	var safeErr *download.Error
	if errors.As(err, &safeErr) {
		code, message, retryable = safeErr.Code, safeErr.SafeMessage, safeErr.Retryable
	}
	current := server.dependencies.Supervisor.State().Fail(code, message)
	_ = server.dependencies.Supervisor.Persist(current)
	snapshot := snapshotFromState(current)
	snapshot.Error = &APIError{Code: code, Message: message, Retryable: retryable}
	server.events.publish(snapshot)
}

func (server *Server) readCredential() string {
	data, err := os.ReadFile(server.dependencies.CredentialPath)
	if err != nil {
		return ""
	}
	var stored credentials
	if json.Unmarshal(data, &stored) != nil {
		return ""
	}
	return stored.HuggingFaceToken
}

func (server *Server) credentialConfigured() bool {
	return server.readCredential() != ""
}

func newInferenceProxy(rawURL string) *httputil.ReverseProxy {
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "http" || target.Host == "" {
		target = &url.URL{Scheme: "http", Host: "127.0.0.1:1"}
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		writeError(response, http.StatusServiceUnavailable, APIError{Code: "inference_unavailable", Message: "The local inference server is unavailable.", Retryable: true})
	}
	return proxy
}

func decodeJSON(response http.ResponseWriter, request *http.Request, destination any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(response, http.StatusBadRequest, APIError{Code: "invalid_request", Message: "Request body is invalid."})
		return false
	}
	return true
}

func saveProtectedJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode protected JSON: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create protected JSON directory: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write protected JSON: %w", err)
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("protect JSON permissions: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("commit protected JSON: %w", err)
	}
	return nil
}

func snapshotFromState(current state.State) OperationSnapshot {
	result := OperationSnapshot{Phase: current.Phase}
	if current.Operation != nil {
		result.ID = current.Operation.ID
		result.VariantID = current.Operation.VariantID
		result.Phase = current.Operation.Phase
		result.BytesDone = current.Operation.BytesDone
		result.BytesTotal = current.Operation.BytesTotal
	}
	return result
}

func firstWarning(warnings []string) string {
	if len(warnings) > 0 {
		return warnings[0]
	}
	return "This model is not safe for the detected hardware."
}

func writeError(response http.ResponseWriter, status int, apiError APIError) {
	writeJSON(response, status, apiError)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

type eventHub struct {
	mu          sync.RWMutex
	snapshot    OperationSnapshot
	subscribers map[chan OperationSnapshot]struct{}
}

func newEventHub() *eventHub {
	return &eventHub{subscribers: make(map[chan OperationSnapshot]struct{})}
}

func (hub *eventHub) current() OperationSnapshot {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	return hub.snapshot
}

func (hub *eventHub) publish(snapshot OperationSnapshot) {
	hub.mu.Lock()
	hub.snapshot = snapshot
	for subscriber := range hub.subscribers {
		select {
		case subscriber <- snapshot:
		default:
		}
	}
	hub.mu.Unlock()
}

func (hub *eventHub) subscribe() (<-chan OperationSnapshot, func()) {
	channel := make(chan OperationSnapshot, 4)
	hub.mu.Lock()
	hub.subscribers[channel] = struct{}{}
	channel <- hub.snapshot
	hub.mu.Unlock()
	return channel, func() {
		hub.mu.Lock()
		delete(hub.subscribers, channel)
		close(channel)
		hub.mu.Unlock()
	}
}
