# Model Manager Connectivity Hotfix Design

## Problem

After upgrading RemindMe and the managed llama.cpp add-on, an existing Home Assistant installation can retain loopback URLs such as `http://127.0.0.1:8080`. Inside the RemindMe container, loopback addresses refer to RemindMe itself, not the separate llama.cpp add-on. The settings validator currently accepts these values, and only the inference URL receives a defensive startup rewrite. The manager URL therefore remains unreachable.

Separately, the llama.cpp manager bootstrap emits a generic degraded message when the configured `hf_repo` and `hf_file` do not exactly match a curated catalog entry. This is safe but does not identify the non-secret mismatch or explain how to recover. The manager API itself still starts and must remain available for pairing and model installation.

## Goals

- Repair legacy loopback inference and manager URLs without exposing credentials or requiring manual file edits.
- Make `homeassistant:8080` the sole canonical cross-add-on host for these settings.
- Prevent new invalid loopback values from being persisted through the sidebar.
- Preserve existing model selections when they are not curated; never silently replace them.
- Make degraded bootstrap diagnostics actionable while keeping the manager and pairing API available.
- Add regression coverage for migration, validation, startup normalization, and diagnostics.

## Non-goals

- Automatically replacing a custom or unknown model with a curated model.
- Supporting public, Tailscale, localhost, or arbitrary hosts for server-side manager traffic.
- Changing the curated model catalog.
- Changing model download, activation, rollback, or retention behavior.

## URL Canonicalization

A focused URL canonicalizer will own cross-add-on endpoint rules. It accepts a URL, endpoint kind, and migration policy.

For migration reads, these hosts are recognized:

- `homeassistant`
- `localhost`
- `127.0.0.1`

All accepted legacy forms must use HTTP and port `8080`. They are returned with host `homeassistant`, no query or fragment, and the exact endpoint path:

- Inference: `/v1/chat/completions`
- Manager: `/manager/v1`

External hosts, HTTPS, other ports, credentials, and incorrect paths are rejected. New settings patches are canonicalized before validation and persistence, so Supervisor receives only canonical values. Live settings reads return canonical values immediately; a subsequent save persists the migration.

The RemindMe startup script retains defense in depth. It rewrites legacy loopback inference and manager URLs to their canonical endpoints before exporting environment variables. This allows an upgraded installation to recover after restart even before the sidebar is opened or saved.

## Settings Data Flow

1. RemindMe reads the Supervisor-rendered complete option map.
2. The option model canonicalizes both local endpoints in migration mode.
3. Validation checks the resulting canonical URLs and all existing schema constraints.
4. The public settings response contains canonical URLs and no secrets.
5. A revision is computed from the canonical complete option map.
6. A settings patch is allowlisted and merged into freshly fetched options.
7. Endpoint values are canonicalized and validated again before the complete map is written to Supervisor.

Canonicalization must not alter unrelated fields or configured secret values.

## Manager Client Behavior

`deriveManagerUrl` and direct manager client construction will accept only canonical internal traffic. Legacy loopback values should be translated before this layer by settings/startup migration. This keeps the client boundary strict and avoids treating loopback as a permanent alias.

A missing or unreachable manager continues to return the existing safe `manager_unavailable` response. Tokens, pairing codes, request bodies, and internal paths remain absent from browser responses and logs.

## Unknown Bootstrap Model Behavior

When `hf_repo` and `hf_file` do not match a curated variant:

- Do not modify the options.
- Do not choose or download a fallback model.
- Keep the HTTP manager, catalog, and pairing endpoints running.
- Mark startup as degraded as today.
- Log the configured repository and filename because they are non-secret operator configuration.
- Log the exact curated default recovery tuple:
  - Repository: `Qwen/Qwen3-1.7B-GGUF`
  - File: `Qwen3-1.7B-Q8_0.gguf`
- Explain that the operator may instead pair RemindMe and install a model through Hardware Cookbook.

The Hugging Face token must never be included in diagnostics.

## Error Handling

- Invalid endpoint settings return the existing `400 invalid_settings` response.
- Supervisor validation failures remain `422 configuration_invalid`.
- Stale settings revisions remain `409 configuration_changed`.
- Network failures remain `503 manager_unavailable`.
- Unknown bootstrap models are a degraded runtime state, not a fatal process error.

## Testing

### TypeScript

- Legacy loopback inference and manager URLs canonicalize to `homeassistant:8080`.
- Canonical URLs remain unchanged.
- HTTPS, external hosts, wrong ports, credentials, query strings, fragments, and wrong paths are rejected.
- Settings reads expose canonical values.
- Settings saves persist canonical complete options without changing secrets or unknown fields.
- Manager URL derivation rejects non-canonical hosts after migration.

### Shell/package tests

- `run.sh` defensively normalizes both inference and manager loopback values.
- Released add-on defaults remain canonical.

### Go

- An unknown configured repository/file does not start a fallback download.
- The diagnostic names the safe configured tuple and recovery tuple.
- The manager HTTP server remains available independently of degraded bootstrap.
- No token value appears in diagnostics.

## Release and Recovery

Release as a patch update to both add-ons because both startup boundaries change. Existing data and tokens remain intact. Operators can recover immediately by using canonical `homeassistant:8080` URLs and either restoring the curated Qwen tuple or pairing and choosing a model in Hardware Cookbook. Rollback does not require deleting `/data`.
