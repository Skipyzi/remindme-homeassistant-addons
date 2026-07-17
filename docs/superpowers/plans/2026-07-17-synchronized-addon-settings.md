# Synchronized Add-on Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Supervisor-rendered options the single RemindMe configuration source and replace privileged sibling add-on mutation with secure one-time llama.cpp pairing.

**Architecture:** A focused TypeScript settings service reads, redacts, revisions, validates, and writes complete Supervisor options while the browser sends patches only. Restart is explicit and ingress-safe. The Go model manager owns its token and exchanges it once for a short-lived pairing code; RemindMe persists the paired token under its own `/data`.

**Tech Stack:** TypeScript, Express, Alpine.js, Node test runner, Go standard library, Home Assistant Supervisor REST API, llama.cpp add-on, Docker ARM64.

## Global Constraints

- Use `pnpm` where package commands are needed.
- Supervisor-rendered options are the canonical RemindMe configuration.
- Never expose stored Discord, Exa, Hugging Face, Supervisor, or manager tokens to browser state or logs.
- Do not grant RemindMe Supervisor `manager` or `admin` roles.
- Every accepted current settings change requires explicit add-on restart.
- Pairing codes are six unambiguous uppercase characters/digits, expire after ten minutes, allow five failed attempts, and are single-use.
- Preserve existing valid `/data/model-manager-token` files during migration.
- Use TDD and commit after every task.

---

### Task 1: Canonical settings model, redaction, and revisions

**Files:**

- Create: `discord-pi-bot/src/harness/addonSettings.ts`
- Create: `discord-pi-bot/test/addon-settings.test.ts`
- Modify: `discord-pi-bot/src/harness/settings.ts`

**Interfaces:**

- Produces: `normalizeAddonOptions(options: unknown): AddonOptions`
- Produces: `publicAddonSettings(options: AddonOptions): PublicAddonSettings`
- Produces: `settingsRevision(options: Record<string, unknown>): string`
- Produces: `applySettingsPatch(current: Record<string, unknown>, changes: unknown): Record<string, unknown>`
- Consumes: existing `validateLocalModelUrl()`.

- [ ] **Step 1: Write failing normalization and redaction tests**

```ts
const normalized = normalizeAddonOptions(completeOptions);
const publicValue = publicAddonSettings(normalized);
assert.equal(publicValue.discordTokenConfigured, true);
assert.equal(publicValue.exaApiKeyConfigured, true);
assert.equal(JSON.stringify(publicValue).includes("discord-secret"), false);
assert.equal(publicValue.localLlmContextSize, 8192);
```

Include all twelve schema fields and assert malformed/missing values fail with `AddonSettingsError("invalid_settings")`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd discord-pi-bot && node --import tsx --test test/addon-settings.test.ts`  
Expected: FAIL because `addonSettings.ts` does not exist.

- [ ] **Step 3: Implement explicit option types and safe public mapping**

```ts
export interface AddonOptions {
  discord_token: string;
  owner_id: string;
  pi_agent_webhook_url: string;
  local_llm_enabled: boolean;
  local_llm_url: string;
  local_llm_model: string;
  local_llm_context_size: number;
  local_llm_vision: boolean;
  model_manager_enabled: boolean;
  model_manager_url: string;
  exa_api_key: string;
  ha_notify_target: string;
}
```

Implement strict booleans, integer context range `1024..32768`, local URL validation, unknown-key preservation in the raw map, and secret configured flags.

- [ ] **Step 4: Add revision and patch tests**

Assert stable key order produces identical SHA-256 revisions, any value change changes the revision, blank secret replacements preserve existing secrets, and unknown browser fields are rejected.

- [ ] **Step 5: Implement canonical JSON hashing and patch allowlist**

Use recursive stable key sorting and `createHash("sha256")`. Map browser camelCase fields to exact snake_case Supervisor keys. Reject arrays, objects, unknown fields, and invalid types.

- [ ] **Step 6: Run focused and TypeScript tests**

Run: `node --import tsx --test test/addon-settings.test.ts && pnpm exec tsc --noEmit`  
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot/src/harness/addonSettings.ts discord-pi-bot/src/harness/settings.ts discord-pi-bot/test/addon-settings.test.ts
git commit -m "feat: model canonical addon settings"
```

### Task 2: Supervisor settings client and synchronized routes

**Files:**

- Create: `discord-pi-bot/src/harness/supervisorSettings.ts`
- Create: `discord-pi-bot/test/supervisor-settings.test.ts`
- Modify: `discord-pi-bot/src/harness-server.ts`
- Remove obsolete merge-only coverage from: `discord-pi-bot/test/settings-save.test.ts`

