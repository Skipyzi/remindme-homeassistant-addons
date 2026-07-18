package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/download"
	"remindme.local/model-manager/internal/hardware"
	"remindme.local/model-manager/internal/pairing"
	"remindme.local/model-manager/internal/state"
	"remindme.local/model-manager/internal/verified"
)

type fakeDownloader struct {
	mu      sync.Mutex
	started chan struct{}
	release chan struct{}
	path    string
}

func (fake *fakeDownloader) Inspect(_ context.Context, variant catalog.Variant, _ string) (download.Metadata, error) {
	return download.Metadata{Bytes: variant.ExpectedBytes}, nil
}

func (fake *fakeDownloader) Download(ctx context.Context, variant catalog.Variant, _ string, progress func(download.Progress)) (download.Result, error) {
	fake.mu.Lock()
	if fake.started != nil {
		close(fake.started)
		fake.started = nil
	}
	fake.mu.Unlock()
	if fake.release != nil {
		select {
		case <-fake.release:
		case <-ctx.Done():
			return download.Result{}, &download.Error{Code: download.CodeDownloadInterrupted, SafeMessage: "Download cancelled; the partial file can be resumed.", Retryable: true}
		}
	}
	progress(download.Progress{BytesDone: variant.ExpectedBytes, BytesTotal: variant.ExpectedBytes})
	if err := os.WriteFile(fake.path, []byte("GGUFtest"), 0o600); err != nil {
		return download.Result{}, err
	}
	return download.Result{Path: fake.path, Bytes: variant.ExpectedBytes}, nil
}

type fakeSupervisor struct {
	mu            sync.Mutex
	current       state.State
	active        string
	startCalls    int
	activateCalls int
}

func (fake *fakeSupervisor) State() state.State {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.current
}
func (fake *fakeSupervisor) Persist(current state.State) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.current = current
	return nil
}
func (fake *fakeSupervisor) ActiveID() string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.active
}
func (fake *fakeSupervisor) Start(_ context.Context, installed state.Installed, _ hardware.Runtime) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.startCalls++
	fake.active = installed.ID
	fake.current = fake.current.Succeed(installed)
	return nil
}
func (fake *fakeSupervisor) Activate(_ context.Context, installed state.Installed, _ hardware.Runtime) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.activateCalls++
	fake.active = installed.ID
	fake.current = fake.current.Succeed(installed)
	return nil
}
func (fake *fakeSupervisor) Prune(state.State) error { return nil }

func testCatalog(t *testing.T) catalog.Catalog {
	t.Helper()
	body := []byte("GGUFtest")
	sum := sha256.Sum256(body)
	return catalog.Catalog{Variants: []catalog.Variant{{
		ID: "test-q4", Family: "Test", Repo: "owner/repo", File: "test.gguf",
		Parameters: 1_000_000_000, Quantization: "Q4", ExpectedBytes: int64(len(body)), SHA256: hex.EncodeToString(sum[:]),
		MinimumRAM: 1, RecommendedRAM: 1, NativeContext: 8192, RecommendedContext: 4096,
		Capabilities: []catalog.Capability{catalog.CapabilityChat}, Tier: catalog.TierCompatible, Source: "official",
		Runtime: catalog.RuntimeProfile{Batch: 128, UBatch: 64, Threads: 4, ReasoningMode: "off"},
	}}}
}

func testDependencies(t *testing.T, inferenceURL string) Dependencies {
	t.Helper()
	modelDir := t.TempDir()
	return Dependencies{
		Catalog: testCatalog(t), Token: func() string { return "manager-secret" },
		Facts: func() (hardware.Facts, error) {
			return hardware.Facts{TotalRAM: 8 << 30, FreeRAM: 7 << 30, FreeDisk: 20 << 30, CPUCores: 4, Architecture: "arm64"}, nil
		},
		Downloader: &fakeDownloader{path: filepath.Join(modelDir, "test.gguf")}, Supervisor: &fakeSupervisor{},
		ModelDir: modelDir, Verified: &verified.Store{Path: filepath.Join(t.TempDir(), "verified.json"), ModelDir: modelDir}, CredentialPath: filepath.Join(t.TempDir(), "credentials.json"),
		CustomCatalogPath: filepath.Join(t.TempDir(), "custom.json"), InferenceURL: inferenceURL,
	}
}

