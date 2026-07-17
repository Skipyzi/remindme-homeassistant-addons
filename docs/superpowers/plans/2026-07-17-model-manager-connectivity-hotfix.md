# Model Manager Connectivity Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair RemindMe self-option saves, migrate invalid cross-container loopback URLs, and make unknown llama.cpp bootstrap model diagnostics actionable without replacing user configuration.

**Architecture:** Add a focused TypeScript endpoint canonicalizer at the settings boundary, keep the manager client strict, and retain shell-level normalization as defense in depth. Remove the unauthorized Supervisor preflight request and rely on Supervisor's atomic self-options write validation. Extract a small Go diagnostic formatter for unknown bootstrap tuples while leaving the manager HTTP lifecycle unchanged.

**Tech Stack:** TypeScript 7, Node.js 22, Express 5, POSIX shell, Go 1.24, Home Assistant Supervisor API, Node test runner.

## Global Constraints

- Use TDD and `pnpm` where package commands are needed.
- RemindMe must not receive Supervisor `manager` or `admin` privileges.
- Supervisor-rendered options remain the canonical RemindMe configuration source.
- Preserve complete option maps, unknown fields, and configured secrets.
- Never expose Supervisor, model-manager, pairing, Discord, Exa, or Hugging Face credentials.
- Preserve unknown model selections; never silently bootstrap a fallback.
- Canonical inference endpoint: `http://homeassistant:8080/v1/chat/completions`.
- Canonical manager endpoint: `http://homeassistant:8080/manager/v1`.
- Release RemindMe as `2.3.1` and managed llama.cpp as `1.9.1`.

---

### Task 1: Supervisor Self-Option Write

**Files:**

- Modify: `discord-pi-bot/src/harness/supervisorSettings.ts`
- Modify: `discord-pi-bot/test/supervisor-settings.test.ts`

**Interfaces:**

- Consumes: `applySettingsPatch(current, changes)` and `normalizeAddonOptions(options)`.
- Produces: `SupervisorSettingsClient.save(revision, changes)` using only `GET /addons/self/options/config` and `POST /addons/self/options`.

- [ ] **Step 1: Rewrite the happy-path test to reject preflight access**

Update the save test so the fetch stub throws if `/options/validate` is called and expects this sequence:

```ts
[
  "GET /options/config",
  "POST /options",
  "GET /options/config",
]
```

Read the posted payload from `calls[1].body` and continue asserting preservation of `future_option` and both secrets.

- [ ] **Step 2: Add a failing write-time validation test**

Return a Supervisor error envelope with HTTP 400 from `POST /options`:

```ts
Response.json(
  {
    result: "error",
    message: "Invalid list for option 'local_llm_context_size'",
  },
  { status: 400 },
)
```

Assert `SupervisorSettingsError` has code `configuration_invalid`, status `422`, and a safe message containing `local_llm_context_size`. Assert exactly one write attempt and no `/options/validate` request.

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```bash
cd discord-pi-bot
node --import tsx --test test/supervisor-settings.test.ts
```

Expected: FAIL because save still calls the forbidden validation endpoint and maps write errors to `502`.

- [ ] **Step 4: Remove the forbidden preflight and classify write errors**

In `SupervisorSettingsClient.request`, allow an optional error classification for the self-options write. When `POST /addons/self/options` returns HTTP 400, throw:

```ts
new SupervisorSettingsError(
  "configuration_invalid",
  safeSupervisorMessage(body) || "Supervisor rejected the add-on configuration.",
  422,
)
```

For all other non-success responses retain `supervisor_unavailable`. In `save`, delete the `/addons/self/options/validate` request and send the locally validated complete map directly to `/addons/self/options`.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run the focused command from Step 3.

Expected: all Supervisor settings tests pass and no call targets `/options/validate`.

- [ ] **Step 6: Commit**

```bash
git add discord-pi-bot/src/harness/supervisorSettings.ts discord-pi-bot/test/supervisor-settings.test.ts
git commit -m "fix: save self options without privileged validation"
```

---

### Task 2: Canonical Cross-Add-on URLs

**Files:**

