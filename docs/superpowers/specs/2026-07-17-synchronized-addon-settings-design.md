# Synchronized Add-on Settings and Secure Model Pairing Design

**Date:** 2026-07-17  
**Status:** Approved for implementation planning

## Purpose

Make the RemindMe sidebar and Home Assistant's native add-on Configuration tab two views of the same canonical Supervisor configuration. Replace RemindMe's privileged attempt to mutate the separate llama.cpp add-on with a direct, one-time pairing protocol.

## Problems

The current implementation has four conflicting configuration surfaces:

1. Supervisor's persisted add-on options.
2. `/data/options.json` read by `run.sh` at startup.
3. Environment variables exported once by `run.sh`.
4. `/data/model-manager-token`, generated independently of either add-on schema.

`GET /api/settings` reads boot-time environment variables rather than current Supervisor options. Changes made in Home Assistant therefore do not appear in the sidebar until restart. The sidebar also exposes only a subset of the schema.

`POST /addons/self/options` is a complete replacement validated against the add-on schema, not a partial patch. A safe write must merge edits into the latest full configuration before posting it.

RemindMe currently tries to write `manager_token` into the llama.cpp add-on. Supervisor requires the `manager` or `admin` role to modify a sibling add-on. Granting that role would be excessive and would still leave two configuration surfaces to synchronize.

## Goals

- Treat Supervisor-rendered RemindMe options as the only canonical add-on configuration.
- Mirror every RemindMe schema field in the sidebar without exposing stored secret values.
- Detect concurrent edits made through another tab or Home Assistant's Configuration page.
- Validate complete merged options before persistence.
- Make restart-required behavior explicit and reliable through ingress.
- Pair RemindMe with llama.cpp without sibling add-on mutation or elevated Supervisor roles.
- Preserve all existing chat, reminder, Home Assistant, Exa, and model-manager behavior.

## Non-goals

- Live-reload every startup-bound setting.
- Grant RemindMe `hassio_role: manager` or `admin`.
- Expose Supervisor, manager, Discord, Exa, or Hugging Face credentials to browser state.
- Replace Home Assistant's native Configuration page.
- Add STT, TTS, vision execution, or cloud composition.

## Architecture

### Configuration source

Supervisor owns RemindMe's add-on options. The backend reads live rendered configuration from:

```text
GET http://supervisor/addons/self/options/config
Authorization: Bearer $SUPERVISOR_TOKEN
```

`/data/options.json` remains the startup input used by `run.sh`. Exported environment variables are boot snapshots and must not be used as the settings UI's canonical read source.

### Configuration service

Create a focused TypeScript configuration service responsible for:

- Fetching and validating Supervisor response envelopes.
- Normalizing all RemindMe schema fields.
- Redacting secrets for browser responses.
- Producing deterministic revision hashes.
- Validating browser patches against an explicit allowlist and field types.
- Preserving blank secret values.
- Merging patches into freshly fetched full options.
- Preflighting the complete map through Supervisor validation.
- Persisting the complete map through Supervisor.
- Distinguishing validation, conflict, transport, and malformed-response errors.

The browser never receives raw Supervisor options.

## Public settings model

`GET /api/settings` returns:

```json
{
  "revision": "sha256-hex",
  "discordTokenConfigured": true,
  "ownerId": "235480697899450368",
  "piAgentWebhookUrl": "",
  "localLlmEnabled": true,
  "localLlmUrl": "http://homeassistant:8080/v1/chat/completions",
  "localLlmModel": "qwen3-1.7b",
  "localLlmContextSize": 8192,
  "localLlmVision": false,
  "modelManagerEnabled": true,
  "modelManagerUrl": "http://homeassistant:8080/manager/v1",
  "exaApiKeyConfigured": false,
  "notifyTarget": "",
  "hardwareProfile": {}
}
```

Raw `discord_token` and `exa_api_key` values are never serialized. Secret replacement controls start empty. A configured flag indicates whether a stored value exists.

## Settings load flow

