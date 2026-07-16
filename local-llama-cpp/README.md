# Local llama.cpp

ARM64 llama.cpp appliance for RemindMe with hardware-aware Hugging Face GGUF downloads, health checks, and automatic rollback.

## Managed model lifecycle

Version 1.8.0 runs a small static model manager in front of `llama-server`:

- The OpenAI-compatible API remains at port `8080`, including `/v1/chat/completions`.
- The active model continues serving while a candidate downloads and verifies.
- Completed downloads are checked for exact byte size, GGUF header, and SHA-256 when supplied by the curated catalog.
- Activation requires both llama.cpp `/health` and a deterministic completion probe.
- A failed candidate restores the previous healthy model automatically.
- The active model and one previous successful fallback are protected from removal.
- Interrupted `.partial` downloads can resume.

Use the **Hardware Cookbook** in the RemindMe sidebar to install or switch models. RemindMe generates and pairs the private `manager_token`; do not copy it into browser scripts or public configuration.

## Initial configuration and migration

Existing options remain supported for the first managed startup:

```yaml
hf_repo: Qwen/Qwen3-1.7B-GGUF
hf_file: Qwen3-1.7B-Q8_0.gguf
hf_token: ""
model_path: ""
context_size: 8192
threads: 4
batch_size: 512
ubatch_size: 128
reasoning_format: deepseek
reasoning_mode: auto
```

On first startup without manager state, the add-on matches `hf_repo` and `hf_file` to the curated catalog, downloads the model into `/data/models`, and records crash-safe state under `/data/model-manager`. A valid `model_path` is preserved as a legacy local model.

`hf_token` is retained only for migration. Configure Hugging Face access from RemindMe afterward. Gated models such as Gemma also require accepting their licence on Hugging Face.

## Recovery

The manager persists each lifecycle phase. After power loss or add-on restart it:

- Restarts the last healthy active model.
- Restores the fallback after an interrupted activation or probe.
- Leaves interrupted downloads resumable.
- Reports a degraded state instead of entering a restart loop when no healthy model exists.

Management endpoints are authenticated and intended only for RemindMe's server-side client. Credentials, signed URLs, checksums, and local paths are not returned to the browser.

## Home Assistant sidebar

Home Assistant ingress still opens the llama.cpp web interface through the manager's streaming reverse proxy. RemindMe, Home Assistant Assist, and other local clients continue using `http://homeassistant:8080`.
