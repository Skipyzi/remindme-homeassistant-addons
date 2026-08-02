package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

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
