<!-- markdownlint-disable MD013 -->

# Hardware-Aware Local Model Cookbook Design

**Date:** 2026-07-16  
**Status:** Approved for specification  
**Scope:** Local text-model installation, activation, rollback, and catalog management for the RemindMe and llama.cpp Home Assistant add-ons

## 1. Purpose

RemindMe currently runs one manually configured Hugging Face GGUF model through the separate local llama.cpp add-on. The existing Hardware Cookbook recommends runtime and reasoning settings but cannot discover, install, validate, activate, or recover models.

This project turns the llama.cpp add-on into a managed local-model appliance. RemindMe presents a hardware-aware catalog, while a dedicated manager in the llama.cpp add-on owns downloads, files, inference lifecycle, health checks, and rollback.

Speech-to-text, text-to-speech, multimodal inference, and optional cloud composition are intentionally separate follow-up projects. The model catalog includes a capability schema so those later systems can integrate without redesigning the catalog.

## 2. Goals

- Present tested and custom Hugging Face GGUF options through the RemindMe Hardware Cookbook.
- Rank models and quantizations for the detected ARM64 CPU, RAM, available disk, context, and KV-cache cost.
- Download candidates while the active model continues serving chat.
- Validate candidates before activation.
- Activate a candidate with a health probe and deterministic completion probe.
- Restore the previous healthy model automatically when activation fails.
- Retain the active model and one previous successfully activated model.
- Keep Hugging Face and management credentials out of browser state, logs, and GitHub.
- Preserve the current OpenAI-compatible inference endpoint.

## 3. Non-goals

This phase does not implement:

- Whisper.cpp or another speech-to-text backend.
- Piper or another text-to-speech backend.
- Vision projector installation or image inference, even when a catalog entry is vision-capable.
- OpenAI or another cloud model router.
- Fine-tuning, LoRA management, or automatic model benchmarking.
- Arbitrary model code execution.
- Concurrent inference across multiple loaded language models.

## 4. Architecture

### 4.1 llama.cpp add-on

The local llama.cpp add-on runs two cooperating processes:

1. **Model manager**
   - Owns the catalog, model downloads, validation, persistent state, storage retention, activation, probes, and rollback.
   - Exposes authenticated management endpoints only through the internal add-on path.
   - Streams operation progress to RemindMe.

2. **llama-server child process**
   - Continues serving the OpenAI-compatible API used by RemindMe.
   - Is started and supervised by the model manager.
   - Uses the active model's validated runtime profile.

Inference remains reachable at the existing `http://homeassistant:8080` endpoint. Management operations use a separate authenticated internal path and are never called directly from browser JavaScript.

### 4.2 RemindMe add-on

RemindMe adds server-side routes for:

- Catalog and compatibility reports.
- Manager and active-model status.
- Hugging Face credential configuration.
- Preflight, install, activate, cancel, and remove operations.
- Progress streaming.

The browser receives only redacted model metadata, progress, capability information, and safe errors. A per-install management secret is generated and persisted server-side; it is not exposed in public settings.

### 4.3 Persistent layout

The manager owns:

```text
/data/model-manager/
  catalog.json       # bundled catalog plus validated custom entries
  state.json         # active, fallback, operation, health, and last error
  credentials.json   # protected Hugging Face credential state
/data/models/
  *.gguf
  *.partial
```

Writes to state and completed downloads use temporary files followed by atomic rename.

## 5. Catalog

### 5.1 Catalog entry schema

Each entry defines:

- Stable ID, display name, provider, and description.
- Hugging Face repository and exact GGUF filename.
- Source trust level: official or reviewed community conversion.
- Parameter count, quantization, and expected byte size.
- Minimum and recommended RAM.
- Native and recommended context sizes.
- Runtime profile: context, threads, batch, micro-batch, cache reuse, flash attention, KV mode, and reasoning parser.
- Sampling recommendations for thinking and non-thinking modes where applicable.
- Capabilities: `chat`, `tools`, `reasoning`, and reserved future values such as `vision`, `stt`, `tts`, and `cloud`.
- Stability tier: `recommended`, `compatible`, or `experimental`.
- Whether Hugging Face authentication or prior licence acceptance is required.
- Optional checksum when the publisher provides one.

### 5.2 Initial curated families

