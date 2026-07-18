# Manual llama.cpp Model Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supervisor-mirrored settings and automatic model activation with local harness preferences, download-only verified models, complete copyable llama.cpp YAML, options-authoritative startup, and runtime model discovery.

**Architecture:** The harness Settings modal becomes browser-local and a separate Models workspace continues to use only the authenticated model-manager proxy. The Go manager records verified downloads, serves authoritative complete YAML, never activates after download, and always starts from current Home Assistant options. RemindMe obtains model identity from manager runtime status.

**Tech Stack:** Node.js 22, TypeScript, Express, Alpine.js, Node test runner, Go 1.24, llama.cpp, Home Assistant add-on YAML, pnpm, Docker ARM64.

## Global Constraints

- No harness route may call Supervisor settings or restart APIs.
- Downloads must not start, activate, stop, or restart llama-server.
- Complete YAML is available only after a verified download and never contains stored credentials.
- `model_path` must resolve beneath `/data/models`.
- Current `/data/options.json` overrides persisted active/fallback state on every add-on start.
- Missing or invalid configured models must fail clearly without silently starting an older model.
- RemindMe attribution must reflect manager/runtime state, not `LOCAL_LLM_MODEL`.
- Use pnpm where a package-manager command is needed.
- Implement every behavior test-first and commit each task independently.

---

### Task 1: Remove Supervisor-backed Settings

**Files:**

- Modify: `discord-pi-bot/public/harness.html`
- Modify: `discord-pi-bot/public/app.js`
- Modify: `discord-pi-bot/src/harness-server.ts`
- Delete: `discord-pi-bot/src/harness/addonSettings.ts`
- Delete: `discord-pi-bot/src/harness/supervisorSettings.ts`
- Delete: `discord-pi-bot/src/harness/restart.ts`
- Replace: `discord-pi-bot/test/settings-sync-ui.test.mjs`
- Delete: `discord-pi-bot/test/settings-save-ui.test.mjs`
- Delete: `discord-pi-bot/test/settings-restart-ui.test.mjs`
- Delete: `discord-pi-bot/test/addon-settings.test.ts`
- Delete: `discord-pi-bot/test/supervisor-settings.test.ts`
- Delete: `discord-pi-bot/test/restart.test.ts`
- Modify: `discord-pi-bot/test/model-manager-routes.test.ts`

**Interfaces:**

- Produces: a Settings modal with `profile`, `glow`, and `scanlines` only.
- Removes: `GET /api/settings`, `POST /api/settings`, and `POST /api/settings/restart`.
- Preserves: Home Assistant Core API access through `hassRequest`; only Supervisor self-option and restart access disappear.

- [ ] **Step 1: Replace the settings UI test with a failing harness-only boundary test**

```js
test("settings contains only local harness preferences", () => {
  for (const field of ["profile", "glow", "scanlines"]) assert.match(html, new RegExp(field));
  for (const forbidden of ["discordToken", "localLlmUrl", "modelManagerUrl", "exaApiKey", "notifyTarget"])
    assert.doesNotMatch(html, new RegExp(forbidden));
  assert.doesNotMatch(app, /api\/settings|settingsRevision|saveSettings|restartSettingsAddon/);
});
```

Add a server assertion to `model-manager-routes.test.ts`:

```ts
for (const path of ["/api/settings", "/api/settings/restart"]) {
  const response = await nativeFetch(baseUrl + path, { method: path.endsWith("restart") ? "POST" : "GET" });
  assert.equal(response.status, 404);
}
```

- [ ] **Step 2: Run the focused tests and confirm they fail on mirrored controls/routes**

Run: `cd discord-pi-bot && node --test test/settings-sync-ui.test.mjs && node --import tsx --test test/model-manager-routes.test.ts`

Expected: FAIL because Supervisor fields and routes still exist.

- [ ] **Step 3: Remove Supervisor settings controls, state, imports, routes, and obsolete modules/tests**

Keep browser persistence for `profile`, `glow`, and `scanlines`; remove `applySettingsPayload`, `settingsChanges`, `saveSettings`, `restartSettingsAddon`, SupervisorSettingsClient construction, RestartController construction, `sendSettingsError`, and the three settings endpoints. Keep `SUPERVISOR_TOKEN` only for existing Home Assistant Core API calls.

- [ ] **Step 4: Run focused and TypeScript tests**

Run: `cd discord-pi-bot && node --test test/settings-sync-ui.test.mjs && node --import tsx --test test/model-manager-routes.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 5: Commit**

```bash
git add -A discord-pi-bot

