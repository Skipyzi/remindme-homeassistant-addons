package optionsyaml

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"remindme.local/model-manager/internal/catalog"
	"remindme.local/model-manager/internal/hardware"
)

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$`)
var filePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$`)
var reasoningPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

type RenderError struct {
	Message string
}

func (current *RenderError) Error() string {
	return current.Message
}

func Render(variant catalog.Variant, runtime hardware.Runtime, modelPath string) (string, *RenderError) {
	if !repoPattern.MatchString(variant.Repo) || !filePattern.MatchString(variant.File) {
		return "", &RenderError{Message: "model repository or filename is unsafe"}
	}
	clean := filepath.ToSlash(filepath.Clean(modelPath))
	if clean != "/data/models/"+variant.File || strings.ContainsAny(clean, "\r\n") {
		return "", &RenderError{Message: "model path is outside /data/models"}
	}
	if runtime.Context <= 0 || runtime.Threads <= 0 || runtime.Batch <= 0 || runtime.UBatch <= 0 {
		return "", &RenderError{Message: "runtime profile is incomplete"}
	}
	format := runtime.ReasoningFormat
	if format == "" {
		format = "none"
	}
	mode := runtime.ReasoningMode
	if mode == "" {
		mode = "off"
	}
	if !reasoningPattern.MatchString(format) || !reasoningPattern.MatchString(mode) {
		return "", &RenderError{Message: "reasoning options are unsafe"}
	}
	return fmt.Sprintf(`manager_token: ""
hf_repo: %s
hf_file: %s
hf_token: ""
model_path: %s
context_size: %d
threads: %d
threads_batch: %d
batch_size: %d
ubatch_size: %d
cache_reuse: 256
jinja: true
kv_unified: true
flash_attention: false
reasoning_format: %s
reasoning_mode: %s
`, variant.Repo, variant.File, clean, runtime.Context, runtime.Threads, runtime.Threads, runtime.Batch, runtime.UBatch, format, mode), nil
}