| Family | Initial role | Initial tier |
| --- | --- | --- |
| MiniCPM5-1B Q4/Q8 | Fast assistant and compact tool worker | Compatible pending Pi validation |
| Qwen3-1.7B Q4/Q8 | Existing balanced default | Recommended |
| Granite 3.3 2B Q4/Q5 | Compact non-reasoning and tool alternative | Compatible |
| SmolLM3 3B Q4 | Conversational/reasoning alternative | Experimental |
| Qwen3-4B Q4 | Higher-quality Pi 5 8 GB profile | Recommended after Pi validation |
| Gemma 3 4B QAT Q4 | Text model with future vision capability | Compatible; authentication may be required |
| Phi-4 Mini Q4 | Strong-reasoning community GGUF option | Experimental |

Official GGUF distributions are preferred. Community conversions must remain experimental until their provenance, template, and Pi behavior are tested.

### 5.3 Custom entries

Advanced users may provide a Hugging Face repository and exact GGUF filename. Custom entries:

- Are marked `unverified`.
- Use conservative runtime defaults.
- Do not assume tools, reasoning, or multimodal support.
- Must pass the same URL, size, disk, GGUF, and activation checks as curated entries.
- Cannot provide executable code, shell flags, arbitrary URLs, or filesystem paths.

## 6. Hardware-aware recommendations

The manager evaluates total and free RAM, CPU architecture and cores, free storage, file size, selected context, and KV-cache cost.

The estimated memory requirement is:

```text
model bytes
+ estimated KV-cache bytes at selected context
+ runtime overhead
+ 25% safety reserve
```

The preflight disk requirement includes:

```text
candidate download
+ temporary download overhead
+ active model
+ rollback model
+ filesystem safety margin
```

Catalog runtime values are upper bounds, not commands to trust blindly. The manager clamps thread, batch, micro-batch, context, and cache settings to detected hardware. Unsafe candidates remain visible with a clear warning. Activation requires an explicit advanced override when the safety reserve would be violated.

For a Raspberry Pi 5 with 8 GB RAM:

- MiniCPM5-1B and Qwen3-1.7B are ranked for responsiveness.
- Qwen3-4B Q4 is ranked for improved answer quality at lower speed.
- Larger or high-precision variants are rejected or marked unsafe when sufficient headroom is unavailable.

## 7. Installation and activation flow

1. RemindMe requests a preflight report.
2. The manager validates hardware, free disk, repository access, filename, authentication, and licence-related upstream errors.
3. The candidate downloads to a `.partial` file using resumable range requests.
4. Existing chat remains available through the active model during download and validation.
5. The manager checks expected size, optional checksum, and GGUF header before atomically finalizing the file.
6. The manager enters a non-cancellable activation critical section, drains new inference work, and stops the active llama-server.
7. It starts the candidate with the clamped runtime profile.
8. It probes server health and runs a short deterministic completion.
9. On success, it persists the new active and previous fallback records, refreshes RemindMe capabilities, and performs retention cleanup.
10. On failure or timeout, it stops the candidate and restores the previous healthy server automatically.

A failed candidate remains installed and is marked unhealthy so logs and metadata can be inspected. It is never retried automatically in a loop.

## 8. Retention and removal

The manager retains exactly the last two successfully activated model files:

- Current active model.
- Most recently successful fallback model.

It may also temporarily retain:

- One active `.partial` download.
- Failed candidates until the user removes them or a later successful activation triggers cleanup, subject to disk pressure.

The manager must never delete:

- The active model.
- The fallback model during activation.
- A model participating in the current operation.
- A partial file needed for an explicitly resumable operation.

Removal requests for protected files return a conflict response explaining why removal is unsafe.

## 9. User interface

The Hardware Cookbook adds:

- Active-model summary and live health.
- Model-family cards with capability, source, stability, RAM, storage, context, and performance indicators.
- Quantization choices grouped under each family.
- Hardware compatibility ranking and warning details.
- Install and activate, activate, cancel download, and remove actions.
- One operation panel for preflight, downloading, verifying, activating, probing, success, failure, or rollback.
- An advanced custom Hugging Face form.
- A server-side-only Hugging Face token field that displays only configured/not configured state.

Each completed assistant response stores the model identifier used to generate it. Model switching does not rewrite conversation history or historical metrics.

