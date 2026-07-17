# Local llama.cpp

ARM64 llama.cpp appliance for RemindMe with hardware-aware Hugging Face GGUF downloads, health checks, and automatic rollback.

## Managed model lifecycle

Version 1.9.2 runs a small static model manager in front of `llama-server`:

- The OpenAI-compatible API remains at port `8080`, including `/v1/chat/completions`.
- The active model continues serving while a candidate downloads and verifies.
- Completed downloads are checked for exact byte size, GGUF header, and SHA-256 when supplied by the curated catalog.
- Activation requires both llama.cpp `/health` and a deterministic completion probe.
- Startup retries transient readiness failures for up to 120 seconds while large models load.
- A failed candidate restores the previous healthy model automatically.
- The active model and one previous successful fallback are protected from removal.
- Interrupted `.partial` downloads can resume.

Use the **Hardware Cookbook** in the RemindMe sidebar to install or switch models. At startup, the add-on log prints a short-lived six-character pairing code. Enter it in RemindMe's Local model vault. The code is single-use, expires, and is rate-limited; the protected manager token returned by the direct exchange never enters browser state.

The manager starts `llama-server` internally on `127.0.0.1:8081`. This loopback address is intentional because both processes share the same add-on container. Version 1.9.2 retries health and completion readiness every 500 milliseconds for up to 120 seconds instead of treating the first connection refusal during model loading as a startup failure.

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

Version 1.9.1 preserves unknown repository and filename choices instead of silently replacing them. Startup remains degraded until the operator restores a curated tuple or installs a model through Hardware Cookbook, while the manager catalog and pairing APIs remain available. The add-on log reports the non-secret configured tuple and exact recovery guidance; it never logs the Hugging Face token.

`hf_token` is retained only for migration. Configure Hugging Face access from RemindMe afterward. Gated models such as Gemma also require accepting their licence on Hugging Face.

The legacy `manager_token` option is accepted for this migration release only. It is imported only when `/data/model-manager/manager-token` does not already exist; the manager-owned file is authoritative and an existing token is never overwritten. New installations should leave `manager_token` blank and use the six-character pairing code. Preserve `/data/model-manager` when rolling back or reinstalling so the manager state and token remain available.

## Recovery

The manager persists each lifecycle phase. After power loss or add-on restart it:

- Restarts the last healthy active model.
- Restores the fallback after an interrupted activation or probe.
- Leaves interrupted downloads resumable.
- Reports a degraded state instead of entering a restart loop when no healthy model exists.

Management endpoints are authenticated and intended only for RemindMe's server-side client. Credentials, signed URLs, checksums, and local paths are not returned to the browser.

## Home Assistant sidebar

Home Assistant ingress still opens the llama.cpp web interface through the manager's streaming reverse proxy. RemindMe, Home Assistant Assist, and other local clients continue using `http://homeassistant:8080`.