- Create: `discord-pi-bot/src/harness/localEndpoints.ts`
- Create: `discord-pi-bot/test/local-endpoints.test.ts`
- Modify: `discord-pi-bot/src/harness/addonSettings.ts`
- Modify: `discord-pi-bot/src/harness/modelManager.ts`
- Modify: `discord-pi-bot/test/addon-settings.test.ts`
- Modify: `discord-pi-bot/test/model-manager.test.ts`
- Modify: `discord-pi-bot/run.sh`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**

- Produces: `canonicalLocalEndpoint(value: string, kind: "inference" | "manager", allowLegacyLoopback?: boolean): string`.
- Canonical results are the exact endpoints in Global Constraints.
- `normalizeAddonOptions` returns a cloned complete option map with canonical endpoint fields.

- [ ] **Step 1: Add failing canonicalizer tests**

Cover canonical input, `localhost`, and `127.0.0.1` for both endpoint kinds. Assert rejection of HTTPS, external hosts, port 8090, URL credentials, query strings, fragments, and wrong paths. Assert strict mode rejects loopback:

```ts
assert.equal(
  canonicalLocalEndpoint("http://127.0.0.1:8080/manager/v1", "manager", true),
  "http://homeassistant:8080/manager/v1",
);
assert.throws(() =>
  canonicalLocalEndpoint("http://127.0.0.1:8080/manager/v1", "manager"),
);
```

- [ ] **Step 2: Add failing settings migration tests**

Pass complete options containing both loopback URLs to `normalizeAddonOptions`. Assert the returned object uses canonical values, the input object is unchanged, unknown fields remain, and `publicAddonSettings` exposes canonical URLs. Patch loopback URLs and assert `applySettingsPatch` returns canonical values.

- [ ] **Step 3: Add failing strict manager derivation test**

Change `deriveManagerUrl` expectations so `homeassistant` succeeds and `localhost`/`127.0.0.1` throw.

- [ ] **Step 4: Add failing shell regression assertions**

In `test/local-model-addon.test.mjs`, assert `discord-pi-bot/run.sh` normalizes both `LOCAL_LLM_URL` and `MODEL_MANAGER_URL` loopback values to the exact canonical endpoints.

- [ ] **Step 5: Run focused tests to verify RED**

Run:

```bash
cd discord-pi-bot
node --import tsx --test test/local-endpoints.test.ts test/addon-settings.test.ts test/model-manager.test.ts
cd ..
node --test test/local-model-addon.test.mjs
```

Expected: FAIL because the canonicalizer does not exist, manager derivation still accepts loopback, and the shell script does not normalize manager URLs.

- [ ] **Step 6: Implement the canonicalizer**

Create `localEndpoints.ts` with constants for the two canonical URLs. Parse with `new URL`, reject username/password/search/hash, require HTTP and explicit/effective port 8080, require the exact path for the requested kind, and accept only `homeassistant` plus loopback when `allowLegacyLoopback` is true. Return the canonical constant rather than mutating the parsed URL.

- [ ] **Step 7: Integrate canonicalization into settings and manager client**

In `normalizeAddonOptions`, clone the source map and canonicalize both endpoint fields with migration enabled before returning. In `applySettingsPatch`, run the merged complete map through `normalizeAddonOptions`. In `deriveManagerUrl`, call strict canonicalization for the completion endpoint and return the manager constant.

- [ ] **Step 8: Add startup defense in depth**

In `discord-pi-bot/run.sh`, normalize both exported variables:

```sh
case "$LOCAL_LLM_URL" in
"http://127.0.0.1:8080/v1/chat/completions" | "http://localhost:8080/v1/chat/completions")
  LOCAL_LLM_URL="http://homeassistant:8080/v1/chat/completions" ;;
esac

MODEL_MANAGER_URL="$(get_option model_manager_url)"
case "$MODEL_MANAGER_URL" in
"http://127.0.0.1:8080/manager/v1" | "http://localhost:8080/manager/v1")
  MODEL_MANAGER_URL="http://homeassistant:8080/manager/v1" ;;
esac
export MODEL_MANAGER_URL
```

Do not rewrite arbitrary hosts or paths.

- [ ] **Step 9: Run focused tests to verify GREEN**

Run the commands from Step 5 plus:

```bash
sh -n discord-pi-bot/run.sh
```

Expected: all focused tests pass and shell syntax is valid.

- [ ] **Step 10: Commit**

