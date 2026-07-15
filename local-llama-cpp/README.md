# Local llama.cpp

ARM64 llama.cpp server for the RemindMe bot with automatic Hugging Face downloads.

## Configuration

Recommended:

```yaml
hf_repo: Qwen/Qwen3-1.7B-GGUF:Q4_K_M
hf_file: ""
hf_token: ""
model_path: ""
context_size: 4096
threads: 4
```

`hf_repo` uses llama.cpp's `--hf-repo` option. The optional `:Q4_K_M` selects the quantization. Set `hf_file` to pin an exact GGUF file. Set `hf_token` only for gated or private Hugging Face repositories.

The model is downloaded on first startup and cached in the persistent add-on `/data` directory. Later restarts reuse the cached model.

For a manually supplied model, clear `hf_repo` and set `model_path`, for example:

```text
/data/models/qwen3-1.7b-q4_k_m.gguf
```

The API listens on port 8080 and exposes `/v1/chat/completions`.

## Home Assistant sidebar

The add-on enables Home Assistant ingress and adds a `Local LLM` sidebar item with the `mdi:robot` icon. Open it from the Home Assistant sidebar to use the llama.cpp web interface without exposing the service publicly.

The current add-on provides the model API and web interface. Home Assistant Assist integration requires a separate custom conversation integration because the built-in OpenAI integration only supports the official OpenAI endpoint.