git commit -m "refactor: limit settings to harness preferences"
```

---

### Task 2: Make Manager Downloads Verification-only

**Files:**

- Modify: `local-llama-cpp/manager/internal/api/server.go`
- Modify: `local-llama-cpp/manager/internal/api/server_test.go`
- Modify: `local-llama-cpp/manager/internal/state/store.go`
- Modify: `local-llama-cpp/manager/internal/state/store_test.go`

**Interfaces:**

- Produces: `POST /manager/v1/install` that ends in idle verified state without calling `Start`, `Activate`, or `Prune`.
- Produces: `state.State.CompleteDownload() State`, clearing `Operation` and `LastError` while retaining the current `Active` model.

- [ ] **Step 1: Add a failing API test proving a completed download does not activate**

```go
func TestInstallDownloadsWithoutChangingRuntime(t *testing.T) {
  dependencies := testDependencies(t, "http://127.0.0.1:1")
  supervisor := dependencies.Supervisor.(*fakeSupervisor)
  supervisor.active = "currently-running"
  server := NewServer(dependencies)
  request := authenticatedInstallRequest("test-q4")
  response := httptest.NewRecorder()
  server.ServeHTTP(response, request)
  waitForOperationToFinish(t, supervisor)
  if supervisor.ActiveID() != "currently-running" { t.Fatalf("active=%q", supervisor.ActiveID()) }
  if supervisor.startCalls != 0 || supervisor.activateCalls != 0 { t.Fatalf("runtime changed") }
}
```

Also add `TestCompleteDownloadPreservesActiveModel` in `state/store_test.go`.

- [ ] **Step 2: Run Go tests and confirm activation is observed**

Run: `cd local-llama-cpp/manager && go test ./internal/api ./internal/state`

Expected: FAIL because `runInstall` calls `Start` or `Activate`.

- [ ] **Step 3: Implement `CompleteDownload` and stop `runInstall` after verification**

```go
func (current State) CompleteDownload() State {
  current.Phase = PhaseIdle
  current.Operation = nil
  current.LastError = nil
  return current
}
```

After `Downloader.Download` returns, persist/publish `CompleteDownload`; do not construct `state.Installed` or invoke supervisor runtime methods.

- [ ] **Step 4: Run manager tests**

Run: `cd local-llama-cpp/manager && go test ./...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-llama-cpp/manager

git commit -m "refactor: download models without activation"
```

---

### Task 3: Record Verification and Generate Complete YAML

**Files:**

- Create: `local-llama-cpp/manager/internal/verified/store.go`
- Create: `local-llama-cpp/manager/internal/verified/store_test.go`
- Create: `local-llama-cpp/manager/internal/optionsyaml/options.go`
- Create: `local-llama-cpp/manager/internal/optionsyaml/options_test.go`
- Modify: `local-llama-cpp/manager/internal/api/server.go`
- Modify: `local-llama-cpp/manager/internal/api/server_test.go`
- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`

**Interfaces:**

- Produces: `verified.Store.Record(variant catalog.Variant, path string) error`, `Store.Has(variant catalog.Variant) bool`, and `Store.Remove(id string) error` backed by atomic owner-only JSON.
- Produces: `optionsyaml.Render(variant catalog.Variant, runtime hardware.Runtime, modelPath string) (string, error)`.
- Produces: authenticated `GET /manager/v1/models/{id}/options.yaml` returning `text/yaml; charset=utf-8` only for verified files.
- Extends catalog items with `verified: boolean`; keep private paths and checksums out of catalog JSON.

- [ ] **Step 1: Write failing verification-store tests**

Test atomic persistence, reload, model identity matching, removal, and rejection of paths outside the configured model directory.

- [ ] **Step 2: Write failing YAML renderer tests with the exact complete document**

```go
expected := `manager_token: ""
hf_repo: owner/repo
hf_file: test.gguf
hf_token: ""
model_path: /data/models/test.gguf
context_size: 4096
threads: 4
threads_batch: 4
batch_size: 128
ubatch_size: 64
cache_reuse: 256
jinja: true
kv_unified: true
flash_attention: false
reasoning_format: none
reasoning_mode: off
`
```

Assert traversal paths and newline-bearing values are rejected.

- [ ] **Step 3: Write failing API tests**

Assert 409 `model_not_verified` before a successful manager download; after download assert catalog `verified: true`, YAML content type, exact output, empty secret values, and no manager/Hugging Face secret leakage.

- [ ] **Step 4: Run focused Go tests and confirm missing packages/endpoints**

Run: `cd local-llama-cpp/manager && go test ./internal/verified ./internal/optionsyaml ./internal/api`

Expected: FAIL because the new interfaces do not exist.

- [ ] **Step 5: Implement verification persistence, renderer, dependency wiring, and endpoint**

