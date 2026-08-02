# Hugging Face Custom Model Repair Design

**Date:** 2026-08-02

## Purpose

Restore model downloads and native Home Assistant model configuration in the Local llama.cpp add-on without weakening the manager's download, storage, or activation safeguards.

The repair must:

- make every currently valid public curated model downloadable again;
- accept an arbitrary valid Hugging Face repository plus exact GGUF filename;
- accept llama.cpp-style `<owner>/<repo>:<quant>` shorthand when `hf_file` is blank;
- preserve curated checksum verification and the existing resumable download and activation lifecycle;
- keep credentials and signed download URLs out of logs and API responses.

## Root Causes

The current downloader allows only a small, stale set of redirect hosts. Hugging Face currently redirects valid model downloads to hosts such as `us.aws.cdn.hf.co`, which the manager rejects as unapproved. Live checks confirmed that the seven public catalog entries still exist and that their reported sizes and content hashes match the catalog. The gated Gemma entry correctly requires authentication.

Startup also resolves `hf_repo` and `hf_file` exclusively against the curated catalog. Its only shorthand handling strips the literal suffix `:Q4_K_M`. Consequently, explicit custom files and other valid quantization suffixes are rejected before repository inspection or download.

## Scope

This change targets the Local llama.cpp Go manager in the `Skipyzi/remindme-homeassistant-addons` checkout at `.worktrees/hardware-model-cookbook`.

In scope:

- secure Hugging Face redirect handling;
- custom exact-file resolution;
- llama.cpp-compatible quantization shorthand resolution;
- startup bootstrap integration;
- safe persistence of resolved custom model metadata;
- errors, tests, documentation, changelog, and add-on version bump.

Out of scope:

- arbitrary non-Hugging-Face download URLs;
- downloading multi-file/split GGUF models;
- automatic sidecar downloads such as multimodal projection, MTP, Eagle, or draft models;
- changing the RemindMe Model Workbench UI;
- replacing valid curated catalog entries merely because their redirects currently fail.

## Architecture

### Model resolver

Introduce a focused Hugging Face model resolver that converts native add-on options into one concrete `catalog.Variant`. The resolver has three paths:

1. **Curated exact match**
   - Match normalized repository and exact file against the built-in catalog.
   - Retain trusted catalog size, SHA-256, capabilities, hardware requirements, and runtime recommendations.

2. **Custom exact file**
   - Validate `<owner>/<repo>` and the `.gguf` file path using the existing custom-model validation rules.
   - Inspect the exact resolve endpoint to obtain the remote byte size.
   - Produce an unverified custom variant with conservative runtime defaults.

3. **Repository shorthand**
   - Parse `<owner>/<repo>[:<quant>]` without special-casing any one quantization.
   - Query Hugging Face repository metadata using the configured read token when present.
   - Select a single-file GGUF using case-insensitive rules derived from llama.cpp's current resolver.
   - With a quantization, select the unique valid model file whose filename contains that quantization token followed by `.` or `-`.
   - Without a quantization, prefer `Q4_K_M`, then `Q8_0`, then a sole remaining valid model GGUF.
   - Exclude sidecars and auxiliary files containing `mmproj`, `imatrix`, `mtp-`, `eagle3-`, or `dflash-`.
   - Reject ambiguous matches and split GGUF selections rather than depending on repository listing order or downloading only a first shard.

The concrete result feeds the existing hardware assessment, download, verification, inventory, and supervisor activation pipeline. Resolved custom variants use stable IDs derived from repository and filename and are persisted in the protected custom catalog so manager restarts and activation APIs refer to the same model.

### Startup behavior

`model_path` remains authoritative. When it is configured, its current canonicalization and `/data/models` confinement rules continue to apply.

When `model_path` is blank:

1. Read `hf_repo`, `hf_file`, and `hf_token` from `/data/options.json`.
2. Normalize and resolve the configured selection.
3. Use curated metadata when the exact selection is curated; otherwise inspect Hugging Face for exact remote size.
4. Run the current hardware preflight.
5. Download a missing model through the managed downloader.
6. Verify and finalize it.
7. Start `llama-server` with the native runtime options.

Unknown custom selections are no longer rejected merely for being absent from the curated catalog.

## Download Security

### Approved redirect policy

