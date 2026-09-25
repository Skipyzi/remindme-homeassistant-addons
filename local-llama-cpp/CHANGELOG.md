# Changelog

## 2.0.0 - 2026-09-25

### Changed

- **Every downloaded model is served at once, from the same endpoint.** `llama-server` now
  runs in router mode. A request's `model` field picks the model; requests that name no
  model, or a model the add-on doesn't have, get the default model. Clients written for a
  single-model server (such as a dictation cleanup app) therefore keep working unchanged,
  while RemindMe chats with a model of its own.
- **Switching the default no longer restarts anything.** Activation loads and checks the
  candidate, then moves the default; if the candidate fails to answer, the previous
  default stays.
- **Switching no longer deletes models.** Previously every activation removed all model
  files except the new model and its fallback, so switching back meant downloading again.
  Files are now removed only when you remove them.

### Added

- **`resident_models`** (default `0`, automatic): how many models stay loaded. Automatic
  keeps two when the host has at least 4 GB free at start-up and one otherwise; with one,
  the router loads each requested model on demand and unloads the previous one.
- **`parallel`** (default 2): llama-server slots per model. With `kv_unified` on, each slot
  can use the whole context and keeps its own prompt cache, so RemindMe's routing call and
  its answer, or a chat turn and a dictation request, no longer evict each other's cached
  prompt. Without `kv_unified` the server keeps one slot.
- `/manager/v1/status` reports `models` (every model served) and `defaultModel`.

## 1.14.0 - 2026-08-19

### Added

- **Qwen3.8 models in the catalog**, as 2B and 4B distillations: `Qwen3.8 2B Distill`
  (Q4_K_M and Q8_0) and `Qwen3.8 4B Distill` (Q4_K_M). They carry Qwen3.8's 262k native
  context; the recommended context stays at 8192 because a Pi runs out of KV cache long
  before it runs out of model.

  Worth knowing what these are: Qwen released Qwen3.8 only as a 27B model and a 2.4T
  mixture-of-experts, neither of which fits a Raspberry Pi. The entries above are
  community distillations of that release, listed as `reviewed-community` alongside
  SmolLM3 and Phi-4 Mini rather than as official builds. Each was checked to report the
  `qwen35` architecture the bundled llama.cpp supports, to ship the file its name claims,
  and to match the pinned checksum. The official Qwen3 entries are unchanged and remain
  the recommended default.

  Two repositories that advertise small "Qwen3.8" builds are not what they appear to be:
  `Ma7ee7/Qwen3.8_4B_Distilled_GGUF` contains Qwen3 4B Thinking files, and
  `Ma7ee7/Qwen3.8_1.2B_LFM_Distillation_GGUF` contains LiquidAI LFM2.5. Neither is
  included.

### Changed

- The bundled-catalog test now checks every entry rather than counting them: a usable
  SHA-256, a positive size and parameter count, a recommended context within the model's
  native window, and a known source.

## 1.13.2 — 2026-08-02

- Persist startup verification for configured catalog models so a physically stored model remains reusable from chat after restart or after switching away.
- Revalidate unrecorded existing files, including curated SHA-256 checks, before marking them verified; freshly downloaded startup models reuse the downloader's completed verification.

## 1.13.1 — 2026-08-02

- Re-inspect persisted custom models whose catalog entry has no resolved byte size instead of sending `ExpectedBytes: 0` into the downloader.
- Cover both exact-file and `repo:quantization` startup recovery from unresolved custom catalog entries.

## 1.12.1 — 2026-08-02

- Accept current official Hugging Face CDN and Xet redirects, including `us.aws.cdn.hf.co`, while retaining strict HTTPS and domain-boundary validation.
- Support custom native Home Assistant model configuration with either an exact repository/GGUF filename pair or llama.cpp-style `owner/repo:quantization` shorthand.
- Resolve custom models through Hugging Face metadata, reject ambiguous, split, and sidecar-only selections, and preserve resumable size/GGUF verification.
- Strip Hugging Face authorization before cross-host CDN/storage requests and keep tokens and signed URLs out of diagnostics.
- Preserve invalid or unavailable native configuration instead of silently replacing it.