func TestManagerRequiresCurrentOptionToken(t *testing.T) {
	server := NewServer(testDependencies(t, "http://127.0.0.1:1"))
	request := httptest.NewRequest(http.MethodGet, "/manager/v1/status", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", response.Code)
	}
}

func TestInferencePathDoesNotRequireManagerToken(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	server := NewServer(testDependencies(t, upstream.URL))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health", nil))
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}` {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}

func TestCatalogResponseOmitsChecksumsAndPaths(t *testing.T) {
	server := NewServer(testDependencies(t, "http://127.0.0.1:1"))
	request := httptest.NewRequest(http.MethodGet, "/manager/v1/catalog", nil)
	request.Header.Set("Authorization", "Bearer manager-secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if strings.Contains(body, "sha256") || strings.Contains(body, "/data/") || strings.Contains(body, "manager-secret") {
		t.Fatalf("private data leaked: %s", body)
	}
}

func TestCredentialWriteReturnsOnlyConfiguredState(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	server := NewServer(dependencies)
	request := httptest.NewRequest(http.MethodPut, "/manager/v1/credentials/huggingface", strings.NewReader(`{"token":"hf_test_secret_value_123456"}`))
	request.Header.Set("Authorization", "Bearer manager-secret")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"configured\":true}\n" {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	stored, err := os.ReadFile(dependencies.CredentialPath)
	if err != nil || !strings.Contains(string(stored), "hf_test_secret_value_123456") {
		t.Fatalf("credential not stored: %s %v", stored, err)
	}
}

func TestInstallDownloadsWithoutChangingRuntime(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	fake := dependencies.Supervisor.(*fakeSupervisor)
	fake.active = "currently-running"
	fake.current = state.State{Phase: state.PhaseActive, Active: &state.Installed{ID: fake.active, Healthy: true}}
	server := NewServer(dependencies)
	request := httptest.NewRequest(http.MethodPost, "/manager/v1/install", strings.NewReader(`{"id":"test-q4"}`))
	request.Header.Set("Authorization", "Bearer manager-secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		current := fake.State()
		if current.Operation == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.active != "currently-running" || fake.startCalls != 0 || fake.activateCalls != 0 {
		t.Fatalf("active=%q start=%d activate=%d", fake.active, fake.startCalls, fake.activateCalls)
	}
	if fake.current.Phase != state.PhaseIdle || fake.current.Operation != nil {
		t.Fatalf("download did not complete cleanly: %#v", fake.current)
	}
}

func TestOptionsYAMLRequiresVerifiedDownload(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	server := NewServer(dependencies)
	request := httptest.NewRequest(http.MethodGet, "/manager/v1/models/test-q4/options.yaml", nil)
	request.Header.Set("Authorization", "Bearer manager-secret")
	before := httptest.NewRecorder()
	server.ServeHTTP(before, request)
	if before.Code != http.StatusConflict || !strings.Contains(before.Body.String(), "model_not_verified") {
		t.Fatalf("before status=%d body=%s", before.Code, before.Body.String())
	}

	install := httptest.NewRequest(http.MethodPost, "/manager/v1/install", strings.NewReader(`{"id":"test-q4"}`))
	install.Header.Set("Authorization", "Bearer manager-secret")
	accepted := httptest.NewRecorder()
	server.ServeHTTP(accepted, install)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && dependencies.Supervisor.State().Operation != nil {
		time.Sleep(time.Millisecond)
	}

	catalogRequest := httptest.NewRequest(http.MethodGet, "/manager/v1/catalog", nil)
	catalogRequest.Header.Set("Authorization", "Bearer manager-secret")
	catalogResponse := httptest.NewRecorder()
	server.ServeHTTP(catalogResponse, catalogRequest)
	if !strings.Contains(catalogResponse.Body.String(), `"verified":true`) {
		t.Fatalf("catalog=%s", catalogResponse.Body.String())
	}

	afterRequest := httptest.NewRequest(http.MethodGet, "/manager/v1/models/test-q4/options.yaml", nil)
	afterRequest.Header.Set("Authorization", "Bearer manager-secret")
	after := httptest.NewRecorder()
	server.ServeHTTP(after, afterRequest)
	if after.Code != http.StatusOK || after.Header().Get("Content-Type") != "text/yaml; charset=utf-8" {
		t.Fatalf("after status=%d headers=%v body=%s", after.Code, after.Header(), after.Body.String())
	}
	for _, expected := range []string{`manager_token: ""`, `hf_token: ""`, "model_path: /data/models/test.gguf", "context_size: 4096"} {
		if !strings.Contains(after.Body.String(), expected) {
			t.Fatalf("yaml missing %q: %s", expected, after.Body.String())
		}
	}
	if strings.Contains(after.Body.String(), "manager-secret") {
		t.Fatal("yaml exposed manager token")
	}
}

func TestObsoleteFallbackMetadataDoesNotBlockRemoval(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	path := filepath.Join(dependencies.ModelDir, "test.gguf")
	if err := os.WriteFile(path, []byte("GGUFtest"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := dependencies.Supervisor.(*fakeSupervisor)
	fake.current = state.State{Phase: state.PhaseIdle, Fallback: &state.Installed{ID: "test-q4", Path: path}}
	server := NewServer(dependencies)
	request := httptest.NewRequest(http.MethodDelete, "/manager/v1/models/test-q4", nil)
	request.Header.Set("Authorization", "Bearer manager-secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestConcurrentMutationReturnsConflict(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	fake := &fakeDownloader{started: make(chan struct{}), release: make(chan struct{}), path: filepath.Join(dependencies.ModelDir, "test.gguf")}
	dependencies.Downloader = fake
	server := NewServer(dependencies)
	first := httptest.NewRequest(http.MethodPost, "/manager/v1/install", strings.NewReader(`{"id":"test-q4"}`))
	first.Header.Set("Authorization", "Bearer manager-secret")
	firstResponse := httptest.NewRecorder()
	server.ServeHTTP(firstResponse, first)
	if firstResponse.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", firstResponse.Code, firstResponse.Body.String())
	}
	<-fake.started
	second := httptest.NewRequest(http.MethodPost, "/manager/v1/install", strings.NewReader(`{"id":"test-q4"}`))
	second.Header.Set("Authorization", "Bearer manager-secret")
	secondResponse := httptest.NewRecorder()
	server.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusConflict {
		t.Fatalf("second status=%d body=%s", secondResponse.Code, secondResponse.Body.String())
	}
	close(fake.release)
}

func TestEventsStreamOperationSnapshot(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	server := NewServer(dependencies)
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	request, _ := http.NewRequest(http.MethodGet, httpServer.URL+"/manager/v1/events", nil)
	request.Header.Set("Authorization", "Bearer manager-secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	buffer := make([]byte, 512)
	count, err := response.Body.Read(buffer)
	if err != nil && err != io.EOF {
		t.Fatal(err)
	}
	if !strings.Contains(string(buffer[:count]), "event: operation") {
		t.Fatalf("unexpected event: %q", buffer[:count])
	}
}

func TestSafeErrorJSONShape(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, http.StatusBadRequest, APIError{Code: "invalid", Message: "Safe message", Retryable: false})
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 3 || body["code"] != "invalid" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

type fakePairing struct {
	token string
	err   error
}

func (fake fakePairing) Exchange(string) (string, error) {
	return fake.token, fake.err
}

func TestPairingExchangeIsCodeAuthenticatedAndSinglePurpose(t *testing.T) {
	dependencies := testDependencies(t, "http://127.0.0.1:1")
	dependencies.Pairing = fakePairing{token: "manager-secret"}
	server := NewServer(dependencies)
	request := httptest.NewRequest(http.MethodPost, "/manager/v1/pair", strings.NewReader(`{"code":"ABC234"}`))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control=%q", response.Header().Get("Cache-Control"))
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["token"] != "manager-secret" {
		t.Fatalf("body=%v", body)
	}
}

func TestPairingErrorsAreIndistinguishableAndRateLimited(t *testing.T) {
	for _, current := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "invalid", err: pairing.ErrInvalidCode, status: http.StatusUnauthorized, code: "pairing_invalid"},
		{name: "limited", err: pairing.ErrRateLimited, status: http.StatusTooManyRequests, code: "pairing_rate_limited"},
	} {
		t.Run(current.name, func(t *testing.T) {
			dependencies := testDependencies(t, "http://127.0.0.1:1")
			dependencies.Pairing = fakePairing{err: current.err}
			server := NewServer(dependencies)
			request := httptest.NewRequest(http.MethodPost, "/manager/v1/pair", strings.NewReader(`{"code":"WRNG22"}`))
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != current.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), current.code) || strings.Contains(response.Body.String(), "WRNG22") {
				t.Fatalf("unsafe body=%s", response.Body.String())
			}
		})
	}
}

var _ = url.URL{}
