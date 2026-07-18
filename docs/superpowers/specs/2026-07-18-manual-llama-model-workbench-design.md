# Manual llama.cpp Model Workbench Design

## Summary

Replace the unreliable Supervisor-backed settings mirror with a strict boundary:

- **Settings** controls browser-local harness preferences only.
- A dedicated **Models** workspace downloads and verifies GGUF files through the local model manager.
- Model activation is deliberately manual: after a verified download, the user copies a complete server-generated llama.cpp options document into the llama.cpp add-on Configuration and restarts that add-on.
- RemindMe reports the model that is actually running instead of trusting mirrored configuration.

The harness and model workflow must not call Home Assistant Supervisor APIs.

## Goals

1. Remove Supervisor option reads, writes, validation assumptions, and restart controls from the harness.
2. Keep model download, resume, checksum verification, cancellation, and safe deletion.
3. Ensure downloading never changes or interrupts the running model.
4. Generate complete, deterministic llama.cpp options YAML only for verified local models.
5. Make Home Assistant's native add-on Configuration the sole authority for llama.cpp activation and runtime settings.
6. Discover the active model from manager/runtime state for status and attribution.
7. Preserve secret isolation, path safety, hardware assessment, and credential-free diagnostics.

## Non-goals

- Automatically editing either add-on's Supervisor options.
- Restarting either add-on from the harness.
- Automatically activating a downloaded model.
- Synchronizing RemindMe and llama.cpp option documents.
- Exposing manager credentials, Hugging Face tokens, or reminder data to the browser.
- Adding cloud model providers, vision execution, or speech features.

## Architecture

### Harness settings boundary

The Settings modal contains only browser-local controls:

- Performance/thinking profile
- Glow intensity
- CRT scanlines
- Future presentation preferences that require no server or Supervisor persistence

These preferences remain in browser storage. Remove add-on tokens, owner ID, endpoints, local LLM fields, manager fields, notification target, secret replacement controls, configuration revision state, save-to-Supervisor behavior, and restart controls.

The harness server removes its Supervisor-backed settings load, save, and restart routes. Runtime configuration still originates from the options Home Assistant supplies at process start, but the harness does not mirror or mutate it.

### Dedicated Models workspace

A top-level **Models** control opens a focused Model Workbench separate from Settings and the conversation timeline. The workbench communicates with the llama.cpp model manager through RemindMe's authenticated server-side proxy. This pairing and proxy flow is local and does not involve Supervisor.

The workbench loads:

- Curated and custom catalog entries
- Hardware facts and per-model safety assessments
- Installed and checksum-verified state
- Current download operation
- Actual running model state

### Data flow

1. The user opens Models.
2. RemindMe loads catalog, hardware, installation, and runtime status from the manager.
3. The user clicks **Download**.
4. The manager downloads into a resumable partial file, verifies size and checksum, and atomically promotes the final GGUF.
5. Existing inference remains untouched.
6. The model becomes **Verified** and the server exposes its complete YAML recipe.
7. The user copies or downloads the YAML.
8. The user pastes it into the llama.cpp add-on Configuration and restarts that add-on manually.
9. llama.cpp startup treats `/data/options.json` as authoritative and starts exactly the selected model and runtime profile.
10. RemindMe discovers the running model from manager/runtime status.

No step calls a Supervisor API.

## Model Workbench UX

Each model card shows:

- Family, quantization, source, and capabilities
- Download size and estimated memory use
- Recommended context and Pi suitability
- One state: **Available**, **Downloading**, **Verified**, or **Running**
- The first actionable hardware or access warning

Actions:

- **Download** for an available safe model
- **Cancel download** while a download is active
- **Copy complete YAML** only after successful verification
- **Download YAML** as a clipboard-independent fallback
- **Remove** only when the model is neither running nor part of an in-progress operation

Remove **Install + activate** and **Activate** actions. A successful download must never imply activation.

After copying, show exact instructions:

> Open the llama.cpp add-on, choose Configuration, switch to the YAML editor, replace the options, save, and restart the llama.cpp add-on.

The workbench states explicitly that the running model does not change until that manual restart. Once restarted, the **Running** badge follows runtime discovery rather than browser assumptions.

## YAML contract

YAML generation belongs on the manager/server beside the authoritative catalog and option schema. The browser must not reconstruct runtime recipes.

A recipe is available only when the expected final file exists, has passed verification, and resolves beneath `/data/models`. It contains every llama.cpp option needed for deterministic startup:

- `manager_token`
- `hf_repo`
- `hf_file`
- `hf_token`
- `model_path`
- `context_size`
- `threads`
- `threads_batch`
- `batch_size`
- `ubatch_size`
- `cache_reuse`
- `jinja`
- `kv_unified`
- `flash_attention`
- `reasoning_format`
- `reasoning_mode`

