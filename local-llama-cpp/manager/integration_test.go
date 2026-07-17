package modelmanager_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	managerapi "remindme.local/model-manager/internal/api"
	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/download"
	"remindme.local/model-manager/internal/hardware"
	managerruntime "remindme.local/model-manager/internal/runtime"
	"remindme.local/model-manager/internal/state"
)

type integrationProcess struct{}

func (*integrationProcess) Stop(time.Duration) error { return nil }
func (*integrationProcess) Wait() error              { return nil }

type integrationLauncher struct {
	mu     sync.Mutex
	active string
	starts map[string]int
}

func (launcher *integrationLauncher) Start(_ context.Context, _ string, args []string) (managerruntime.Process, error) {
	model := ""
	for index := 0; index+1 < len(args); index++ {
		if args[index] == "--model" {
			model = filepath.Base(args[index+1])
			break
		}
	}
	launcher.mu.Lock()
	launcher.active = model
	launcher.starts[model]++
	launcher.mu.Unlock()
	return &integrationProcess{}, nil
}

func (launcher *integrationLauncher) activeModel() string {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	return launcher.active
}

func TestInstallProbeFailureRestoresPreviousModel(t *testing.T) {
	candidateBytes := []byte("GGUFbroken")
	candidateHash := sha256.Sum256(candidateBytes)
	huggingFace := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasSuffix(request.URL.Path, "/candidate.gguf") {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Length", "10")
		_, _ = response.Write(candidateBytes)
	}))
	defer huggingFace.Close()

	modelDir := t.TempDir()
	stablePath := filepath.Join(modelDir, "stable.gguf")
	if err := os.WriteFile(stablePath, []byte("GGUFstable"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := state.Store{Path: filepath.Join(t.TempDir(), "state.json")}
	launcher := &integrationLauncher{starts: map[string]int{}}
	supervisor, err := managerruntime.NewSupervisor(
		managerruntime.Config{
			Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: modelDir,
			ReadinessTimeout: 25 * time.Millisecond, ProbeInterval: time.Millisecond,
		},
		launcher,
		store,
		func(context.Context) error {
			if launcher.activeModel() == "candidate.gguf" {
				return errors.New("candidate probe failed")
			}
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	runtimeProfile := hardware.Runtime{Context: 4096, Batch: 128, UBatch: 64, Threads: 4, ReasoningMode: "off"}
	if err := supervisor.Start(context.Background(), state.Installed{ID: "stable", File: "stable.gguf", Path: stablePath, Healthy: true}, runtimeProfile); err != nil {
		t.Fatal(err)
	}
	modelCatalog := catalog.Catalog{Variants: []catalog.Variant{{
		ID: "candidate", Family: "Candidate", Repo: "owner/repo", File: "candidate.gguf",
		Parameters: 1, Quantization: "Q4", ExpectedBytes: int64(len(candidateBytes)), SHA256: hex.EncodeToString(candidateHash[:]),
		MinimumRAM: 1, RecommendedRAM: 1, NativeContext: 4096, RecommendedContext: 4096,
		Capabilities: []catalog.Capability{catalog.CapabilityChat}, Tier: catalog.TierCompatible, Source: "official",
		Runtime: catalog.RuntimeProfile{Batch: 128, UBatch: 64, Threads: 4, ReasoningMode: "off"},
	}}}
	manager := managerapi.NewServer(managerapi.Dependencies{
		Catalog: modelCatalog, Token: func() string { return "integration-secret" },
		Facts: func() (hardware.Facts, error) {
			return hardware.Facts{TotalRAM: 8 << 30, FreeRAM: 7 << 30, FreeDisk: 20 << 30, CPUCores: 4, Architecture: "arm64"}, nil
		},
		Downloader: download.Downloader{Client: huggingFace.Client(), ResolveBase: huggingFace.URL, ModelDir: modelDir, MaxBytes: 1024},
		Supervisor: supervisor, ModelDir: modelDir,
		CredentialPath:    filepath.Join(t.TempDir(), "credentials.json"),
		CustomCatalogPath: filepath.Join(t.TempDir(), "custom.json"),
		InferenceURL:      "http://127.0.0.1:1",
	})
	server := httptest.NewServer(manager)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/manager/v1/install", bytes.NewBufferString(`{"id":"candidate"}`))
	request.Header.Set("Authorization", "Bearer integration-secret")
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("install status=%d", response.StatusCode)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := supervisor.State()
		if current.Phase == state.PhaseActive && current.LastError != nil {
			if current.Active == nil || current.Active.ID != "stable" {
				t.Fatalf("active model=%#v", current.Active)
			}
			if current.LastError.Code != managerruntime.CodeActivationRolledBack {
				t.Fatalf("last error=%#v", current.LastError)
			}
			if launcher.starts["stable.gguf"] != 2 {
				t.Fatalf("stable starts=%d", launcher.starts["stable.gguf"])
			}
			statusRequest, _ := http.NewRequest(http.MethodGet, server.URL+"/manager/v1/status", nil)
			statusRequest.Header.Set("Authorization", "Bearer integration-secret")
			statusResponse, statusErr := http.DefaultClient.Do(statusRequest)
			if statusErr != nil {
				t.Fatal(statusErr)
			}
			var statusBody struct {
				State state.State `json:"state"`
			}
			decodeErr := json.NewDecoder(statusResponse.Body).Decode(&statusBody)
			statusResponse.Body.Close()
			if decodeErr != nil || statusBody.State.Active == nil || statusBody.State.Active.ID != "stable" {
				t.Fatalf("status=%#v decode=%v", statusBody, decodeErr)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("rollback did not complete: %#v", supervisor.State())
}