## 10. State machine and recovery

The persisted operation state machine is:

```text
idle → preflight → downloading → verifying → activating
     → probing → active
                  ↘ rollback → active(previous)
```

On manager startup:

- A `.partial` download remains available to resume.
- An interrupted activation restores the last known healthy model.
- A missing or invalid active model triggers the stored fallback.
- If no retained model is healthy, the manager reports a degraded state and does not restart-loop.
- Malformed state is quarantined and reported rather than silently overwritten.

Only one mutating operation may run at a time. Read-only status and catalog requests remain available throughout.

## 11. Security

- Hugging Face tokens and internal manager credentials stay in protected add-on storage.
- API responses expose only credential configured/not configured state.
- Browser requests go through RemindMe server-side routes.
- Management mutations require the internal per-install credential.
- Tokens, authorization headers, and signed URLs are redacted from logs and errors.
- Repository identifiers and filenames are strictly parsed; path traversal is rejected.
- Custom entries may target only Hugging Face repositories and `.gguf` files.
- Download redirects must remain on approved Hugging Face content hosts.
- File sizes and operation durations are bounded.
- The manager never evaluates remote model code or accepts arbitrary llama.cpp flags.
- Management mutations are rate-limited and serialized.

## 12. Error handling

User-facing errors are stable, redacted categories with actionable descriptions:

- Authentication required.
- Licence acceptance required on Hugging Face.
- Repository or file not found.
- Insufficient memory.
- Insufficient storage.
- Invalid or corrupt GGUF.
- Unsupported model architecture or template.
- Download interrupted; resumable.
- Probe timed out.
- Activation failed; previous model restored.
- No healthy fallback available.
- Operation already in progress.

Raw upstream bodies and credentials are not forwarded to the browser.

## 13. Testing and acceptance

### 13.1 Unit tests

- Catalog schema and custom-entry validation.
- Capability and stability handling.
- Hardware scoring and runtime clamping.
- KV-cache and storage estimates.
- Retention and protected-file rules.
- State-machine transitions and restart recovery.
- Credential and error redaction.

### 13.2 Integration tests

A fake Hugging Face server and fake llama-server verify:

- Full and resumed downloads.
- Cancellation during download.
- Expected-size, checksum, and GGUF validation failures.
- Successful activation and capability refresh.
- Health and completion-probe failure.
- Automatic rollback.
- Power-loss recovery at each persisted transition.
- Concurrent mutation rejection.
- Gated-repository errors without token leakage.

### 13.3 Regression and build gates

- Existing chat, settings, tool-routing, timeline, and reasoning tests.
- TypeScript and browser syntax checks.
- Shell checks for add-on startup scripts.
- ARM64 Docker builds for both add-ons.
- Secret scan of changed files.

### 13.4 Manual Pi acceptance

Before promotion to recommended status, test on the real Raspberry Pi 5 8 GB:

- MiniCPM5-1B.
- Qwen3-1.7B.
- Qwen3-4B Q4.

For each model verify cold start, warm chat, explicit Home Assistant tool use, Fast/non-thinking behavior, bounded reasoning, memory headroom, download resume, successful switching, and forced rollback.

The feature is not complete until a deliberately broken candidate demonstrably restores the previous model without manual repair.

## 14. Future integration points

The catalog capability schema intentionally reserves later independent subsystems:

1. **Local media pipeline:** Whisper.cpp STT, Piper TTS, and a small vision model or vision projector.
2. **Optional cloud composer:** explicit server-side OpenAI routing for selected deeper composition tasks with cost and privacy indicators.

Neither subsystem is coupled to this phase's activation implementation beyond consuming catalog capabilities and manager health.

## 15. Reference model sources

- MiniCPM5-1B GGUF: <https://huggingface.co/openbmb/MiniCPM5-1B-GGUF>
- Qwen3-4B GGUF: <https://huggingface.co/Qwen/Qwen3-4B-GGUF>
- Granite 3.3 2B GGUF: <https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF>
- Gemma 3 4B QAT GGUF: <https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf>
- SmolLM3 GGUF conversion: <https://huggingface.co/ggml-org/SmolLM3-3B-GGUF>
- Phi-4 Mini model: <https://huggingface.co/microsoft/Phi-4-mini-instruct>
