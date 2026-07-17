package main

import (
	"strings"
	"testing"
)

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
