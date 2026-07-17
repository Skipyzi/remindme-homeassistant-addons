# llama-server Readiness Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent transient connection-refused failures by retrying llama-server readiness probes until success, process exit, or timeout.

**Architecture:** Extend runtime supervisor configuration with bounded readiness timing, retry the existing deterministic probe without changing activation semantics, and expose race-safe non-consuming process exit state. Production defaults remain 120 seconds and 500 milliseconds; tests inject short durations.

**Tech Stack:** Go 1.24, `os/exec`, `sync/atomic`, Home Assistant ARM64 add-on packaging.

## Global Constraints

- Internal llama target remains `http://127.0.0.1:8081`.
- Require both health and completion probes before activation succeeds.
- Preserve rollback and persisted-state behavior.
- Do not expose model paths, signed URLs, or credentials in new diagnostics.
- Release managed llama.cpp as `1.9.2`; RemindMe remains `2.3.1`.

---

### Task 1: Retry Readiness Until Success, Exit, or Timeout

**Files:**

- Modify: `local-llama-cpp/manager/internal/runtime/supervisor.go`
- Modify: `local-llama-cpp/manager/internal/runtime/supervisor_test.go`

**Interfaces:**

- Add optional `ProcessStatus` interface with `Exited() bool`.
- Add `Config.ReadinessTimeout time.Duration` and `Config.ProbeInterval time.Duration` with production defaults.
- Change `probeWithTimeout(ctx, process)` to retry the existing `Probe`.

- [ ] **Step 1: Add failing delayed-readiness test**

Create a probe that returns `connection refused` twice and then succeeds. Start a model with test timing of 100 ms timeout and 1 ms interval. Assert start succeeds and exactly three attempts occur.

- [ ] **Step 2: Add failing timeout and early-exit tests**

Use a permanently failing probe with 5 ms timeout and 1 ms interval; assert the returned error contains both `readiness timeout` and the last probe error. Extend `fakeProcess` with an exit flag and `Exited`; assert an exited process returns `llama server exited before readiness` before exhausting the timeout.

Update `newTestSupervisor` to set a 10 ms readiness timeout and 1 ms retry interval so existing permanent-failure rollback tests remain fast.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
cd local-llama-cpp/manager
go test ./internal/runtime
```

Expected: FAIL because readiness timing fields, retry behavior, and process status do not exist.

- [ ] **Step 4: Implement timing defaults and retry loop**

In `NewSupervisor`, default zero values to 120 seconds and 500 milliseconds. Store them in the existing config. Implement `probeWithTimeout(ctx, process)` to:

1. Create the bounded child context.
2. Probe immediately.
3. Return on success.
4. Record the last error.
5. Return early if `process.(ProcessStatus).Exited()` is true.
6. Wait for interval or context cancellation.
7. On deadline, return `readiness timeout: <last error>`.

Pass the launched process at every startup, candidate, and rollback call site.

- [ ] **Step 5: Implement race-safe command process status**

Add `exited atomic.Bool` to `commandProcess`. In the existing wait goroutine, store true after `command.Wait()` returns and before sending its result to `done`. Implement `Exited() bool` as `return process.exited.Load()` without consuming `done`.

- [ ] **Step 6: Run focused and full Go verification**

```bash
go test ./internal/runtime
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/remindme-model-manager ./cmd/model-manager
```

Expected: all commands exit zero.

- [ ] **Step 7: Commit**

```bash
git add local-llama-cpp/manager/internal/runtime/supervisor.go local-llama-cpp/manager/internal/runtime/supervisor_test.go
git commit -m "fix: wait for llama server readiness"
```

---

### Task 2: Package and Verify llama.cpp 1.9.2

**Files:**

- Modify: `local-llama-cpp/config.yaml`
- Modify: `local-llama-cpp/README.md`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**

- Release managed llama.cpp `1.9.2`.

- [ ] **Step 1: Add failing packaging assertions**

Update the expected llama.cpp version to `1.9.2`. Assert the README describes delayed readiness retry, the 120-second bound, and internal port `8081`.

- [ ] **Step 2: Run packaging test to verify RED**

```bash
node --test test/local-model-addon.test.mjs
```

Expected: FAIL on version or missing readiness documentation.

- [ ] **Step 3: Update package and documentation**

Bump `local-llama-cpp/config.yaml` to `1.9.2`. Document that startup retries transient health/completion failures for up to 120 seconds and that `127.0.0.1:8081` is intentionally internal to the add-on container.

- [ ] **Step 4: Run complete release gates**

```bash
cd local-llama-cpp/manager
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/remindme-model-manager ./cmd/model-manager
cd ../../
node --test test/*.test.mjs
sh -n local-llama-cpp/run.sh
git diff --check
docker build --platform linux/arm64 -t remindme-local-llama:1.9.2 local-llama-cpp
```

Expected: every command exits zero and the ARM64 image builds.

- [ ] **Step 5: Run redacted secret scan**

Run gitleaks against the repository and require zero findings.

- [ ] **Step 6: Commit and push**

```bash
git add local-llama-cpp test
git commit -m "fix: release llama readiness retry"
git push -u origin fix/llama-readiness-retry
```

- [ ] **Step 7: Confirm clean synchronized branch**

```bash
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/fix/llama-readiness-retry)"
```

Expected: clean status and equal revisions.