```bash
git add discord-pi-bot/src/harness/localEndpoints.ts discord-pi-bot/src/harness/addonSettings.ts discord-pi-bot/src/harness/modelManager.ts discord-pi-bot/run.sh discord-pi-bot/test/local-endpoints.test.ts discord-pi-bot/test/addon-settings.test.ts discord-pi-bot/test/model-manager.test.ts test/local-model-addon.test.mjs
git commit -m "fix: canonicalize local add-on endpoints"
```

---

### Task 3: Actionable Unknown-Model Diagnostics

**Files:**

- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`
- Create: `local-llama-cpp/manager/cmd/model-manager/main_test.go`

**Interfaces:**

- Produces: `unknownVariantDiagnostic(options addonOptions) string`.
- Consumes only non-secret `HFRepo` and `HFFile`; it must never format `HFToken`.

- [ ] **Step 1: Add a failing diagnostic unit test**

Construct options containing a custom repo, file, and sentinel token. Assert the result contains the custom repo/file, both curated recovery values, and Hardware Cookbook guidance, but does not contain the sentinel token.

- [ ] **Step 2: Run the Go test to verify RED**

Run:

```bash
cd local-llama-cpp/manager
go test ./cmd/model-manager
```

Expected: build failure because `unknownVariantDiagnostic` does not exist.

- [ ] **Step 3: Implement and use the diagnostic formatter**

Add a formatter using `fmt.Sprintf` with the configured repo/file and exact curated recovery tuple. Replace the generic unknown-catalog log with:

```go
log.Printf("startup degraded: %s", unknownVariantDiagnostic(options))
```

Do not change the return path or choose a fallback variant.

- [ ] **Step 4: Run focused and full Go tests**

Run:

```bash
go test ./cmd/model-manager
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/remindme-model-manager ./cmd/model-manager
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit**

```bash
git add local-llama-cpp/manager/cmd/model-manager/main.go local-llama-cpp/manager/cmd/model-manager/main_test.go
git commit -m "fix: explain unknown bootstrap models"
```

---

### Task 4: Patch Release and Complete Verification

**Files:**

- Modify: `discord-pi-bot/config.yaml`
- Modify: `discord-pi-bot/README.md`
- Modify: `local-llama-cpp/config.yaml`
- Modify: `local-llama-cpp/README.md`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**

- Releases RemindMe `2.3.1` and managed llama.cpp `1.9.1`.

- [ ] **Step 1: Add failing version and documentation assertions**

Assert exact patch versions and documentation covering canonical `homeassistant:8080` URLs, automatic loopback migration, native Configuration-tab recovery for older builds, and unknown-model preservation.

- [ ] **Step 2: Run packaging tests to verify RED**

Run:

```bash
node --test test/local-model-addon.test.mjs
```

Expected: FAIL on old versions or missing release guidance.

- [ ] **Step 3: Update versions and operator documentation**

Bump the two config versions. Document that 2.3.1 no longer calls privileged `/options/validate`, migrates loopback endpoints, and requires an explicit restart. Document that 1.9.1 preserves unknown model options while keeping pairing/catalog APIs available.

- [ ] **Step 4: Run complete code gates**

Run:

```bash
cd discord-pi-bot
node --import tsx --test test/*.test.ts
node --test test/*.test.mjs
../../../node_modules/.bin/tsc -p tsconfig.json --noEmit
node --check public/app.js
node --check public/components/model-cookbook.js
cd ../local-llama-cpp/manager
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/remindme-model-manager ./cmd/model-manager
cd ../../
node --test test/*.test.mjs
sh -n local-llama-cpp/run.sh
sh -n discord-pi-bot/run.sh
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 5: Build ARM64 images**

Run:

```bash
docker build --platform linux/arm64 -t remindme-local-llama:1.9.1 local-llama-cpp
docker build --platform linux/arm64 -t remindme-discord-bot:2.3.1 discord-pi-bot
```

Expected: both images build successfully.

- [ ] **Step 6: Scan for secrets**

Run gitleaks with redaction against the repository and require zero findings.

- [ ] **Step 7: Commit and push the feature branch**

```bash
git add discord-pi-bot local-llama-cpp test
git commit -m "fix: release model manager connectivity hotfix"
git push -u origin fix/model-manager-connectivity
```

- [ ] **Step 8: Confirm clean synchronized branch**

```bash
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/fix/model-manager-connectivity)"
```

Expected: no status output and equal revisions.
