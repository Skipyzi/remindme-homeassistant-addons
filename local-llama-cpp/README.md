# Local llama.cpp

ARM64 llama.cpp appliance for RemindMe with hardware-aware Hugging Face GGUF downloads, checksum verification, and native Home Assistant configuration.

## Manual model lifecycle

Version 1.10.0 runs a small authenticated model manager in front of `llama-server`:

- The OpenAI-compatible API remains at port `8080`, including `/v1/chat/completions`.
- A download does not change, stop, or restart the running model.
- Completed downloads are checked for exact byte size, GGUF header, and SHA-256 when supplied by the curated catalog.
- Interrupted `.partial` downloads can resume.
- Verified models expose complete credential-free options YAML.
- Model activation is performed only through the llama.cpp add-on's native **Configuration** page and a manual restart.

Open **Models** in the RemindMe sidebar to compare models, download one, and wait for **Verified**. Choose **Copy complete YAML** or **Download YAML**, paste the complete document into the llama.cpp add-on Configuration YAML editor, save, and restart the llama.cpp add-on. The downloaded file does not affect the running model until that restart.

At startup, the add-on log prints a short-lived six-character pairing code. Enter it in RemindMe's Model Workbench. The code is single-use, expires, and is rate-limited; the protected manager token returned by the direct exchange never enters browser state.

## Authoritative native options

`/data/options.json`, rendered from Home Assistant's native Configuration, is authoritative on every start. A configured `model_path` is canonicalized, confined beneath `/data/models`, and selected even when manager state previously named a different active or fallback model. Invalid or missing paths produce a precise startup error; the manager does not silently run an older model.

A workbench-generated document contains every supported option:

```yaml
manager_token: ""
hf_repo: Qwen/Qwen3-1.7B-GGUF
hf_file: Qwen3-1.7B-Q8_0.gguf
hf_token: ""
model_path: /data/models/Qwen3-1.7B-Q8_0.gguf
context_size: 8192
threads: 4
threads_batch: 4
batch_size: 256
ubatch_size: 128
cache_reuse: 256
jinja: true
kv_unified: true
flash_attention: false
reasoning_format: deepseek
reasoning_mode: auto
```

The option-level `manager_token` and `hf_token` values are intentionally empty. Pairing and gated-model credentials remain in protected manager-owned files and are never embedded in copied YAML.

For backward compatibility, an existing installation with blank `model_path` still resolves the exact configured `hf_repo` and `hf_file`, downloading and verifying that file when absent. Preserve unknown repository and filename choices unchanged; they produce actionable, credential-free diagnostics instead of being silently replaced.

## Runtime and readiness

The manager starts `llama-server` internally on `127.0.0.1:8081`. This loopback address is intentional because both processes share the same add-on container. Health and completion readiness retry every 500 milliseconds for up to 120 seconds while large models load.

Current options control context, inference and batch threads, batch and ubatch sizes, cache reuse, Jinja templates, unified KV, flash attention, and reasoning mode. Manager runtime status reports the model actually serving inference so RemindMe does not depend on mirrored settings.

## Downloads and credentials

Public models require no account. For a gated model:

1. Accept the model licence on Hugging Face.
2. Create a read-only Hugging Face access token.
3. Save it under **Models → Hugging Face access and custom GGUF**.
4. Download and verify the model before copying YAML.

The token is stored only in `/data/model-manager/credentials.json` with restrictive permissions. API responses expose only configured/not-configured state.

The legacy `manager_token` option is migration-only. It is imported only when `/data/model-manager/manager-token` does not exist; an existing manager-owned token is never overwritten. Preserve `/data/model-manager` and `/data/models` when upgrading, rolling back, or reinstalling.

## Recovery and safety

The manager persists download progress and leaves interrupted downloads resumable. It records successful verification separately from runtime state, so YAML is unavailable until the exact final file has passed verification. Running and in-progress files cannot be removed.

Management endpoints are authenticated and intended only for RemindMe's server-side client. Credentials, signed URLs, checksums, and private host paths are not returned to the browser. The generated `model_path` always uses the add-on-visible `/data/models` path.

## Home Assistant sidebar

Home Assistant ingress opens the llama.cpp web interface through the manager's streaming reverse proxy. RemindMe, Home Assistant Assist, and other local clients continue using `http://homeassistant:8080`.