Store verification metadata at `/data/model-manager/verified-models.json`. Record only after downloader checksum success and final-file promotion. Generate YAML from the catalog variant plus assessed runtime, using context from the assessment, `threads_batch = threads`, `cache_reuse = 256`, `jinja = true`, `kv_unified = true`, and `flash_attention = false`.

- [ ] **Step 6: Run Go tests**

Run: `cd local-llama-cpp/manager && go test ./...`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add local-llama-cpp/manager

git commit -m "feat: serve verified model configuration yaml"
```

---

### Task 4: Make Native Options Authoritative at Startup

**Files:**

- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`
- Expand: `local-llama-cpp/manager/cmd/model-manager/main_test.go`
- Modify: `local-llama-cpp/manager/internal/runtime/supervisor.go`
- Modify: `local-llama-cpp/manager/internal/runtime/supervisor_test.go`

**Interfaces:**

- Produces: `configuredModel(options addonOptions, modelDir string, catalog catalog.Catalog) (state.Installed, *catalog.Variant, error)` with canonical path confinement.
- Changes: `recoverOrBootstrap` reads current options before considering persisted state and never selects a persisted fallback.
- Preserves: repository/file fallback when `model_path` is empty for backward-compatible installs.

- [ ] **Step 1: Add failing startup-selection tests**

Cover: changed `model_path` wins over persisted active; path outside model directory fails; blank `model_path` resolves exact `hf_repo`/`hf_file`; missing configured file does not select persisted fallback; runtime arguments come from current options.

- [ ] **Step 2: Run focused tests and verify persisted state currently wins**

Run: `cd local-llama-cpp/manager && go test ./cmd/model-manager ./internal/runtime`

Expected: FAIL on options authority.

- [ ] **Step 3: Refactor startup around current options**

Read options first. For non-empty `model_path`, canonicalize and confine it to `configured.models`, require the file, and call `Start` with `runtimeFromOptions(options)`. For blank `model_path`, resolve the exact catalog variant, reuse/download its final file, then start it with current option values. Persisted state may report interrupted download recovery but may not choose an inference model.

- [ ] **Step 4: Run all manager tests**

Run: `cd local-llama-cpp/manager && go test ./...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-llama-cpp/manager

git commit -m "fix: make native llama options authoritative"
```

---

### Task 5: Use Runtime Model Discovery in RemindMe

**Files:**

- Modify: `discord-pi-bot/src/harness-server.ts`
- Modify: `discord-pi-bot/test/model-attribution.test.ts`
- Modify: `discord-pi-bot/test/model-manager-routes.test.ts`

**Interfaces:**

- Produces: `activeModelMetadata(): Promise<ActiveModelMetadata>` whose unavailable value is `{ modelId: "runtime-unavailable", modelName: "Runtime unavailable" }`.
- Consumes: manager `/status.activeModel` as the only proof of the running model.

- [ ] **Step 1: Add failing tests for manager-driven identity and unavailable fallback**

Assert configured `LOCAL_LLM_MODEL` is not emitted when manager status has no active model or cannot be reached. Assert a real `activeModel` controls model ID/name and attribution.

- [ ] **Step 2: Run focused tests and confirm stale configured fallback**

Run: `cd discord-pi-bot && node --import tsx --test test/model-attribution.test.ts test/model-manager-routes.test.ts`

Expected: FAIL because `activeModelMetadata` falls back to `LOCAL_LLM_MODEL`.

- [ ] **Step 3: Replace configured fallback with explicit unavailable metadata**

```ts
return active
  ? { modelId: active.id, modelName: `${active.family} ${active.quantization}`.trim() }
  : { modelId: "runtime-unavailable", modelName: "Runtime unavailable" };
```

- [ ] **Step 4: Run focused tests and TypeScript**

Run: `cd discord-pi-bot && node --import tsx --test test/model-attribution.test.ts test/model-manager-routes.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add discord-pi-bot/src/harness-server.ts discord-pi-bot/test/model-attribution.test.ts discord-pi-bot/test/model-manager-routes.test.ts

git commit -m "fix: discover active model from runtime"
```

---

### Task 6: Build the Dedicated Model Workbench

**Files:**

- Modify: `discord-pi-bot/public/harness.html`
- Modify: `discord-pi-bot/public/app.js`
- Modify: `discord-pi-bot/public/components/model-cookbook.js`
- Modify: `discord-pi-bot/public/styles.css`
- Modify: `discord-pi-bot/src/harness-server.ts`
- Modify: `discord-pi-bot/src/harness/modelManager.ts`
- Modify: `discord-pi-bot/test/model-cookbook-markup.test.mjs`
- Create: `discord-pi-bot/test/model-yaml-ui.test.mjs`
- Modify: `discord-pi-bot/test/model-manager-routes.test.ts`

**Interfaces:**

