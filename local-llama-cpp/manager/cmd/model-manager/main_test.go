package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/download"
	"remindme.local/model-manager/internal/hardware"
	managerruntime "remindme.local/model-manager/internal/runtime"
	"remindme.local/model-manager/internal/state"
	"remindme.local/model-manager/internal/verified"
)

type bootstrapProcess struct{}

func (*bootstrapProcess) Stop(time.Duration) error { return nil }
func (*bootstrapProcess) Wait() error              { return nil }

type bootstrapLauncher struct{}

func (*bootstrapLauncher) Start(context.Context, string, []string) (managerruntime.Process, error) {
	return &bootstrapProcess{}, nil
}

type fakeConfiguredResolver struct {
	variant catalog.Variant
	err     error
	repo    string
	file    string
	token   string
	calls   int
}

func (resolver *fakeConfiguredResolver) Resolve(_ context.Context, repo, file, token string, _ catalog.Catalog) (catalog.Variant, error) {
	resolver.calls++
	resolver.repo = repo
	resolver.file = file
	resolver.token = token
	return resolver.variant, resolver.err
}

func TestConfiguredModelUsesCurrentModelPathInsideModelDirectory(t *testing.T) {
	modelDir := t.TempDir()
	selectedPath := filepath.Join(modelDir, "selected.gguf")
	if err := os.WriteFile(selectedPath, []byte("GGUF"), 0o600); err != nil {
		t.Fatal(err)
	}
	modelCatalog := catalog.Catalog{Variants: []catalog.Variant{{ID: "selected", Repo: "owner/repo", File: "selected.gguf"}}}
	resolver := &fakeConfiguredResolver{}
	installed, variant, err := configuredModel(context.Background(), addonOptions{ModelPath: selectedPath}, modelDir, modelCatalog, resolver)
	if err != nil || installed.ID != "selected" || installed.Path != selectedPath || variant == nil || variant.ID != "selected" || resolver.calls != 0 {
		t.Fatalf("installed=%#v variant=%#v err=%v", installed, variant, err)
	}
}

