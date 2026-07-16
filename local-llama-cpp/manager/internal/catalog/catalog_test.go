package catalog

import (
	"os"
	"strings"
	"testing"
)

func TestLoadFindsCuratedVariant(t *testing.T) {
	input := `{"variants":[{"id":"qwen3-4b-q4","family":"Qwen3 4B","repo":"Qwen/Qwen3-4B-GGUF","file":"Qwen3-4B-Q4_K_M.gguf","parameters":4022468096,"quantization":"Q4_K_M","expectedBytes":2497280256,"sha256":"7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5","minimumRAM":6442450944,"recommendedRAM":7516192768,"nativeContext":40960,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"recommended","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}}]}`
	catalog, err := Load(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	variant, ok := catalog.Find("qwen3-4b-q4")
	if !ok || variant.File != "Qwen3-4B-Q4_K_M.gguf" {
		t.Fatalf("unexpected variant: %#v", variant)
	}
}

func TestLoadRejectsDuplicateIDs(t *testing.T) {
	variant := `{"id":"duplicate","family":"Model","repo":"owner/repo","file":"model.gguf","parameters":1,"quantization":"Q4","expectedBytes":4,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","minimumRAM":1,"recommendedRAM":1,"nativeContext":1024,"recommendedContext":1024,"capabilities":["chat"],"tier":"compatible","source":"official","runtime":{"batch":1,"ubatch":1,"threads":1,"reasoningFormat":"none","reasoningMode":"off"}}`
	_, err := Load(strings.NewReader(`{"variants":[` + variant + `,` + variant + `]}`))
	if err == nil {
		t.Fatal("expected duplicate id error")
	}
}

func TestValidateCustomRejectsUnsafeIdentifiers(t *testing.T) {
	bad := []CustomInput{
		{Repo: "Qwen/Qwen3-4B-GGUF", File: "../secret.gguf"},
		{Repo: "https://evil.example/model", File: "model.gguf"},
		{Repo: "owner/repo", File: "model.bin"},
	}
	for _, input := range bad {
		if _, err := ValidateCustom(input); err == nil {
			t.Fatalf("accepted %#v", input)
		}
	}
}

func TestCustomEntryIsConservativeAndUnverified(t *testing.T) {
	variant, err := ValidateCustom(CustomInput{Repo: "owner/repo", File: "Model-Q4_K_M.gguf"})
	if err != nil {
		t.Fatal(err)
	}
	if !variant.Unverified || variant.RecommendedContext != 4096 || len(variant.Capabilities) != 1 || variant.Capabilities[0] != CapabilityChat {
		t.Fatalf("unsafe custom defaults: %#v", variant)
	}
}

func TestPublicVariantDoesNotExposeInternalPath(t *testing.T) {
	variant := Variant{ID: "model", Repo: "owner/repo", File: "model.gguf", LocalPath: "/data/models/model.gguf"}
	public := variant.Public()
	if public.ID != "model" || public.Repo != "owner/repo" || public.File != "model.gguf" {
		t.Fatalf("unexpected public variant: %#v", public)
	}
}

func TestBundledCatalogIsValid(t *testing.T) {
	file, err := os.Open("catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	catalog, err := Load(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Variants) != 8 {
		t.Fatalf("expected 8 curated variants, got %d", len(catalog.Variants))
	}
}