Redirects must remain HTTPS and must stay within Hugging Face-controlled infrastructure. Host matching uses exact names or dot-boundary suffixes, never raw string suffixes that accept lookalike domains.

Approved domain families:

- `huggingface.co`;
- `hf.co` and its subdomains, including current CDN hosts such as `us.aws.cdn.hf.co` and `cdn-lfs-us-1.hf.co`;
- `xethub.hf.co` and its subdomains;
- `xethub-eu.hf.co` and its subdomains.

The redirect limit remains bounded. HTTP redirects, user-info URLs, unrelated hosts, and lookalikes such as `hf.co.attacker.example` are rejected with the safe redirect error.

### Credential forwarding

The Hugging Face bearer token is sent only to trusted Hugging Face API and resolve endpoints that require it. Redirects to signed CDN or storage URLs must not inherit the `Authorization` header. The signed URL itself must never be logged or returned through manager APIs.

### Download integrity

The existing managed download lifecycle remains:

- enforce a positive remotely reported size and the configured maximum size;
- download to `/data/models/<filename>.partial`;
- safely resume with range requests;
- require the exact expected byte count;
- require a valid `GGUF` header;
- require SHA-256 equality for curated entries;
- use protected file permissions;
- atomically rename the completed file.

Custom models without a trusted catalog checksum remain explicitly unverified until their size and GGUF structure pass manager verification.

## Error Handling

Configuration is preserved on every failure. Errors must be actionable and credential-free, distinguishing:

- invalid repository or GGUF filename;
- repository or file unavailable;
- authentication or licence acceptance required;
- requested quantization not found, with a bounded list of available model GGUF choices;
- ambiguous selection;
- split GGUF unsupported;
- missing, invalid, or excessive reported size;
- redirect outside approved HTTPS Hugging Face infrastructure;
- interrupted resumable download;
- downloaded size, GGUF header, or checksum mismatch;
- hardware preflight failure;
- runtime activation failure.

No error includes a bearer token, authorization header, signed query string, or private path outside the existing safe model path reporting.

## Compatibility

- Existing curated `hf_repo` plus `hf_file` configurations retain their trusted metadata and runtime behavior.
- Existing exact custom repository and filename configurations begin working without requiring Model Workbench pairing.
- Any syntactically valid quantization suffix is handled case-insensitively; behavior is no longer tied to `:Q4_K_M`.
- `unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL` with blank `hf_file` resolves to its matching primary single-file GGUF rather than being rejected as non-curated.
- Existing downloaded files, partial downloads, manager state, protected credentials, and `model_path` configurations remain compatible.
- The add-on version is bumped so Home Assistant can detect and install the repair.

## Testing

### Redirect tests

- accept the current official `us.aws.cdn.hf.co` redirect;
- accept representative `hf.co`, `xethub.hf.co`, and `xethub-eu.hf.co` subdomains;
- reject HTTP redirects;
- reject unrelated and boundary-lookalike hosts;
- enforce the redirect limit;
- prove that bearer authorization is removed before a CDN request;
- preserve authentication on trusted API/resolve requests where required.

### Resolver tests

- preserve a curated exact match and its checksum metadata;
- resolve an explicit custom repository and GGUF file;
- resolve multiple quantization suffixes case-insensitively;
- cover `unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL`;
- apply blank-quantization preferences in order;
- exclude projection, imatrix, MTP, Eagle, and draft sidecars;
- reject missing, ambiguous, and split selections with specific errors;
- reject malformed repository and filename input;
- avoid exposing tokens or signed URLs in errors.

### Startup and regression tests

- bootstrap a curated model through resolve, download, verification, and activation;
- bootstrap exact and shorthand custom models through the same pipeline;
- preserve `model_path` precedence and path confinement;
- preserve partial-download resume behavior;
- run all manager unit and integration tests;
- run Go race tests for manager packages;
- verify add-on metadata, documentation, changelog, and version bump.

## Success Criteria

The repair is complete when:

1. A current curated public model follows its official Hugging Face CDN redirect and downloads successfully.
2. A custom exact `hf_repo` and `hf_file` pair bootstraps without appearing in the curated catalog.
3. `unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL` with blank `hf_file` resolves, downloads, verifies, and can activate.
4. Unsafe redirects and credential forwarding remain blocked by tests.
5. Existing manager tests and race tests pass.
6. Home Assistant detects the bumped add-on release.