`model_path` uses the exact verified `/data/models/<filename>.gguf` path. Repository and filename remain present for traceability. Runtime fields come from the hardware assessment and curated catalog profile.

Recipes never contain stored credentials. Both legacy `manager_token` and `hf_token` are emitted as empty strings. A verified local `model_path` does not need either token to start. Gated models require Hugging Face access before download, but the post-verification YAML never reveals or depends on the stored token. The UI explains that copying the complete options intentionally clears legacy option-level secret fields while leaving the manager's protected credential file untouched.

The same server payload drives clipboard copy and a downloadable `.yaml` file so both outputs are identical.

## Download-only manager semantics

The install endpoint becomes a download-and-verify operation:

- Begin or resume download.
- Report byte progress.
- Verify expected length and SHA-256.
- Atomically promote the file.
- Persist an idle/success state.
- Publish a verified completion event.

It must not invoke supervisor `Start` or `Activate`, modify the current active/fallback model, or restart llama-server. Existing inference continues throughout.

Installed state is derived from verified final files, not from a prior activation record. Deletion rejects only the running file and files involved in an active operation; obsolete fallback metadata does not prevent manual cleanup.

## Authoritative startup behavior

On every llama.cpp add-on start:

1. Read `/data/options.json`.
2. If `model_path` is present, canonicalize it and require it to resolve beneath `/data/models`.
3. Otherwise, resolve the exact configured `hf_repo` and `hf_file` for backward-compatible startup, downloading and verifying that file when absent.
4. Match catalog metadata when available.
5. Build runtime arguments from the current options document.
6. Start llama-server with those exact settings.

Server-generated YAML always includes `model_path`; the repository fallback exists only so existing installations with pre-workbench options continue to boot.

Persisted manager active/fallback state must not override changed Home Assistant options. Recovery may clean or report interrupted downloads, but it may not select a different inference model than the current options request.

If the configured model is absent, outside the model directory, malformed, or cannot start, startup reports a precise credential-free error and leaves inference unavailable. It must not silently run an older model.

## Runtime discovery

RemindMe asks the manager/runtime for the model actually serving inference. This identity drives:

- Model status badges
- Chat request model identifier where required
- Answer attribution
- Performance metrics

If runtime discovery is unavailable, RemindMe reports **Runtime unavailable** instead of presenting a stale configured identifier. Startup environment values may provide endpoints, but they are not treated as proof of the active model.

## Error handling

Errors are concise, actionable, and credential-free:

- Insufficient RAM or disk space
- Unsupported or unsafe model for detected hardware
- Download interruption with resume guidance
- Size or checksum mismatch
- Gated model requiring Hugging Face access
- Missing or unsafe model path
- YAML unavailable until verification
- Clipboard denied, with Download YAML offered
- Runtime unavailable after manual restart
- Configured model startup failure without silent fallback

Manager and proxy responses never return bearer tokens, pairing secrets, Hugging Face tokens, or raw Supervisor responses.

## Security

- No harness route calls Supervisor settings or restart APIs.
- Manager authentication remains server-side.
- Browser responses expose only configured/not-configured credential state.
- YAML never embeds stored credentials.
- Model paths are canonicalized and confined to `/data/models`.
- Downloads retain pinned repositories, filenames, sizes, and checksums for curated entries.
- Temporary files use atomic promotion and restrictive permissions.
- Logs and diagnostics remain safe for support sharing.

## Testing and release verification

Automated tests must prove:

1. Harness Settings renders only local preferences and makes no Supervisor request.
2. Supervisor-backed settings and restart routes are absent.
3. Download completion never calls model start or activation.
4. Current inference remains active during and after a successful download.
5. YAML is unavailable before verification.
6. Generated YAML contains every schema field and the exact safe verified path.
7. Browser copy and downloaded YAML are byte-identical.
8. Gated model guidance never exposes stored credentials.
9. Changed `/data/options.json` overrides persisted active/fallback state on restart.
10. Missing or invalid configured models fail clearly without fallback.
11. Runtime discovery drives status and attribution.
12. Clipboard denial leaves Download YAML usable.
13. Existing resume, checksum, cancellation, retention, path-safety, and redaction tests continue to pass.
14. TypeScript, Node, Go, shell, package, ARM64 Docker, and secret-scanning release gates pass.

## Release behavior

This is a behavior change for both add-ons and requires version bumps and documentation updates. Upgrade notes must explain:

- Harness Settings no longer edits add-on configuration.
- Models download without activation.
- Activation requires copying complete YAML into native llama.cpp Configuration and restarting that add-on.
- Existing persisted manager state no longer overrides native options.
- The actual running model is discovered at runtime.