1. Browser requests `GET /api/settings` with `cache: no-store`.
2. RemindMe requests `/addons/self/options/config` server-side.
3. RemindMe verifies the HTTP status, JSON envelope, and options object.
4. RemindMe normalizes all known fields and computes the revision from a canonical serialization of the complete rendered option map, including unknown future keys.
5. RemindMe returns the redacted public model plus the hardware profile.
6. The browser replaces its complete settings state with the response.

A native Configuration-tab edit therefore appears on the next sidebar load without restarting the add-on.

## Settings save flow

The browser submits only changed fields:

```json
{
  "revision": "revision-returned-by-GET",
  "changes": {
    "localLlmContextSize": 4096,
    "notifyTarget": "mobile_app_phone"
  }
}
```

The server performs this sequence:

1. Validate request shape.
2. Reject unknown fields, invalid types, invalid URLs, and out-of-range context sizes.
3. Fetch `/addons/self/options/config` again.
4. Compute the latest revision.
5. Return `409 configuration_changed` if it differs from the submitted revision.
6. Convert public camelCase fields to Supervisor snake_case option keys.
7. Remove blank secret replacements from the patch so current secrets remain unchanged.
8. Merge the patch into the freshly fetched complete options.
9. POST the raw merged option object to `/addons/self/options/validate`.
10. If valid, POST `{ "options": merged }` to `/addons/self/options`.
11. Fetch the rendered options again and return the resulting redacted settings snapshot.
12. Return `restartRequired: true` for every accepted change because every current schema field is consumed at process startup.

The browser never submits a full options object and cannot erase fields it does not know about.

## Concurrency

The revision is a SHA-256 hash of stable-key canonical JSON for the complete rendered option map, including unknown future keys and secret values only inside the server-side hash input. The hash itself reveals no secret.

A save based on stale state returns HTTP `409` and performs no write. The UI tells the user that configuration changed elsewhere and reloads the latest values only after confirmation, preventing silent overwrite of a concurrent native Configuration-tab edit.

## Secrets

Secret rules:

- Existing secret values never enter browser responses, DOM attributes, local storage, logs, or error messages.
- `discordToken` and `exaApiKey` replacement inputs are optional and initially empty.
- Missing or blank replacement values preserve the current option.
- A non-empty replacement is sent once to the server and cleared from browser state after success.
- Server errors use field names but never values.
- Revision hashes may include secrets in their input but only the digest leaves the server.

## Restart flow

Saving startup-bound options does not pretend to update the running process. The UI displays a restart-required banner and explicit button.

`POST /api/settings/restart`:

1. Captures the current random process instance ID.
2. Returns HTTP `202` with that ID.
3. After the response has had time to flush through ingress, schedules `POST /addons/self/restart` in the background.

The browser waits briefly, then polls `GET /api/status` with `cache: no-store`. It reloads only after observing a different instance ID. A timeout leaves the button enabled and shows manual recovery instructions.

## Manager pairing redesign

### Ownership

The llama.cpp model manager owns its long-lived manager token. It generates the token during first startup if none exists and stores it atomically under its own `/data` with mode `0600`. `manager_token` is removed as a required cross-add-on synchronization mechanism.

RemindMe stores its paired copy under `/data/model-manager-token` with mode `0600`.

### Pairing codes

The manager exposes an authenticated-local bootstrap state with a short-lived one-time code:

- Six unambiguous uppercase characters and digits.
- Ten-minute expiration.
- Only a hash and expiry are persisted.
- A new code invalidates the previous code.
- A successful exchange invalidates the code immediately.
- An active code permits five failed attempts. The fifth failure invalidates it and subsequent attempts return `429` until a new code is generated.
- Codes and long-lived tokens are redacted from errors.

A new code is generated and printed once to the llama.cpp add-on log at each manager startup. Restarting the llama.cpp add-on invalidates the prior code and produces a replacement. The long-lived token is never logged.

### Pairing exchange

RemindMe submits the user-entered code server-side to the manager's internal pairing endpoint. On success, the manager returns its long-lived token once. RemindMe atomically persists the token and clears the code from browser state. Existing manager API calls continue using the persisted token.

