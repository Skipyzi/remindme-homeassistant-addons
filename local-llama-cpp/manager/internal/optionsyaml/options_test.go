package optionsyaml

import (
	"strings"
	"testing"

	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/hardware"
)

func TestRenderProducesCompleteCredentialFreeOptions(t *testing.T) {
	variant := catalog.Variant{Repo: "owner/repo", File: "test.gguf"}
	profile := hardware.Runtime{Context: 4096, Threads: 4, Batch: 128, UBatch: 64, ReasoningFormat: "none", ReasoningMode: "off"}
	got, err := Render(variant, profile, "/data/models/test.gguf")
	if err != nil {
		t.Fatal(err)
	}
	expected := `manager_token: ""
hf_repo: owner/repo
hf_file: test.gguf
hf_token: ""
model_path: /data/models/test.gguf
context_size: 4096
threads: 4
threads_batch: 4
batch_size: 128
ubatch_size: 64
cache_reuse: 256
jinja: true
kv_unified: true
flash_attention: false
reasoning_format: none
reasoning_mode: off
`
	if got != expected {
		t.Fatalf("yaml mismatch\nwant:\n%s\ngot:\n%s", expected, got)
	}
}

func TestRenderRejectsUnsafeValues(t *testing.T) {
	profile := hardware.Runtime{Context: 4096, Threads: 4, Batch: 128, UBatch: 64, ReasoningMode: "off"}
	for _, current := range []struct {
		name    string
		variant catalog.Variant
		path    string
	}{
		{name: "repository newline", variant: catalog.Variant{Repo: "owner/repo\nsecret", File: "test.gguf"}, path: "/data/models/test.gguf"},
		{name: "file traversal", variant: catalog.Variant{Repo: "owner/repo", File: "../test.gguf"}, path: "/data/models/test.gguf"},
		{name: "outside path", variant: catalog.Variant{Repo: "owner/repo", File: "test.gguf"}, path: "/tmp/test.gguf"},
	} {
		t.Run(current.name, func(t *testing.T) {
			output, err := Render(current.variant, profile, current.path)
			if err == nil || strings.Contains(output, "secret") {
				t.Fatalf("output=%q err=%v", output, err)
			}
		})
	}
}