**Interfaces:**

- Consumes Task 1 normalization, patching, and revision functions.
- Produces `SupervisorSettingsClient.load(): Promise<LoadedAddonSettings>`.
- Produces `SupervisorSettingsClient.save(revision: string, changes: unknown): Promise<SaveSettingsResult>`.

- [ ] **Step 1: Write failing route-client tests**

Use a fake fetch that serves Supervisor envelopes. Assert `load()` calls `/addons/self/options/config`, not `/addons/self/info`, and `save()` performs GET → validate → POST → GET.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test test/supervisor-settings.test.ts`  
Expected: FAIL because `SupervisorSettingsClient` is missing.

- [ ] **Step 3: Implement typed Supervisor client**

```ts
class SupervisorSettingsClient {
  constructor(baseUrl: string, token: string, requestFetch: typeof fetch = fetch) {}
  load(): Promise<LoadedAddonSettings>;
  save(revision: string, changes: unknown): Promise<SaveSettingsResult>;
}
```

Parse `{result,data}` envelopes, classify transport as `502`, malformed response as `502`, stale revision as `409`, and validation rejection as `422`. POST raw merged options to `/options/validate`; require `data.valid === true`; then POST `{options: merged}`.

- [ ] **Step 4: Replace Express settings routes**

Make `GET /api/settings` asynchronous and live. Require POST shape `{revision,changes}`. Return safe structured errors:

```json
{"error":{"code":"configuration_changed","message":"Configuration changed elsewhere.","retryable":true}}
```

- [ ] **Step 5: Add route integration tests**

Assert external option changes are visible on the next GET, stale writes make no validation or persistence call, full payload retains unknown future keys, and no response contains secret fixtures.

- [ ] **Step 6: Run all TypeScript tests and typecheck**

Run: `node --import tsx --test test/*.test.ts && pnpm exec tsc --noEmit`  
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot/src/harness/supervisorSettings.ts discord-pi-bot/src/harness-server.ts discord-pi-bot/test
git commit -m "fix: synchronize settings through supervisor"
```

### Task 3: Complete safe settings UI

**Files:**

- Modify: `discord-pi-bot/public/app.js`
- Modify: `discord-pi-bot/public/harness.html`
- Modify: `discord-pi-bot/public/styles.css`
- Create: `discord-pi-bot/test/settings-sync-ui.test.mjs`
- Modify: `discord-pi-bot/test/harness-markup.test.mjs` if present in canonical add-on tests.

**Interfaces:**

- Consumes Task 2 public settings response and `{revision,changes}` request.
- Produces complete all-field sidebar form with configured/replace secret controls.

- [ ] **Step 1: Write failing markup/state tests**

Assert markup includes controls for owner ID, Pi webhook, local enable, URL, model, context, vision, manager enable, manager URL, notification target, Discord replacement, and Exa replacement. Assert secrets are never initialized from GET values.

- [ ] **Step 2: Verify RED**

Run: `node --test test/settings-sync-ui.test.mjs`  
Expected: FAIL because fields and patch state are absent.

- [ ] **Step 3: Implement full settings state and dirty patch tracking**

Store `settingsRevision` separately. Build `settingsChanges()` by comparing current controls against the last loaded public snapshot. Secret replacements are included only when non-empty.

- [ ] **Step 4: Implement synchronized save behavior**

POST `{revision, changes}`. On success replace all settings with returned snapshot, clear secret inputs, update revision, and show restart banner. On `409`, show a reload action without overwriting local edits automatically. Surface structured server messages.

- [ ] **Step 5: Add accessibility and narrow-layout styles**

Use associated labels, configured badges, `role="status"` for progress, `role="alert"` for failures, keyboard-operable controls, and contained mobile grids.

- [ ] **Step 6: Run browser tests and syntax checks**

Run: `node --test test/*.test.mjs && node --check public/app.js`  
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot/public discord-pi-bot/test/settings-sync-ui.test.mjs
git commit -m "feat: mirror all addon settings safely"
```

### Task 4: Explicit ingress-safe restart

**Files:**

- Create: `discord-pi-bot/src/harness/restart.ts`
- Create: `discord-pi-bot/test/restart.test.ts`
- Modify: `discord-pi-bot/src/harness-server.ts`
- Modify: `discord-pi-bot/public/app.js`
- Modify: `discord-pi-bot/public/harness.html`
- Create: `discord-pi-bot/test/settings-restart-ui.test.mjs`

**Interfaces:**

- Produces `instanceId: string` generated once per process.
- Produces `scheduleSelfRestart(callSupervisor, delayMs): void`.
- Adds `POST /api/settings/restart` returning `202 {instanceId}`.
- Extends `/api/status` with `instanceId`.

- [ ] **Step 1: Write failing response-before-restart test**

Use a controllable timer/callback and assert the route response resolves before `callSupervisor("/addons/self/restart")` runs.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test test/restart.test.ts`  
Expected: FAIL because restart scheduler is missing.

- [ ] **Step 3: Implement delayed restart scheduler**

Hold a strong timer reference, delay at least 300ms, log safe failures, and tolerate the expected connection drop when Supervisor terminates the process.

- [ ] **Step 4: Add restart routes and status instance ID**

Return `202` immediately. Reject concurrent restart requests with `409 restart_in_progress`.

- [ ] **Step 5: Implement UI readiness polling**

After confirmation, call restart, wait three seconds, poll status every two seconds for up to sixty seconds, and reload only when `instanceId` differs. On timeout restore the button and show manual instructions.

- [ ] **Step 6: Run focused and full tests**

Run: `node --import tsx --test test/restart.test.ts && node --test test/settings-restart-ui.test.mjs && pnpm exec tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot/src/harness/restart.ts discord-pi-bot/src/harness-server.ts discord-pi-bot/public discord-pi-bot/test
git commit -m "feat: add ingress safe settings restart"
```

### Task 5: Manager-owned token and one-time pairing codes

**Files:**

- Create: `local-llama-cpp/manager/internal/pairing/pairing.go`
- Create: `local-llama-cpp/manager/internal/pairing/pairing_test.go`
- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`

**Interfaces:**

- Produces `pairing.NewStore(tokenPath, statePath string, now func() time.Time, random io.Reader) (*Store, error)`.
- Produces `Store.Generate() (code string, expiresAt time.Time, error)`.
- Produces `Store.Exchange(code string) (token string, error)`.
- Produces sentinel errors `ErrInvalidCode` and `ErrRateLimited`.

- [ ] **Step 1: Write failing token and code lifecycle tests**

Assert token creation is 32 random bytes encoded safely, file mode is `0600`, code alphabet excludes `0/O/1/I`, expiry is ten minutes, fifth bad attempt invalidates the code, valid exchange succeeds once, and regeneration supersedes the prior code.

- [ ] **Step 2: Verify RED**

Run: `cd local-llama-cpp/manager && go test ./internal/pairing -v`  
Expected: package missing.

- [ ] **Step 3: Implement atomic token ownership**

Use temp file, `Sync`, `Chmod(0600)`, rename, and parent directory sync. Import a non-empty legacy `manager_token` only when the manager-owned token file does not exist.

- [ ] **Step 4: Implement pairing code state**

Persist only SHA-256 code hash, expiry, attempts, and consumed state. Compare hashes with `subtle.ConstantTimeCompare`. Never include code/token in errors.

- [ ] **Step 5: Generate and log one startup code**

At manager startup generate a new code, invalidate prior state, and print only the code and expiry. Never print the long-lived token.

- [ ] **Step 6: Run Go tests, vet, and ARM64 compile**

Run: `go test ./... && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/model-manager`.

- [ ] **Step 7: Commit**

```bash
git add local-llama-cpp/manager
git commit -m "feat: add one time manager pairing codes"
```

### Task 6: Pairing API and safe manager status

**Files:**

- Modify: `local-llama-cpp/manager/internal/api/server.go`
- Modify: `local-llama-cpp/manager/internal/api/server_test.go`
- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`

**Interfaces:**

- Adds dependency `Pairing interface { Exchange(string) (string,error) }`.
- Adds unauthenticated `POST /manager/v1/pair` accepting `{code:string}`.
- Existing lifecycle routes remain bearer-authenticated.

- [ ] **Step 1: Write failing API tests**

Assert valid code returns `{token}` once, invalid/expired/consumed all return identical `401 pairing_invalid`, exhausted attempts return `429 pairing_rate_limited`, lifecycle endpoints still require bearer auth, and status/events never expose pairing material.

- [ ] **Step 2: Verify RED**

Run: `go test ./internal/api -run Pair -v`  
Expected: route not found.

- [ ] **Step 3: Implement isolated pairing route**

Register it outside the bearer middleware. Apply request body limit, exact JSON shape, constant safe errors, `Cache-Control: no-store`, and no token logging.

- [ ] **Step 4: Wire pairing store into composition root**

Pass manager-owned token accessor to API authentication and pairing store to the exchange route.

- [ ] **Step 5: Run full Go verification**

Run: `go test ./... && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/model-manager`.

- [ ] **Step 6: Commit**

```bash
git add local-llama-cpp/manager
git commit -m "feat: expose secure manager pairing exchange"
```

### Task 7: RemindMe pairing client, routes, and UI

**Files:**

- Modify: `discord-pi-bot/src/harness/modelManager.ts`
- Modify: `discord-pi-bot/src/harness-server.ts`
- Modify: `discord-pi-bot/public/components/model-cookbook.js`
- Modify: `discord-pi-bot/public/harness.html`
- Modify: `discord-pi-bot/public/styles.css`
- Modify: `discord-pi-bot/test/model-manager.test.ts`
- Modify: `discord-pi-bot/test/model-manager-routes.test.ts`
- Create: `discord-pi-bot/test/model-pairing-ui.test.mjs`

**Interfaces:**

- Removes `ensureModelManagerPairing()` sibling option mutation.
- Adds `pairModelManager(baseUrl, code, secretPath, fetch): Promise<void>`.
- Adds `POST /api/models/pair` accepting `{code}` and returning configured state only.

- [ ] **Step 1: Write failing pairing client tests**

Assert the client calls `/manager/v1/pair` without a bearer token, atomically persists the returned token at `0600`, does not replace an existing valid token on failure, and never returns/logs token values.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test test/model-manager.test.ts`  
Expected: missing pairing API.

- [ ] **Step 3: Replace automatic sibling mutation**

Delete Supervisor add-on discovery/update logic. At startup, use an existing token if present; otherwise report unpaired without failing the RemindMe server.

- [ ] **Step 4: Implement safe pairing route**

Validate code shape, exchange server-to-server, save atomically, and return `{configured:true}` only. Map manager `401`, `429`, and transport failures safely.

- [ ] **Step 5: Implement pairing UI**

Show pairing status and six-character code input only when unpaired. Clear code after every attempt. Never persist it in local storage. Reload catalog/status after success.

- [ ] **Step 6: Run all Node tests and typecheck**

Run: `node --import tsx --test test/*.test.ts && node --test test/*.test.mjs && pnpm exec tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot
git commit -m "feat: pair model manager without supervisor mutation"
```

### Task 8: Packaging, migration, documentation, and release gates

**Files:**

- Modify: `discord-pi-bot/config.yaml`
- Modify: `discord-pi-bot/README.md`
- Modify: `local-llama-cpp/config.yaml`
- Modify: `local-llama-cpp/README.md`
- Modify: `local-llama-cpp/run.sh`
- Modify: `test/local-model-addon.test.mjs`
- Add or modify integration tests under both add-ons.

**Interfaces:**

- Releases RemindMe `2.3.0` and managed llama.cpp `1.9.0`.
- Keeps legacy `manager_token` readable for one migration release but manager-owned token file is authoritative.

- [ ] **Step 1: Write failing packaging/migration tests**

Assert RemindMe has no `hassio_role: manager`, no sibling options route literals, manager token files are under each add-on's `/data`, legacy llama token imports only when needed, and versions are exact.

- [ ] **Step 2: Verify RED**

Run relevant Node packaging tests and expect version/migration assertions to fail.

- [ ] **Step 3: Update startup and schemas**

Stop requiring RemindMe startup pairing. Make manager-owned token file authoritative. Retain legacy llama `manager_token` option for migration compatibility and document deprecation. Bump versions.

- [ ] **Step 4: Update operator documentation**

Document settings synchronization, configured secret controls, conflict recovery, explicit restart, where to obtain pairing code, expiry/attempt behavior, migration, and rollback.

- [ ] **Step 5: Run complete code gates**

```bash
cd local-llama-cpp/manager
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/model-manager
cd ../../discord-pi-bot
node --import tsx --test test/*.test.ts
node --test test/*.test.mjs
pnpm exec tsc --noEmit
node --check public/app.js
node --check public/components/model-cookbook.js
cd ..
node --test test/*.test.mjs
sh -n local-llama-cpp/run.sh
sh -n discord-pi-bot/run.sh
```

Expected: all commands exit zero.

- [ ] **Step 6: Build both ARM64 images**

```bash
docker build --platform linux/arm64 -t remindme-local-llama:1.9.0 local-llama-cpp
docker build --platform linux/arm64 -t remindme-discord-bot:2.3.0 discord-pi-bot
```

Expected: both images build successfully.

- [ ] **Step 7: Run repository secret scan**

Use gitleaks against the repository with redaction and require zero findings.

- [ ] **Step 8: Commit release**

```bash
git add discord-pi-bot local-llama-cpp test
git commit -m "feat: release synchronized settings and secure pairing"
```

- [ ] **Step 9: Push the feature branch after verifying a clean tree**

```bash
git diff --check
git status --short
git push -u origin fix/synchronized-addon-settings
```