Pairing failure never deletes a currently valid stored token.

### Manager authorization states

- Pairing endpoint: accepts only an active pairing code and is separately rate-limited.
- Health/inference proxy behavior remains unchanged.
- All `/manager/v1/*` lifecycle endpoints continue requiring the long-lived bearer token.
- Credential and token material never appears in catalog, status, event, or error responses.

## UI

The settings panel mirrors every RemindMe schema field:

- Discord token: configured badge plus replacement input.
- Owner ID.
- Pi agent webhook URL.
- Local LLM enabled.
- Local LLM URL.
- Local model identifier.
- Context size.
- Vision capability override.
- Model manager enabled.
- Model manager URL.
- Exa key: configured badge plus replacement input.
- Home Assistant notify target.

The model vault includes a pairing status and code input when the manager is unpaired. Saving, conflict, validation, pairing, and restart outcomes use visible accessible status/alert regions.

## Errors

- `400 invalid_settings`: malformed request, unsupported field, or invalid value.
- `409 configuration_changed`: Supervisor options changed after the browser loaded them.
- `422 configuration_invalid`: Supervisor validation rejected the merged map; include its safe message.
- `429 pairing_rate_limited`: pairing attempts exceeded.
- `502 supervisor_unavailable`: Supervisor transport or malformed response.
- `503 manager_unavailable`: model manager transport failure.
- `401 pairing_invalid`: invalid, expired, or consumed pairing code, without distinguishing which condition.

Transport errors and validation errors remain distinct. Browser-visible errors contain remediation text and no credentials.

## Testing

### TypeScript

- Map every schema field from a realistic `/options/config` response.
- Prove secrets become configured flags and never appear in JSON output.
- Prove blank secret replacements preserve existing values.
- Prove complete merged payloads retain unknown future option keys.
- Prove unknown browser fields and invalid types are rejected.
- Prove stale revisions return `409` before validation or persistence.
- Prove Supervisor validation occurs before options persistence.
- Prove an external native Configuration-tab edit appears on the next GET.
- Prove restart response completes before the Supervisor restart call begins.
- Prove the browser displays conflict, validation, and restart timeout states.

### Go manager

- Generate and persist a long-lived token with restrictive permissions.
- Generate pairing codes with expected alphabet and expiration.
- Reject invalid, expired, consumed, and superseded codes identically.
- Enforce attempt limits and return `429`.
- Exchange a valid code once and return the existing long-lived token.
- Never leak token or pairing code through errors, status, events, or logs under test.

### Integration and release gates

- Save in sidebar, confirm native Configuration tab reflects all fields.
- Edit in native Configuration tab, confirm sidebar reload reflects the edit.
- Exercise concurrent edit conflict.
- Restart through ingress and verify a new instance ID before reload.
- Pair RemindMe with llama.cpp without `hassio_role: manager`.
- Run all Node tests, TypeScript checks, browser syntax checks, Go tests, Go vet, ARM64 compilation, both ARM64 Docker builds, and secret scanning.

## Migration

- Existing Supervisor options remain valid.
- Existing `/data/model-manager-token` remains accepted.
- If an existing token authenticates successfully, pairing is reported complete and no code is required.
- The llama.cpp `manager_token` option may be read during migration and imported into the manager-owned token file, then retained only for backward compatibility during the release transition.
- RemindMe no longer attempts sibling option writes.
- Add-on versions must be bumped and both add-ons restarted after upgrade.

## Acceptance criteria

1. Sidebar and native Configuration tab reflect the same RemindMe options after reload.
2. Every schema field is represented in the sidebar.
3. Stored secrets never reach the browser.
4. Concurrent edits cannot silently overwrite each other.
5. Startup-bound changes clearly require and survive restart.
6. RemindMe pairs with llama.cpp without modifying sibling Supervisor options.
7. Existing paired installations migrate without losing a working token.
8. All automated, ARM64, Docker, ingress, and secret-scanning gates pass.