func TestConfiguredModelRejectsOutsidePath(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "outside.gguf")
	if err := os.WriteFile(outside, []byte("GGUF"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := configuredModel(context.Background(), addonOptions{ModelPath: outside}, t.TempDir(), catalog.Catalog{}, &fakeConfiguredResolver{}); err == nil {
		t.Fatal("outside model path was accepted")
	}
}

func TestConfiguredModelResolvesRepositoryFallback(t *testing.T) {
	modelDir := t.TempDir()
	variant := catalog.Variant{ID: "qwen", Repo: "owner/repo", File: "qwen.gguf"}
	resolver := &fakeConfiguredResolver{variant: variant}
	installed, selected, err := configuredModel(context.Background(), addonOptions{HFRepo: variant.Repo, HFFile: variant.File}, modelDir, catalog.Catalog{Variants: []catalog.Variant{variant}}, resolver)
	if err != nil || installed.ID != variant.ID || installed.Path != filepath.Join(modelDir, variant.File) || selected == nil || selected.ID != variant.ID || resolver.calls != 1 {
		t.Fatalf("installed=%#v variant=%#v err=%v", installed, selected, err)
	}
}

func TestConfiguredModelResolvesCustomExactAndShorthandSelections(t *testing.T) {
	for name, testCase := range map[string]struct {
		options  addonOptions
		resolved catalog.Variant
	}{
		"exact": {
			options:  addonOptions{HFRepo: "owner/repo", HFFile: "Model-Q5_K_M.gguf", HFToken: "hf_secret"},
			resolved: catalog.Variant{ID: "custom-exact", Repo: "owner/repo", File: "Model-Q5_K_M.gguf", Unverified: true},
		},
		"shorthand": {
			options:  addonOptions{HFRepo: "unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL"},
			resolved: catalog.Variant{ID: "custom-shorthand", Repo: "unsloth/Qwen3.5-2B-MTP-GGUF", File: "Qwen3.5-2B-UD-Q4_K_XL.gguf", Unverified: true},
		},
	} {
		t.Run(name, func(t *testing.T) {
			resolver := &fakeConfiguredResolver{variant: testCase.resolved}
			modelDir := t.TempDir()
			installed, selected, err := configuredModel(context.Background(), testCase.options, modelDir, catalog.Catalog{}, resolver)
			if err != nil || selected == nil || installed.Path != filepath.Join(modelDir, testCase.resolved.File) {
				t.Fatalf("installed=%#v selected=%#v err=%v", installed, selected, err)
			}
			if resolver.repo != testCase.options.HFRepo || resolver.file != testCase.options.HFFile || resolver.token != testCase.options.HFToken {
				t.Fatalf("resolver input repo=%q file=%q token=%q", resolver.repo, resolver.file, resolver.token)
			}
		})
	}
}

func TestRecoverExistingConfiguredModelPersistsVerification(t *testing.T) {
	modelDir := t.TempDir()
	body := []byte("GGUFbootstrap")
	modelPath := filepath.Join(modelDir, "Model-Q4_K_M.gguf")
	if err := os.WriteFile(modelPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	variant := catalog.Variant{
		ID: "bootstrap", Family: "Bootstrap", Repo: "owner/repo", File: filepath.Base(modelPath),
		Parameters: 1, Quantization: "Q4_K_M", ExpectedBytes: int64(len(body)), SHA256: hex.EncodeToString(sum[:]),
		MinimumRAM: 1, RecommendedRAM: 1, NativeContext: 4096, RecommendedContext: 4096,
		Capabilities: []catalog.Capability{catalog.CapabilityChat}, Tier: catalog.TierCompatible, Source: "official",
		Runtime: catalog.RuntimeProfile{Batch: 128, UBatch: 64, Threads: 1, ReasoningMode: "off"},
	}
	optionsPath := filepath.Join(t.TempDir(), "options.json")
	options, err := json.Marshal(addonOptions{HFRepo: variant.Repo, HFFile: variant.File, ContextSize: 4096, Threads: 1, BatchSize: 128, UBatchSize: 64})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(optionsPath, options, 0o600); err != nil {
		t.Fatal(err)
	}
	stateStore := state.Store{Path: filepath.Join(t.TempDir(), "state.json")}
	supervisor, err := managerruntime.NewSupervisor(
		managerruntime.Config{Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: modelDir, ReadinessTimeout: 25 * time.Millisecond, ProbeInterval: time.Millisecond},
		&bootstrapLauncher{}, stateStore, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	verificationStore := &verified.Store{Path: filepath.Join(t.TempDir(), "verified.json"), ModelDir: modelDir}
	recoverOrBootstrap(
		context.Background(),
		paths{options: optionsPath, models: modelDir},
		catalog.Catalog{Variants: []catalog.Variant{variant}},
		download.Downloader{ModelDir: modelDir},
		supervisor,
		func() (hardware.Facts, error) {
			return hardware.Facts{TotalRAM: 8 << 30, FreeRAM: 7 << 30, FreeDisk: 20 << 30, CPUCores: 4, Architecture: "arm64"}, nil
		},
		filepath.Join(t.TempDir(), "credentials.json"),
		func(catalog.Variant) error { return nil },
		verificationStore,
	)
	if !verificationStore.Has(variant) {
		t.Fatal("startup model was not persisted as verified")
	}
}

func TestRecoverDownloadedConfiguredModelPersistsVerification(t *testing.T) {
	body := []byte("GGUFdownloaded")
	sum := sha256.Sum256(body)
	variant := catalog.Variant{
		ID: "downloaded", Family: "Downloaded", Repo: "owner/repo", File: "Model-Q4_K_M.gguf",
		Parameters: 1, Quantization: "Q4_K_M", ExpectedBytes: int64(len(body)), SHA256: hex.EncodeToString(sum[:]),
		MinimumRAM: 1, RecommendedRAM: 1, NativeContext: 4096, RecommendedContext: 4096,
		Capabilities: []catalog.Capability{catalog.CapabilityChat}, Tier: catalog.TierCompatible, Source: "official",
		Runtime: catalog.RuntimeProfile{Batch: 128, UBatch: 64, Threads: 1, ReasoningMode: "off"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", "14")
		_, _ = response.Write(body)
	}))
	defer server.Close()
	modelDir := t.TempDir()
	optionsPath := filepath.Join(t.TempDir(), "options.json")
	options, err := json.Marshal(addonOptions{HFRepo: variant.Repo, HFFile: variant.File, ContextSize: 4096, Threads: 1, BatchSize: 128, UBatchSize: 64})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(optionsPath, options, 0o600); err != nil {
		t.Fatal(err)
	}
	supervisor, err := managerruntime.NewSupervisor(
		managerruntime.Config{Binary: "/app/llama-server.bin", Target: "http://127.0.0.1:8081", ModelDir: modelDir, ReadinessTimeout: 25 * time.Millisecond, ProbeInterval: time.Millisecond},
		&bootstrapLauncher{}, state.Store{Path: filepath.Join(t.TempDir(), "state.json")}, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	verificationStore := &verified.Store{Path: filepath.Join(t.TempDir(), "verified.json"), ModelDir: modelDir}
	recoverOrBootstrap(
		context.Background(), paths{options: optionsPath, models: modelDir}, catalog.Catalog{Variants: []catalog.Variant{variant}},
		download.Downloader{Client: server.Client(), ResolveBase: server.URL, ModelDir: modelDir, MaxBytes: 1024}, supervisor,
		func() (hardware.Facts, error) {
			return hardware.Facts{TotalRAM: 8 << 30, FreeRAM: 7 << 30, FreeDisk: 20 << 30, CPUCores: 4, Architecture: "arm64"}, nil
		},
		filepath.Join(t.TempDir(), "credentials.json"), func(catalog.Variant) error { return nil }, verificationStore,
	)
	if !verificationStore.Has(variant) {
		t.Fatal("downloaded startup model was not persisted as verified")
	}
}

func TestRuntimeFromOptionsPreservesCompleteNativeSettings(t *testing.T) {
	profile := runtimeFromOptions(addonOptions{
		ContextSize: 8192, Threads: 4, ThreadsBatch: 3, BatchSize: 256, UBatchSize: 64,
		CacheReuse: 512, Jinja: true, KVUnified: true, FlashAttention: true,
		ReasoningFormat: "deepseek", ReasoningMode: "auto",
	})
	if profile.ThreadsBatch != 3 || profile.CacheReuse != 512 || !profile.Jinja || !profile.KVUnified || !profile.FlashAttention {
		t.Fatalf("incomplete runtime: %#v", profile)
	}
}
