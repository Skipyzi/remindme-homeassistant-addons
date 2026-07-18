package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

func TestConfiguredModelUsesCurrentModelPathInsideModelDirectory(t *testing.T) {
	modelDir := t.TempDir()
	selectedPath := filepath.Join(modelDir, "selected.gguf")
	if err := os.WriteFile(selectedPath, []byte("GGUF"), 0o600); err != nil {
		t.Fatal(err)
	}
	modelCatalog := catalog.Catalog{Variants: []catalog.Variant{{ID: "selected", Repo: "owner/repo", File: "selected.gguf"}}}
	installed, variant, err := configuredModel(addonOptions{ModelPath: selectedPath}, modelDir, modelCatalog)
	if err != nil || installed.ID != "selected" || installed.Path != selectedPath || variant == nil || variant.ID != "selected" {
		t.Fatalf("installed=%#v variant=%#v err=%v", installed, variant, err)
	}
}

func TestConfiguredModelRejectsOutsidePath(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "outside.gguf")
	if err := os.WriteFile(outside, []byte("GGUF"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := configuredModel(addonOptions{ModelPath: outside}, t.TempDir(), catalog.Catalog{}); err == nil {
		t.Fatal("outside model path was accepted")
	}
}

func TestConfiguredModelResolvesRepositoryFallback(t *testing.T) {
	modelDir := t.TempDir()
	variant := catalog.Variant{ID: "qwen", Repo: "owner/repo", File: "qwen.gguf"}
	installed, selected, err := configuredModel(addonOptions{HFRepo: variant.Repo, HFFile: variant.File}, modelDir, catalog.Catalog{Variants: []catalog.Variant{variant}})
	if err != nil || installed.ID != variant.ID || installed.Path != filepath.Join(modelDir, variant.File) || selected == nil || selected.ID != variant.ID {
		t.Fatalf("installed=%#v variant=%#v err=%v", installed, selected, err)
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

func TestUnknownVariantDiagnosticIsActionableAndSecretSafe(t *testing.T) {
	options := addonOptions{
		HFRepo:  "custom/example-GGUF",
		HFFile:  "example-Q4_K_M.gguf",
		HFToken: "hf_secret_must_not_appear",
	}
	message := unknownVariantDiagnostic(options)
	for _, expected := range []string{
		"custom/example-GGUF",
		"example-Q4_K_M.gguf",
		"Qwen/Qwen3-1.7B-GGUF",
		"Qwen3-1.7B-Q8_0.gguf",
		"Hardware Cookbook",
	} {
		if !strings.Contains(message, expected) {
			t.Fatalf("diagnostic missing %q: %s", expected, message)
		}
	}
	if strings.Contains(message, options.HFToken) {
		t.Fatal("diagnostic exposed the Hugging Face token")
	}
}
