package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	managerapi "remindme.local/model-manager/internal/api"
	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/download"
	"remindme.local/model-manager/internal/hardware"
	"remindme.local/model-manager/internal/pairing"
	managerruntime "remindme.local/model-manager/internal/runtime"
	"remindme.local/model-manager/internal/state"
	"remindme.local/model-manager/internal/verified"
)

type paths struct {
	options, state, models, catalog, llama string
}

type addonOptions struct {
	ManagerToken    string `json:"manager_token"`
	HFRepo          string `json:"hf_repo"`
	HFFile          string `json:"hf_file"`
	HFToken         string `json:"hf_token"`
	ModelPath       string `json:"model_path"`
	ContextSize     int    `json:"context_size"`
	Threads         int    `json:"threads"`
	ThreadsBatch    int    `json:"threads_batch"`
	BatchSize       int    `json:"batch_size"`
	UBatchSize      int    `json:"ubatch_size"`
	CacheReuse      int    `json:"cache_reuse"`
	Jinja           bool   `json:"jinja"`
	KVUnified       bool   `json:"kv_unified"`
	FlashAttention  bool   `json:"flash_attention"`
	ReasoningFormat string `json:"reasoning_format"`
	ReasoningMode   string `json:"reasoning_mode"`
}

func main() {
	configured := parseFlags()
	if err := os.MkdirAll(configured.models, 0o700); err != nil {
		log.Fatal(err)
	}
	catalogFile, err := os.Open(configured.catalog)
	if err != nil {
		log.Fatal(err)
	}
	modelCatalog, err := catalog.Load(catalogFile)
	catalogFile.Close()
	if err != nil {
		log.Fatal(err)
	}
	store := state.Store{Path: configured.state}
	supervisor, err := managerruntime.NewSupervisor(managerruntime.Config{
		Binary: configured.llama, Target: "http://127.0.0.1:8081", ModelDir: configured.models,
		Stdout: os.Stdout, Stderr: os.Stderr,
	}, nil, store, nil)
	if err != nil {
		log.Fatal(err)
	}
	downloader := download.Downloader{ModelDir: configured.models}
	dataDirectory := filepath.Dir(configured.state)
	credentialPath := filepath.Join(dataDirectory, "credentials.json")
	customCatalogPath := filepath.Join(dataDirectory, "catalog.json")
	tokenPath := filepath.Join(dataDirectory, "manager-token")
	pairingStatePath := filepath.Join(dataDirectory, "pairing.json")
	options, optionsErr := readOptions(configured.options)
	if optionsErr == nil {
		if err := pairing.ImportLegacyToken(tokenPath, options.ManagerToken); err != nil {
			log.Fatal(err)
		}
	}
	pairingStore, err := pairing.NewStore(tokenPath, pairingStatePath, time.Now, rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	pairingCode, pairingExpiry, err := pairingStore.Generate()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("RemindMe pairing code: %s (expires %s)", pairingCode, pairingExpiry.Format(time.RFC3339))
	facts := func() (hardware.Facts, error) {
		result, factsErr := hardware.ReadFacts(configured.models)
		if factsErr != nil {
			return hardware.Facts{}, factsErr
		}
		result.RetainedModelBytes = retainedBytes(supervisor.State())
		return result, nil
	}
	verificationStore := &verified.Store{
		Path: filepath.Join(dataDirectory, "verified-models.json"), ModelDir: configured.models,
	}
	server := managerapi.NewServer(managerapi.Dependencies{
		Catalog: modelCatalog,
		Token:   pairingStore.Token,
		Pairing: pairingStore,
		Facts:   facts, Downloader: downloader, Supervisor: supervisor, Verified: verificationStore,
		ModelDir: configured.models, CredentialPath: credentialPath,
		CustomCatalogPath: customCatalogPath, InferenceURL: "http://127.0.0.1:8081",
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go recoverOrBootstrap(ctx, configured, modelCatalog, downloader, supervisor, facts, credentialPath)
	httpServer := &http.Server{Addr: ":8080", Handler: server, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		_ = supervisor.Stop(15 * time.Second)
	}()
	log.Printf("model manager listening on :8080")
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func parseFlags() paths {
	var result paths
	flag.StringVar(&result.options, "options", "/data/options.json", "Home Assistant add-on options")
	flag.StringVar(&result.state, "state", "/data/model-manager/state.json", "manager state")
	flag.StringVar(&result.models, "models", "/data/models", "model directory")
	flag.StringVar(&result.catalog, "catalog", "/app/catalog.json", "curated catalog")
	flag.StringVar(&result.llama, "llama", "/app/llama-server.bin", "llama server executable")
	flag.Parse()
	return result
}

func recoverOrBootstrap(ctx context.Context, configured paths, modelCatalog catalog.Catalog, downloader download.Downloader, supervisor *managerruntime.Supervisor, facts func() (hardware.Facts, error), credentialPath string) {
	options, err := readOptions(configured.options)
	if err != nil {
		log.Printf("startup degraded: %v", err)
		return
	}
	if options.HFToken != "" {
		_ = saveCredentials(credentialPath, options.HFToken)
	}
	installed, variant, err := configuredModel(options, configured.models, modelCatalog)
	if err != nil {
		log.Printf("startup degraded: %v", err)
		return
	}
	if _, err := os.Stat(installed.Path); err == nil {
		if err := supervisor.Start(ctx, installed, runtimeFromOptions(options)); err != nil {
			log.Printf("configured model failed: %v", err)
		}
		return
	}
	if variant == nil {
		log.Printf("startup degraded: configured model file is unavailable")
		return
	}
	factsValue, err := facts()
	if err != nil {
		log.Printf("startup degraded: %v", err)
		return
	}
	assessment := hardware.Assess(*variant, factsValue, options.ContextSize, false)
	if !assessment.Safe {
		log.Printf("startup degraded: model preflight failed: %s", assessment.Code)
		return
	}
	operation := supervisor.State().Begin(fmt.Sprintf("bootstrap-%d", time.Now().UnixNano()), variant.ID, filepath.Join(configured.models, variant.File+".partial"), variant.ExpectedBytes)
	operation = operation.Transition(state.PhaseDownloading, 0)
	_ = supervisor.Persist(operation)
	result, err := downloader.Download(ctx, *variant, options.HFToken, func(progress download.Progress) {
		updated := supervisor.State().Transition(state.PhaseDownloading, progress.BytesDone)
		if updated.Operation != nil {
			updated.Operation.BytesTotal = progress.BytesTotal
		}
		_ = supervisor.Persist(updated)
	})
	if err != nil {
		_ = supervisor.Persist(supervisor.State().Fail("bootstrap_download_failed", "Initial model download failed and can be resumed."))
		log.Printf("startup degraded: %v", err)
		return
	}
	installed.Path = result.Path
	if err := supervisor.Start(ctx, installed, runtimeFromOptions(options)); err != nil {
		log.Printf("startup degraded: %v", err)
	}
}

func configuredModel(options addonOptions, modelDir string, modelCatalog catalog.Catalog) (state.Installed, *catalog.Variant, error) {
	if options.ModelPath != "" {
		modelRoot, err := filepath.EvalSymlinks(modelDir)
		if err != nil {
			return state.Installed{}, nil, fmt.Errorf("resolve model directory: %w", err)
		}
		selected, err := filepath.EvalSymlinks(options.ModelPath)
		if err != nil {
			return state.Installed{}, nil, fmt.Errorf("configured model path is unavailable: %w", err)
		}
		relative, err := filepath.Rel(modelRoot, selected)
		if err != nil || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return state.Installed{}, nil, errors.New("configured model path must be inside /data/models")
		}
		for index := range modelCatalog.Variants {
			variant := &modelCatalog.Variants[index]
			if variant.File == filepath.Base(selected) {
				return state.Installed{ID: variant.ID, Repo: variant.Repo, File: variant.File, Path: selected}, variant, nil
			}
		}
		return state.Installed{ID: "local-model", File: filepath.Base(selected), Path: selected}, nil, nil
	}
	variant, ok := findConfiguredVariant(options, modelCatalog)
	if !ok {
		return state.Installed{}, nil, errors.New(unknownVariantDiagnostic(options))
	}
	return state.Installed{ID: variant.ID, Repo: variant.Repo, File: variant.File, Path: filepath.Join(modelDir, variant.File)}, &variant, nil
}

func readOptions(path string) (addonOptions, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return addonOptions{}, err
	}
	var result addonOptions
	if err := json.Unmarshal(data, &result); err != nil {
		return addonOptions{}, err
	}
	return result, nil
}

func findConfiguredVariant(options addonOptions, modelCatalog catalog.Catalog) (catalog.Variant, bool) {
	repo := strings.TrimSuffix(options.HFRepo, ":Q4_K_M")
	for _, variant := range modelCatalog.Variants {
		if variant.Repo == repo && (options.HFFile == "" || variant.File == options.HFFile) {
			return variant, true
		}
	}
	return catalog.Variant{}, false
}

func unknownVariantDiagnostic(options addonOptions) string {
	return fmt.Sprintf(
		"configured Hugging Face model repo=%q file=%q is not in the curated catalog; configuration was preserved. To recover, set repo=%q and file=%q, or pair RemindMe and install a model through Hardware Cookbook",
		options.HFRepo,
		options.HFFile,
		"Qwen/Qwen3-1.7B-GGUF",
		"Qwen3-1.7B-Q8_0.gguf",
	)
}

func runtimeFor(installed state.Installed, modelCatalog catalog.Catalog, facts func() (hardware.Facts, error)) hardware.Runtime {
	variant, ok := modelCatalog.Find(installed.ID)
	if !ok {
		return hardware.Runtime{Context: 4096, Batch: 128, UBatch: 64, Threads: 4, ReasoningMode: "off"}
	}
	factsValue, err := facts()
	if err != nil {
		return hardware.Runtime{Context: variant.RecommendedContext, Batch: variant.Runtime.Batch, UBatch: variant.Runtime.UBatch, Threads: variant.Runtime.Threads, ReasoningFormat: variant.Runtime.ReasoningFormat, ReasoningMode: variant.Runtime.ReasoningMode}
	}
	return hardware.Assess(variant, factsValue, variant.RecommendedContext, true).Runtime
}

func runtimeFromOptions(options addonOptions) hardware.Runtime {
	threads := max(options.Threads, 1)
	threadsBatch := options.ThreadsBatch
	if threadsBatch <= 0 {
		threadsBatch = threads
	}
	return hardware.Runtime{
		Context: max(options.ContextSize, 4096), Batch: max(options.BatchSize, 128),
		UBatch: max(options.UBatchSize, 64), Threads: threads,
		ThreadsBatch: threadsBatch,
		CacheReuse:   max(options.CacheReuse, 0), Jinja: options.Jinja,
		KVUnified: options.KVUnified, FlashAttention: options.FlashAttention,
		ReasoningFormat: options.ReasoningFormat, ReasoningMode: options.ReasoningMode,
	}
}

func retainedBytes(current state.State) int64 {
	seen := map[string]bool{}
	var total int64
	for _, model := range []*state.Installed{current.Active, current.Fallback} {
		if model == nil || seen[model.Path] {
			continue
		}
		seen[model.Path] = true
		if info, err := os.Stat(model.Path); err == nil {
			total += info.Size()
		}
	}
	return total
}

func saveCredentials(path, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, _ := json.Marshal(map[string]string{"huggingFaceToken": token})
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
