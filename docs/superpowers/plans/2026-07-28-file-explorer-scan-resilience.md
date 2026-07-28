# File Explorer Scan Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent active Config and SSHFS files disappearing during traversal from aborting storage scans, while preserving explicit fatal connection errors.

**Architecture:** Classify filesystem errors at the scanner boundary. Recoverable disappearance errors become bounded root-relative warnings; permission/unsupported entries remain incomplete; transport disconnection becomes a typed fatal error that the job service logs and exposes safely.

**Tech Stack:** Node.js 22, TypeScript 5.9, Vitest 3.

## Global Constraints

- Never follow symlinks.
- Never return absolute container paths.
- `ENOENT` and `ESTALE` continue scanning as `ENTRY_DISAPPEARED`.
- `ENTRY_DISAPPEARED` alone does not mark totals incomplete.
- `ENOTCONN` becomes `HOST_CONNECTION_LOST` and fails the job.
- Browser errors contain no raw stderr, paths, keys, or passphrases.

---

### Task 1: Classify disappearing and disconnected entries

**Files:**
- Modify: `file-explorer/src/storageTypes.ts`
- Modify: `file-explorer/src/storageScanner.ts`
- Modify: `file-explorer/src/errors.ts`
- Test: `file-explorer/test/storageScanner.test.ts`

**Interfaces:**
- Extends: `StorageWarningCode` with `ENTRY_DISAPPEARED`
- Produces: `StorageScanFatalError` with safe code `HOST_CONNECTION_LOST`

- [ ] **Step 1: Write failing scanner regressions**

Add fake-filesystem tests:

```ts
it.each(["ENOENT", "ESTALE"])("continues when an entry disappears with %s", async (code) => {
  const scanTarget = await target();
  const fs: StorageFs = {
    async readdir() { return [{ name: "gone" }, { name: "kept.txt" }]; },
    async lstat(targetPath) {
      if (targetPath.endsWith("gone")) throw Object.assign(new Error("gone"), { code });
      return fakeStats("file", 7);
    },
  };
  const result = await new StorageScanner(fs).scan(scanTarget, limits, new AbortController().signal);
  expect(result.root.size).toBe(7);
  expect(result.warnings).toContainEqual({ code: "ENTRY_DISAPPEARED", path: "gone" });
  expect(result.stopReason).toBeNull();
});

it("raises a safe typed error when SSHFS disconnects", async () => {
  const scanTarget = await target();
  const fs: StorageFs = {
    async readdir() { throw Object.assign(new Error("transport details"), { code: "ENOTCONN" }); },
    async lstat() { return fakeStats("file", 1); },
  };
  await expect(new StorageScanner(fs).scan(scanTarget, limits, new AbortController().signal))
    .rejects.toMatchObject({ code: "HOST_CONNECTION_LOST", message: "Host connection lost" });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/storageScanner.test.ts`

Expected: disappearance tests reject and disconnect lacks the safe typed code.

- [ ] **Step 3: Implement error classification**

Add `ENTRY_DISAPPEARED` to warnings and add:

```ts
export class StorageScanFatalError extends Error {
  constructor(public readonly code: "HOST_CONNECTION_LOST") {
    super("Host connection lost");
    this.name = "StorageScanFatalError";
  }
}
```

Replace permission-only catches with a classifier:

```ts
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function recoverableWarning(error: unknown, relativePath: string): StorageWarning | null {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ESTALE") return { code: "ENTRY_DISAPPEARED", path: relativePath };
  if (code === "EACCES" || code === "EPERM") return { code: "PERMISSION_DENIED", path: relativePath };
  if (code === "ENOTCONN") throw new StorageScanFatalError("HOST_CONNECTION_LOST");
  return null;
}
```

Use it for both `readdir` and `lstat`; continue only when it returns a warning.

- [ ] **Step 4: Verify GREEN**

Run:

```sh
pnpm vitest run test/storageScanner.test.ts test/storageProjection.test.ts
pnpm lint
```

Expected: all focused tests pass and disappearing warnings do not make projection incomplete.

- [ ] **Step 5: Commit**

```sh
git add file-explorer/src/storageTypes.ts file-explorer/src/storageScanner.ts file-explorer/src/errors.ts file-explorer/test/storageScanner.test.ts
git commit -m "fix(file-explorer): tolerate disappearing scan entries"
```

---

### Task 2: Preserve safe failure diagnostics

**Files:**
- Modify: `file-explorer/src/storageScanService.ts`
- Modify: `file-explorer/src/storageTypes.ts`
- Test: `file-explorer/test/storageScanService.test.ts`
- Test: `file-explorer/test/storageMapRoutes.test.ts`

**Interfaces:**
- Adds: `StorageScanService` logger dependency
- Produces browser-safe error code `HOST_CONNECTION_LOST`

- [ ] **Step 1: Write failing service and route tests**

Inject a logger and scanner rejection:

```ts
const logger = { error: vi.fn() };
const scanner = { scan: vi.fn().mockRejectedValue(new StorageScanFatalError("HOST_CONNECTION_LOST")) };
const service = new StorageScanService(policy(), scanner, limits, { idFactory: ids(), logger });
const started = await service.start("config", false);
await vi.waitFor(() => expect(service.snapshot(started.id).status).toBe("failed"));
expect(service.snapshot(started.id).error).toEqual({ code: "HOST_CONNECTION_LOST", message: "Host connection lost" });
expect(logger.error).toHaveBeenCalledWith("Storage scan failed", {
  scanId: started.id,
  root: "config",
  code: "HOST_CONNECTION_LOST",
});
expect(JSON.stringify(logger.error.mock.calls)).not.toContain("transport details");
```

Add a route assertion for the same safe snapshot.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/storageScanService.test.ts test/storageMapRoutes.test.ts`

Expected: service returns generic `SCAN_FAILED` and does not invoke the logger.

- [ ] **Step 3: Implement typed safe logging**

Add `logger?: Pick<Console, "error">` to service options, default to `console`. In the rejection handler, recognize `StorageScanFatalError`; otherwise use `SCAN_FAILED`. Log only `{ scanId, root, code }` and set the safe snapshot error.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm vitest run test/storageScanService.test.ts test/storageMapRoutes.test.ts
pnpm test
pnpm lint
```

Then:

```sh
git add file-explorer/src/storageScanService.ts file-explorer/src/storageTypes.ts file-explorer/test/storageScanService.test.ts file-explorer/test/storageMapRoutes.test.ts
git commit -m "fix(file-explorer): expose safe scan failures"
```