- Produces: top-level `modelsOpen` workspace independent of `settingsOpen`.
- Produces: RemindMe proxy `GET /api/models/:id/options.yaml` that preserves text/YAML without parsing it as JSON.
- Produces browser methods `download(vm,id)`, `loadYaml(vm,id)`, `copyYaml(vm,id)`, and `downloadYaml(vm,id)`.
- Removes browser `activate(vm,id)` and all Activate controls.

- [ ] **Step 1: Write failing markup/UI tests**

Assert top-level Models button and workspace, Settings contains only harness controls, card labels Available/Downloading/Verified/Running, Download action, copy/download YAML actions gated by `variant.verified`, no Activate text/calls, manual Configuration/restart instructions, clipboard rejection handling, and Blob/object-URL YAML download.

- [ ] **Step 2: Add a failing proxy test for byte-identical YAML**

Stub upstream `text/yaml` and assert `/api/models/test-q4/options.yaml` returns the same bytes, content type, safe `Content-Disposition`, and no manager token.

- [ ] **Step 3: Run focused UI/server tests and confirm failures**

Run: `cd discord-pi-bot && node --test test/model-cookbook-markup.test.mjs test/model-yaml-ui.test.mjs && node --import tsx --test test/model-manager-routes.test.ts`

Expected: FAIL because models are nested under Settings and activation/YAML behavior is absent.

- [ ] **Step 4: Implement text proxy and browser YAML workflow**

Add `ModelManagerClient.requestText(path)` returning `{ body: string; contentType: string }` while retaining bearer auth and safe errors. Validate model IDs before proxying YAML. Store only the currently viewed YAML in memory; never localStorage. Use `navigator.clipboard.writeText`; on failure set guidance while leaving Download YAML enabled.

- [ ] **Step 5: Move cookbook into a dedicated responsive workspace and update styling**

Keep the existing Lucky 38 terminal visual system. Add a top-level Models button beside Settings, a full-width workbench overlay/panel, a quiet YAML preview with utility monospace typography, visible focus states, mobile single-column cards, and no model controls in Settings.

- [ ] **Step 6: Run focused UI, server, and type tests**

Run: `cd discord-pi-bot && node --test test/model-cookbook-markup.test.mjs test/model-yaml-ui.test.mjs && node --import tsx --test test/model-manager-routes.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot

git commit -m "feat: add manual model configuration workbench"
```

---

### Task 7: Release Documentation and Full Verification

**Files:**

- Modify: `discord-pi-bot/config.yaml`
- Modify: `discord-pi-bot/README.md`
- Modify: `local-llama-cpp/config.yaml`
- Modify: `local-llama-cpp/README.md`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**

- Produces: RemindMe version `2.3.4` and local llama.cpp version `1.10.0`.
- Documents: no Supervisor settings mirroring; download-only workflow; complete YAML copy; manual llama.cpp restart; options authority; runtime discovery; upgrade compatibility.

- [ ] **Step 1: Update packaging tests first**

Assert exact versions, absence of Supervisor settings/restart route strings, presence of Download/Copy YAML/manual restart documentation, and `model_path`-authoritative startup language.

- [ ] **Step 2: Run package tests and confirm old versions/docs fail**

Run: `node --test test/local-model-addon.test.mjs`

Expected: FAIL on versions and missing manual workflow text.

- [ ] **Step 3: Update versions and operator documentation**

Explain that existing blank-`model_path` repository options remain backward compatible, but newly copied complete YAML uses the verified local path. State that downloads do not change the running model and native llama.cpp Configuration is authoritative.

- [ ] **Step 4: Run all project verification**

```bash
cd discord-pi-bot
node --import tsx --test test/*.test.ts
node --test test/*.test.mjs
pnpm exec tsc -p tsconfig.json --noEmit
node --check public/app.js
node --check public/components/model-cookbook.js
cd ../local-llama-cpp/manager
go test ./...
go vet ./...
cd ../..
node --test test/*.test.mjs
sh -n discord-pi-bot/run.sh
sh -n local-llama-cpp/run.sh
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Build ARM64 add-on images and scan for secrets**

```bash
docker build --platform linux/arm64 -t remindme-discord-bot:2.3.4 discord-pi-bot
docker build --platform linux/arm64 -t remindme-local-llama:1.10.0 local-llama-cpp
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" zricethezav/gitleaks:latest detect --source=/repo --no-git --redact --no-banner
```

Expected: both builds succeed and gitleaks reports no leaks.

- [ ] **Step 6: Commit and push the feature branch**

```bash
git add discord-pi-bot local-llama-cpp test/local-model-addon.test.mjs docs/superpowers/plans/2026-07-18-manual-llama-model-workbench.md

git commit -m "feat: release manual llama model workbench"
git push -u origin feat/manual-llama-model-workbench
```
