# File Explorer Storage Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe parent navigation and an on-demand, cached, WinDirStat-style storage treemap for the currently selected File Explorer root.

**Architecture:** A bounded server-side scanner builds root-relative size trees without following symlinks. A job service deduplicates scans, tracks progress, caches results, and projects bounded views through opaque job APIs; a dependency-free browser module renders those views as a full-screen hierarchical treemap and opens real entries through the existing explorer.

**Tech Stack:** Node.js 22, TypeScript 5.9, Express 5, browser-native ES modules, CSS, Vitest 3, Supertest 7, jsdom 26, pnpm 11.

## Global Constraints

- Scan only enabled `config`, `share`, and `media` roots; never scan the Home Assistant host root or arbitrary paths.
- Use root-relative paths in responses and never expose absolute container or host paths.
- Use `lstat` and never follow symbolic links.
- Default limits are exactly 200,000 entries, 120 seconds, 60 seconds of cache lifetime, and 5,000 projected nodes.
- Run at most one physical scan for a root/cache generation and use bounded/sequential directory traversal.
- Preserve exact visible byte totals when tiny files are aggregated by containing directory and extension.
- Do not add direct permanent deletion to the treemap; real files open through existing editor/preview behavior.
- Preserve existing browse, search, mutation, backup, trash, ingress, and path-policy behavior.
- Keep the implementation dependency-free in the browser and compatible with all configured add-on architectures.
- Release File Explorer as `0.2.0`.
- PR #29 contains the required pnpm 11 build-policy fix. Rebase this branch onto `main` after PR #29 merges rather than duplicating or reverting that fix.

---

## File structure

### New server modules

- `file-explorer/src/storageTypes.ts` — internal scan, progress, warning, job, and public result contracts.
- `file-explorer/src/storageScanner.ts` — bounded symlink-safe traversal and aggregate-size calculation.
- `file-explorer/src/storageProjection.ts` — extension categorization and deterministic node-budget compaction.
- `file-explorer/src/storageScanService.ts` — jobs, cancellation, deduplication, cache generation, expiry, and invalidation.
- `file-explorer/src/routes/storageMap.ts` — start, status, result, and cancel HTTP routes.

### New browser modules

- `file-explorer/public/treemap.js` — deterministic squarified rectangle layout with no DOM dependency.
- `file-explorer/public/storage-map.js` — API client, polling state, focus-view rendering, drill-down, details, and keyboard interaction.

### New tests

- `file-explorer/test/config.test.ts`
- `file-explorer/test/storageScanner.test.ts`
- `file-explorer/test/storageProjection.test.ts`
- `file-explorer/test/storageScanService.test.ts`
- `file-explorer/test/storageMapRoutes.test.ts`
- `file-explorer/test/treemap.test.mjs`
- `file-explorer/test/storage-map-ui.test.mjs`

### Existing files to modify

- `file-explorer/src/types.ts` — storage scan limits in `ExplorerConfig`.
- `file-explorer/src/config.ts` — parse and clamp storage options.
- `file-explorer/src/server.ts` — construct/register scan service.
- `file-explorer/src/routes/files.ts` — invalidate cache after successful mutations.
- `file-explorer/src/routes/trash.ts` — invalidate cache after trash/restore.
- `file-explorer/test/fixtures.ts` — storage defaults and reusable context builder data.
- `file-explorer/test/mutations.test.ts` — mutation invalidation assertions.
- `file-explorer/public/tree.js` — parent and breadcrumb helpers.
- `file-explorer/public/operations.js` — storage-map API methods and mutation callback.
- `file-explorer/public/index.html` — navigation controls, Storage map action, focus-view mount.
- `file-explorer/public/app.js` — breadcrumb navigation and storage-map integration.
- `file-explorer/public/styles.css` — navigation and responsive focus-view styling.
- `file-explorer/test/ui.test.ts` — navigation helper and operation tests.
- `file-explorer/test/server.test.ts` — shell markup assertions.
- `file-explorer/config.yaml` — version and validated options.
- `file-explorer/README.md` — behavior, options, limits, and verification.

---

### Task 1: Repair parent and root navigation

**Files:**
- Modify: `file-explorer/public/tree.js`
- Modify: `file-explorer/public/index.html`
- Modify: `file-explorer/public/app.js`
- Modify: `file-explorer/public/styles.css`
- Test: `file-explorer/test/ui.test.ts`
- Test: `file-explorer/test/server.test.ts`

**Interfaces:**
- Produces: `parentPath(relativePath: string): string`
- Produces: `breadcrumbSegments(relativePath: string): Array<{ label: string; path: string }>`
- Produces DOM hooks: `[data-up]`, `[data-root-path]`, and `[data-breadcrumbs]`

- [ ] **Step 1: Write failing navigation-helper tests**

Add imports and these assertions to `test/ui.test.ts`:

```ts
import {
  breadcrumbSegments,
  createExplorerState,
  nextTreeIndex,
  parentPath,
} from "../public/tree.js";

it("builds safe parent paths and clickable breadcrumbs", () => {
  expect(parentPath("")).toBe("");
  expect(parentPath("media")).toBe("");
  expect(parentPath("media/photos/2026")).toBe("media/photos");
  expect(breadcrumbSegments("media/photos")).toEqual([
    { label: "Root", path: "" },
    { label: "media", path: "media" },
    { label: "photos", path: "media/photos" },
  ]);
});
```

Add shell assertions to `test/server.test.ts`:

```ts
expect(response.text).toContain("data-up");
expect(response.text).toContain("data-root-path");
expect(response.text).toContain("data-breadcrumbs");
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```sh
cd file-explorer
pnpm vitest run test/ui.test.ts test/server.test.ts
```

Expected: FAIL because the two helpers and navigation hooks do not exist.

- [ ] **Step 3: Implement path helpers**

Add to `public/tree.js`:

```js
export function parentPath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function breadcrumbSegments(relativePath) {
  const segments = [{ label: "Root", path: "" }];
  const parts = relativePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    segments.push({ label: part, path: current });
  }
  return segments;
}
```

Replace the plain toolbar path in `public/index.html` with:

```html
<div class="tree-toolbar">
  <button class="icon-button" data-up aria-label="Go up one folder">↑</button>
  <nav class="breadcrumbs" data-breadcrumbs aria-label="Current folder"></nav>
  <button data-root-path aria-label="Go to root">Root</button>
  <button class="icon-button" data-refresh aria-label="Refresh folder">↻</button>
</div>
```

In `public/app.js`, import both helpers, add `up`, `rootPath`, and `breadcrumbs` to `elements`, and replace the plain `elements.path.textContent` update with a `renderBreadcrumbs()` function. Each segment button must call `loadDirectory(state.selectedRoot, segment.path)`, the Up button must call `loadDirectory(state.selectedRoot, parentPath(state.selectedPath))`, Root must load `""`, and Up must be disabled when `state.selectedPath === ""`.

Add CSS that keeps breadcrumbs horizontally scrollable without shrinking the Up, Root, or Refresh controls:

```css
.tree-toolbar { justify-content: flex-start; gap: 4px; }
.breadcrumbs { display: flex; min-width: 0; flex: 1; gap: 2px; overflow-x: auto; }
.breadcrumbs button { flex: 0 0 auto; padding: 6px 7px; }
.breadcrumbs button[aria-current="page"] { color: var(--fe-text); font-weight: 650; }
.tree-toolbar button:disabled { opacity: .45; cursor: default; }
```

- [ ] **Step 4: Run navigation and full tests**

Run:

```sh
pnpm vitest run test/ui.test.ts test/server.test.ts
pnpm test
```

Expected: focused tests pass and the full suite remains green before later tasks add more cases.

- [ ] **Step 5: Commit navigation repair**

```sh
git add file-explorer/public/tree.js file-explorer/public/index.html file-explorer/public/app.js file-explorer/public/styles.css file-explorer/test/ui.test.ts file-explorer/test/server.test.ts
git commit -m "fix(file-explorer): add parent folder navigation"
```

---

### Task 2: Add validated storage-scan configuration

**Files:**
- Create: `file-explorer/test/config.test.ts`
- Modify: `file-explorer/src/types.ts`
- Modify: `file-explorer/src/config.ts`
- Modify: `file-explorer/test/fixtures.ts`

**Interfaces:**
- Produces: `StorageScanLimits`
- Extends: `ExplorerConfig.storageScan`

- [ ] **Step 1: Write failing default and clamp tests**

Create `test/config.test.ts` with temporary options files and assert:

```ts
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function load(options: object) {
  const base = await mkdtemp(path.join(os.tmpdir(), "file-explorer-config-"));
  created.push(base);
  const optionsPath = path.join(base, "options.json");
  await writeFile(optionsPath, JSON.stringify(options));
  return loadConfig(optionsPath, path.join(base, "data"), {
    config: path.join(base, "config"),
    share: path.join(base, "share"),
    media: path.join(base, "media"),
  });
}

it("uses safe storage scan defaults", async () => {
  const config = await load({});
  expect(config.storageScan).toEqual({
    maxEntries: 200_000,
    timeoutMs: 120_000,
    cacheTtlMs: 60_000,
    maxResultNodes: 5_000,
  });
});

it("clamps storage scan options", async () => {
  const config = await load({
    storage_scan_max_entries: 1,
    storage_scan_timeout_seconds: 9_999,
    storage_scan_cache_seconds: 0,
    storage_map_max_nodes: 99_999,
  });
  expect(config.storageScan).toEqual({
    maxEntries: 1_000,
    timeoutMs: 600_000,
    cacheTtlMs: 5_000,
    maxResultNodes: 10_000,
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm vitest run test/config.test.ts`

Expected: FAIL because `storageScan` is absent.

- [ ] **Step 3: Add types and parsing**

Add to `src/types.ts`:

```ts
export interface StorageScanLimits {
  maxEntries: number;
  timeoutMs: number;
  cacheTtlMs: number;
  maxResultNodes: number;
}
```

Add `storageScan: StorageScanLimits` to `ExplorerConfig`. Extend `RawOptions` in `src/config.ts` with the four snake-case option names. Add this helper and return value:

```ts
function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

storageScan: {
  maxEntries: clamp(raw.storage_scan_max_entries, 200_000, 1_000, 1_000_000),
  timeoutMs: clamp(raw.storage_scan_timeout_seconds, 120, 5, 600) * 1_000,
  cacheTtlMs: clamp(raw.storage_scan_cache_seconds, 60, 5, 3_600) * 1_000,
  maxResultNodes: clamp(raw.storage_map_max_nodes, 5_000, 100, 10_000),
},
```

Add the same default object to `test/fixtures.ts`.

- [ ] **Step 4: Run config and type checks**

Run:

```sh
pnpm vitest run test/config.test.ts
pnpm lint
```

Expected: both commands pass.

- [ ] **Step 5: Commit configuration contracts**

```sh
git add file-explorer/src/types.ts file-explorer/src/config.ts file-explorer/test/fixtures.ts file-explorer/test/config.test.ts
git commit -m "feat(file-explorer): configure storage scans"
```

---

### Task 3: Implement the bounded filesystem scanner

**Files:**
- Create: `file-explorer/src/storageTypes.ts`
- Create: `file-explorer/src/storageScanner.ts`
- Create: `file-explorer/test/storageScanner.test.ts`

**Interfaces:**
- Consumes: `AuthorizedPath`, `StorageScanLimits`
- Produces: `StorageScanner.scan(target, limits, signal, onProgress): Promise<StorageScanTree>`
- Produces: `StorageScanTree`, `StorageTreeNode`, `StorageScanProgress`, `StorageWarning`, `ScanStopReason`

- [ ] **Step 1: Write failing scanner tests**

Create tests covering nested totals, symlink non-traversal, entry truncation, and cancellation. The core assertions must include:

```ts
expect(result.root.size).toBe(11);
expect(result.root.fileCount).toBe(2);
expect(result.root.directoryCount).toBe(1);
expect(result.root.children.find((node) => node.name === "nested")?.size).toBe(6);
expect(result.warnings).toContainEqual(expect.objectContaining({ code: "SYMLINK_SKIPPED" }));
expect(result.stopReason).toBe("entry_limit");
expect(cancelled.stopReason).toBe("cancelled");
expect(JSON.stringify(result)).not.toContain(fixture.base);
```

Use real temporary files for totals and symlinks. If Windows denies symlink creation, catch only `EPERM`/`EACCES` and use a `StorageFs` fake whose `lstat` reports `isSymbolicLink() === true`; do not skip the safety assertion.

- [ ] **Step 2: Run scanner tests and verify failure**

Run: `pnpm vitest run test/storageScanner.test.ts`

Expected: FAIL because `StorageScanner` and its contracts do not exist.

- [ ] **Step 3: Define scanner contracts**

In `src/storageTypes.ts`, define these exact shapes:

```ts
export type ScanStopReason = "entry_limit" | "timeout" | "cancelled" | null;
export type StorageWarningCode = "PERMISSION_DENIED" | "SYMLINK_SKIPPED" | "UNSUPPORTED_ENTRY";

export interface StorageWarning {
  code: StorageWarningCode;
  path: string;
}

export interface StorageScanProgress {
  files: number;
  directories: number;
  bytes: number;
  currentPath: string;
  elapsedMs: number;
}

export interface StorageTreeNode {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number;
  fileCount: number;
  directoryCount: number;
  extension: string;
  children: StorageTreeNode[];
}

export interface StorageScanTree {
  rootId: string;
  root: StorageTreeNode;
  progress: StorageScanProgress;
  warnings: StorageWarning[];
  stopReason: ScanStopReason;
  completedAt: string;
}
```

- [ ] **Step 4: Implement iterative, cooperative traversal**

Create `StorageScanner` with an injectable filesystem adapter for deterministic errors:

```ts
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { AuthorizedPath, StorageScanLimits } from "./types.js";
import type {
  ScanStopReason,
  StorageScanProgress,
  StorageScanTree,
  StorageTreeNode,
  StorageWarning,
} from "./storageTypes.js";

export interface StorageDirent { name: string; }
export interface StorageFs {
  lstat(targetPath: string): Promise<Stats>;
  readdir(targetPath: string): Promise<StorageDirent[]>;
}

const nodeStorageFs: StorageFs = {
  lstat,
  async readdir(targetPath) {
    return (await readdir(targetPath, { withFileTypes: true })).map(({ name }) => ({ name }));
  },
};

function relativeDisplayPath(rootPath: string, childPath: string): string {
  return path.relative(rootPath, childPath).split(path.sep).join("/");
}

function addWarning(warnings: StorageWarning[], warning: StorageWarning): void {
  if (warnings.length < 100) warnings.push(warning);
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function finalizeDirectory(node: StorageTreeNode): void {
  if (node.kind === "file") return;
  node.size = 0;
  node.fileCount = 0;
  node.directoryCount = 0;
  for (const child of node.children) {
    finalizeDirectory(child);
    node.size += child.size;
    if (child.kind === "file") node.fileCount += 1;
    else {
      node.fileCount += child.fileCount;
      node.directoryCount += child.directoryCount + 1;
    }
  }
}

export class StorageScanner {
  constructor(private readonly fs: StorageFs = nodeStorageFs) {}

  async scan(
    target: AuthorizedPath,
    limits: StorageScanLimits,
    signal: AbortSignal,
    onProgress: (progress: StorageScanProgress) => void = () => undefined,
  ): Promise<StorageScanTree> {
    const startedAt = Date.now();
    const warnings: StorageWarning[] = [];
    const root: StorageTreeNode = {
      name: target.root.label,
      relativePath: "",
      kind: "directory",
      size: 0,
      fileCount: 0,
      directoryCount: 0,
      extension: "",
      children: [],
    };
    const progress: StorageScanProgress = {
      files: 0,
      directories: 1,
      bytes: 0,
      currentPath: "",
      elapsedMs: 0,
    };
    const stack = [{ absolutePath: target.absolutePath, node: root }];
    let entriesVisited = 0;
    let stopReason: ScanStopReason = null;

    const stopped = (): ScanStopReason => {
      if (signal.aborted) return "cancelled";
      if (Date.now() - startedAt >= limits.timeoutMs) return "timeout";
      if (entriesVisited >= limits.maxEntries) return "entry_limit";
      return null;
    };

    while (stack.length > 0 && stopReason === null) {
      const current = stack.pop() as { absolutePath: string; node: StorageTreeNode };
      progress.currentPath = current.node.relativePath;
      let entries: StorageDirent[];
      try {
        entries = await this.fs.readdir(current.absolutePath);
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        addWarning(warnings, { code: "PERMISSION_DENIED", path: current.node.relativePath });
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        stopReason = stopped();
        if (stopReason !== null) break;
        entriesVisited += 1;
        const childAbsolute = path.join(current.absolutePath, entry.name);
        const relativePath = relativeDisplayPath(target.absolutePath, childAbsolute);
        let stats: Stats;
        try {
          stats = await this.fs.lstat(childAbsolute);
        } catch (error) {
          if (!isPermissionError(error)) throw error;
          addWarning(warnings, { code: "PERMISSION_DENIED", path: relativePath });
          continue;
        }

        if (stats.isSymbolicLink()) {
          addWarning(warnings, { code: "SYMLINK_SKIPPED", path: relativePath });
        } else if (stats.isDirectory()) {
          const child: StorageTreeNode = {
            name: entry.name, relativePath, kind: "directory", size: 0,
            fileCount: 0, directoryCount: 0, extension: "", children: [],
          };
          current.node.children.push(child);
          progress.directories += 1;
          stack.push({ absolutePath: childAbsolute, node: child });
        } else if (stats.isFile()) {
          const extension = path.extname(entry.name).toLowerCase();
          current.node.children.push({
            name: entry.name, relativePath, kind: "file", size: stats.size,
            fileCount: 1, directoryCount: 0, extension, children: [],
          });
          progress.files += 1;
          progress.bytes += stats.size;
        } else {
          addWarning(warnings, { code: "UNSUPPORTED_ENTRY", path: relativePath });
        }

        progress.elapsedMs = Date.now() - startedAt;
        if (entriesVisited % 100 === 0) onProgress({ ...progress });
      }
    }

    finalizeDirectory(root);
    progress.bytes = root.size;
    progress.elapsedMs = Date.now() - startedAt;
    onProgress({ ...progress });
    return {
      rootId: target.root.id,
      root,
      progress,
      warnings,
      stopReason,
      completedAt: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 5: Run scanner tests, lint, and full tests**

Run:

```sh
pnpm vitest run test/storageScanner.test.ts
pnpm lint
pnpm test
```

Expected: nested totals, safety, truncation, and cancellation tests pass; the full suite remains green.

- [ ] **Step 6: Commit scanner**

```sh
git add file-explorer/src/storageTypes.ts file-explorer/src/storageScanner.ts file-explorer/test/storageScanner.test.ts
git commit -m "feat(file-explorer): scan storage safely"
```

---

### Task 4: Project scan trees into bounded public views

**Files:**
- Create: `file-explorer/src/storageProjection.ts`
- Create: `file-explorer/test/storageProjection.test.ts`
- Modify: `file-explorer/src/storageTypes.ts`

**Interfaces:**
- Consumes: `StorageScanTree`, requested root-relative path, node budget
- Produces: `normalizeFileType(name: string): { extension: string; typeGroup: string }`
- Produces: `projectStorageResult(tree, relativePath, maxNodes, idNamespace): StorageMapResult`

- [ ] **Step 1: Write failing categorization and aggregation tests**

Build an in-memory tree with large `.gguf`, `.mp4`, `.jpg`, extensionless, and many tiny `.json` files. Assert:

```ts
expect(normalizeFileType("MODEL.GGUF")).toEqual({ extension: ".gguf", typeGroup: "model" });
expect(normalizeFileType("archive.tar.gz")).toEqual({ extension: ".gz", typeGroup: "archive" });
expect(result.root.size).toBe(sourceTree.root.size);
expect(result.visibleNodeCount).toBeLessThanOrEqual(6);
expect(result.root.children).toContainEqual(expect.objectContaining({
  kind: "aggregate",
  extension: ".json",
  openable: false,
  aggregateCount: 20,
}));
expect(() => projectStorageResult(sourceTree, "../outside", 50, "job-1")).toThrowError("Result path is unavailable");
```

- [ ] **Step 2: Run projection tests and verify failure**

Run: `pnpm vitest run test/storageProjection.test.ts`

Expected: FAIL because projection functions do not exist.

- [ ] **Step 3: Add public result contracts**

Append to `storageTypes.ts`:

```ts
export interface StorageMapNode {
  id: string;
  name: string;
  relativePath: string | null;
  kind: "file" | "directory" | "aggregate";
  size: number;
  fileCount: number;
  directoryCount: number;
  extension: string;
  typeGroup: string;
  openable: boolean;
  aggregateCount: number;
  children: StorageMapNode[];
}

export interface StorageMapResult {
  rootId: string;
  requestedPath: string;
  root: StorageMapNode;
  visibleNodeCount: number;
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  completedAt: string;
  incomplete: boolean;
  incompleteReason: ScanStopReason;
  warnings: StorageWarning[];
}
```

- [ ] **Step 4: Implement deterministic projection**

Implement `normalizeFileType` with explicit groups:

```ts
const TYPE_GROUPS: Record<string, string> = {
  ".gguf": "model", ".bin": "model",
  ".zip": "archive", ".gz": "archive", ".tar": "archive", ".7z": "archive",
  ".mp4": "video", ".mkv": "video", ".webm": "video",
  ".mp3": "audio", ".flac": "audio", ".wav": "audio",
  ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image", ".svg": "image",
  ".yaml": "text", ".yml": "text", ".json": "text", ".txt": "text", ".md": "text", ".js": "text", ".ts": "text",
};
```

Projection must locate the requested directory by exact normalized relative path, recursively retain directory grouping, retain largest files first, and group omitted same-directory files by normalized extension. Generate IDs from a stable hash of `idNamespace + kind + relativePath + extension`; `StorageScanService.result()` passes the opaque job ID as `idNamespace`. Do not use IDs as path authority. Sort ties by name so repeated requests are stable. Throw a `DomainError("RESULT_PATH_UNAVAILABLE", 404, "Result path is unavailable")` for a missing/non-directory path.

- [ ] **Step 5: Verify projection and scanner compatibility**

Run:

```sh
pnpm vitest run test/storageProjection.test.ts test/storageScanner.test.ts
pnpm lint
```

Expected: all focused tests and type checks pass.

- [ ] **Step 6: Commit projection**

```sh
git add file-explorer/src/storageTypes.ts file-explorer/src/storageProjection.ts file-explorer/test/storageProjection.test.ts
git commit -m "feat(file-explorer): compact storage map results"
```

---

### Task 5: Add scan jobs, caching, and invalidation

**Files:**
- Create: `file-explorer/src/storageScanService.ts`
- Create: `file-explorer/test/storageScanService.test.ts`
- Modify: `file-explorer/src/storageTypes.ts`

**Interfaces:**
- Consumes: `PathPolicy`, `StorageScanner`, `ExplorerConfig.storageScan`
- Produces: `StorageScanService.start(rootId, refresh)`
- Produces: `StorageScanService.snapshot(jobId)`
- Produces: `StorageScanService.result(jobId, relativePath)`
- Produces: `StorageScanService.cancel(jobId)`
- Produces: `StorageScanService.invalidate(...rootIds)`

- [ ] **Step 1: Write failing service tests with a controlled scanner**

Use a fake scanner returning a deferred promise. Assert:

```ts
const first = await service.start("config", false);
const second = await service.start("config", false);
expect(scanner.scan).toHaveBeenCalledTimes(1);
expect(second.id).toBe(first.id);

clock.advanceTimersByTime(60_001);
const expired = await service.start("config", false);
expect(expired.id).not.toBe(first.id);

service.invalidate("config");
const refreshed = await service.start("config", false);
expect(refreshed.id).not.toBe(expired.id);

await service.cancel(refreshed.id);
expect(service.snapshot(refreshed.id).status).toBe("cancelled");
```

Also assert that three simultaneous roots can exist but only the least-recently-used completed cache is evicted when a fourth synthetic cache key is inserted under a configured cache-count limit of three.

- [ ] **Step 2: Run service tests and verify failure**

Run: `pnpm vitest run test/storageScanService.test.ts`

Expected: FAIL because `StorageScanService` is missing.

- [ ] **Step 3: Define public job snapshots**

Add to `storageTypes.ts`:

```ts
export type StorageJobStatus = "running" | "complete" | "partial" | "cancelled" | "failed";

export interface StorageJobSnapshot {
  id: string;
  root: string;
  status: StorageJobStatus;
  progress: StorageScanProgress;
  warnings: StorageWarning[];
  truncated: boolean;
  truncationReason: ScanStopReason;
  cached: boolean;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  resultAvailable: boolean;
}
```

- [ ] **Step 4: Implement job lifecycle**

Use `randomUUID()` for IDs and maps for jobs, active root/generation keys, generations, and completed caches. `start()` must authorize `rootId` at `""` through `PathPolicy.authorize(rootId, "", "read")`, reuse a fresh cache, deduplicate an active key, and launch the scanner without awaiting completion. Attach both fulfillment and rejection handlers immediately. A refresh increments the generation and aborts any older running job for that root before starting the replacement, preserving the one-physical-scan-per-root rule. Convert scanner stop reasons to `partial` except `cancelled`, which maps to `cancelled`; sanitize failures to `{ code: "SCAN_FAILED", message: "Storage scan failed" }`.

Set `resultAvailable` whenever a complete, partial, or cancelled job owns a safe tree. `result()` is async: it must allow all three states when `resultAvailable` is true, authorize the requested path with `PathPolicy.authorize(job.root, relativePath, "read")`, use the returned normalized relative path for projection, touch cache LRU time only for reusable complete/partial caches, pass the job ID to `projectStorageResult` as `idNamespace`, and reject failed/no-tree jobs. `cancel()` aborts only running jobs. `invalidate()` increments generations, aborts older running jobs, and removes completed cache entries for each root. Expired jobs return `DomainError("SCAN_JOB_EXPIRED", 404, "Storage scan expired")`.

Limit reusable caches to three roots and at most `limits.maxEntries * 2` estimated retained nodes; evict least-recently-used entries until both bounds are satisfied. Expose a `dispose()` method that aborts running controllers and clears the cleanup interval, and call `unref()` on the interval.

- [ ] **Step 5: Run lifecycle tests and full server tests**

Run:

```sh
pnpm vitest run test/storageScanService.test.ts
pnpm lint
pnpm test
```

Expected: deduplication, expiration, invalidation, cancellation, failure sanitization, and eviction tests pass.

- [ ] **Step 6: Commit scan service**

```sh
git add file-explorer/src/storageTypes.ts file-explorer/src/storageScanService.ts file-explorer/test/storageScanService.test.ts
git commit -m "feat(file-explorer): manage storage scan jobs"
```

---

### Task 6: Expose storage-map APIs

**Files:**
- Create: `file-explorer/src/routes/storageMap.ts`
- Create: `file-explorer/test/storageMapRoutes.test.ts`
- Modify: `file-explorer/src/server.ts`

**Interfaces:**
- Consumes: `StorageScanService`
- Produces routes:
  - `POST /api/storage-map/scans`
  - `GET /api/storage-map/scans/:jobId`
  - `GET /api/storage-map/scans/:jobId/result`
  - `DELETE /api/storage-map/scans/:jobId`

- [ ] **Step 1: Write failing route-contract tests**

Construct an app with a real temporary root and low limits. Assert:

```ts
const started = await request(app)
  .post("/api/storage-map/scans")
  .send({ root: "config", refresh: false })
  .expect(202);
expect(started.body.job.id).toMatch(/^[0-9a-f-]+$/i);

await request(app).post("/api/storage-map/scans").send({ root: "disabled" }).expect(404);
await request(app).get("/api/storage-map/scans/not-a-job").expect(404);

const status = await waitForTerminalStatus(app, started.body.job.id);
expect(["complete", "partial"]).toContain(status.body.job.status);
const result = await request(app)
  .get(`/api/storage-map/scans/${started.body.job.id}/result`)
  .query({ path: "" })
  .expect(200);
expect(JSON.stringify(result.body)).not.toContain(fixture.base);

await request(app).delete(`/api/storage-map/scans/${started.body.job.id}`).expect(204);
```

Implement `waitForTerminalStatus` in the test as a 50-iteration loop with a 10 ms timer and fail with the last body if no terminal state arrives.

- [ ] **Step 2: Run route tests and verify failure**

Run: `pnpm vitest run test/storageMapRoutes.test.ts`

Expected: FAIL with 404 for the unregistered start route.

- [ ] **Step 3: Implement and register the router**

Define:

```ts
export interface StorageMapContext {
  storageScans: StorageScanService;
}
```

The start route validates `root` as a string and `refresh` as a boolean when present, calls `start`, and returns HTTP 202 with `{ job }`. Status returns `{ job }`. Result reads a string query `path` defaulting to `""` and returns `{ result }`. Cancel calls `cancel` and returns 204.

Extend `AppContext` with optional `storageScans`, register the router whenever present, and construct `StorageScanner` plus `StorageScanService` in `createConfiguredApp()` using the existing policy and `config.storageScan`. Keep a single `PathPolicy` instance shared by browse, mutations, search, and scan service.

- [ ] **Step 4: Run routes, security tests, and lint**

Run:

```sh
pnpm vitest run test/storageMapRoutes.test.ts test/securityRoutes.test.ts
pnpm lint
pnpm test
```

Expected: API contract and existing security tests pass; no absolute fixture path appears in responses.

- [ ] **Step 5: Commit API**

```sh
git add file-explorer/src/routes/storageMap.ts file-explorer/src/server.ts file-explorer/test/storageMapRoutes.test.ts
git commit -m "feat(file-explorer): expose storage scan API"
```

---

### Task 7: Invalidate scans after filesystem mutations

**Files:**
- Modify: `file-explorer/src/routes/files.ts`
- Modify: `file-explorer/src/routes/trash.ts`
- Modify: `file-explorer/src/server.ts`
- Modify: `file-explorer/test/mutations.test.ts`

**Interfaces:**
- Consumes: `StorageScanService.invalidate(...rootIds)`
- Extends: `FileContext.storageScans?: Pick<StorageScanService, "invalidate">`

- [ ] **Step 1: Write failing invalidation assertions**

Inject `{ invalidate: vi.fn() }` as `storageScans` in mutation test context. After each successful create, upload, text save, move, trash, and restore request, assert the affected root. For move, assert source and target roots are deduplicated:

```ts
expect(storageScans.invalidate).toHaveBeenLastCalledWith("config");
expect(storageScans.invalidate).toHaveBeenCalledTimes(1);
```

Add a failed stale-save assertion proving invalidation was not called.

- [ ] **Step 2: Run mutation tests and verify failure**

Run: `pnpm vitest run test/mutations.test.ts`

Expected: FAIL because successful routes do not invalidate storage scans.

- [ ] **Step 3: Invalidate only after successful mutations**

Add optional invalidation to `FileContext`. Call it after the filesystem/safety promise succeeds and before sending the response:

```ts
context.storageScans?.invalidate(target.root.id);
```

For move:

```ts
const entry = await context.filesystem.move(source, target);
context.storageScans?.invalidate(...new Set([source.root.id, target.root.id]));
response.json({ entry });
```

Trash invalidates `target.root.id`; restore invalidates `record.rootId`. Before permanent purge, read the trash record, purge it, and invalidate `record.rootId` so every successful purge operation fulfills the same cache-invalidation contract.

- [ ] **Step 4: Run mutation, storage service, and full tests**

Run:

```sh
pnpm vitest run test/mutations.test.ts test/storageScanService.test.ts
pnpm test
pnpm lint
```

Expected: invalidation occurs once after success and never after failed mutations.

- [ ] **Step 5: Commit invalidation**

```sh
git add file-explorer/src/routes/files.ts file-explorer/src/routes/trash.ts file-explorer/src/server.ts file-explorer/test/mutations.test.ts
git commit -m "feat(file-explorer): invalidate storage maps on changes"
```

---

### Task 8: Build client scan state and treemap layout

**Files:**
- Create: `file-explorer/public/treemap.js`
- Create: `file-explorer/public/storage-map.js`
- Create: `file-explorer/test/treemap.test.mjs`
- Modify: `file-explorer/public/operations.js`
- Modify: `file-explorer/test/ui.test.ts`

**Interfaces:**
- Produces: `layoutTreemap(nodes, width, height): TreemapRect[]`
- Produces: `createStorageMap({ operations, onOpenFile, onClose, formatSize })`
- Adds operations: `startStorageScan`, `storageScanStatus`, `storageScanResult`, `cancelStorageScan`

- [ ] **Step 1: Write failing layout and operation tests**

In `test/treemap.test.mjs`, assert exact total area and bounds:

```js
import { expect, it } from "vitest";
import { layoutTreemap } from "../public/treemap.js";

it("lays out positive nodes proportionally inside the viewport", () => {
  const rectangles = layoutTreemap([
    { id: "a", size: 60 },
    { id: "b", size: 30 },
    { id: "c", size: 10 },
  ], 100, 50);
  expect(rectangles).toHaveLength(3);
  expect(rectangles.every((item) => item.x >= 0 && item.y >= 0)).toBe(true);
  expect(rectangles.every((item) => item.x + item.width <= 100.0001)).toBe(true);
  expect(rectangles.every((item) => item.y + item.height <= 50.0001)).toBe(true);
  expect(rectangles.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(5_000, 4);
  expect((rectangles[0].width * rectangles[0].height) / 5_000).toBeCloseTo(.6, 4);
});
```

In `test/ui.test.ts`, assert operation URL/method contracts for all four APIs and that `startStorageScan("share", true)` sends `{ root: "share", refresh: true }`.

- [ ] **Step 2: Run focused client tests and verify failure**

Run:

```sh
pnpm vitest run test/treemap.test.mjs test/ui.test.ts
```

Expected: FAIL because layout and operation methods are absent.

- [ ] **Step 3: Implement a deterministic squarified layout**

`layoutTreemap` must:

- discard nodes with non-positive/non-finite size;
- stable-sort descending size, then ID;
- scale sizes to `width * height`;
- use the standard squarify worst-aspect-ratio comparison to build rows;
- lay each row along the shorter remaining side;
- return `{ node, x, y, width, height }` in deterministic order;
- return `[]` for non-positive viewport dimensions.

Keep the pure layout under 140 lines and export helper `worstRatio(row, side)` only if tests need direct coverage.

- [ ] **Step 4: Add storage API methods and state controller**

Add to `createOperations`:

```js
startStorageScan(root, refresh = false) {
  return api.request("api/storage-map/scans", {
    method: "POST",
    body: JSON.stringify({ root, refresh }),
  });
},
storageScanStatus(id) {
  return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`);
},
storageScanResult(id, path = "") {
  return api.request(`api/storage-map/scans/${encodeURIComponent(id)}/result?path=${encodeURIComponent(path)}`);
},
cancelStorageScan(id) {
  return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`, { method: "DELETE" });
},
```

Create `storage-map.js` as a controller with `open(root)`, `close()`, `refresh()`, `cancel()`, and `drill(path)` methods. Poll no faster than 500 ms, stop polling on terminal status, suppress per-tick live announcements, and retain the last safe result on connection failure. Accept callbacks rather than importing `app.js` to avoid a cycle.

- [ ] **Step 5: Run client tests**

Run:

```sh
pnpm vitest run test/treemap.test.mjs test/ui.test.ts
pnpm lint
```

Expected: proportional layout and all operation contracts pass.

- [ ] **Step 6: Commit client foundations**

```sh
git add file-explorer/public/treemap.js file-explorer/public/storage-map.js file-explorer/public/operations.js file-explorer/test/treemap.test.mjs file-explorer/test/ui.test.ts
git commit -m "feat(file-explorer): add storage map client"
```

---

### Task 9: Integrate the full-screen accessible storage map

**Files:**
- Modify: `file-explorer/public/index.html`
- Modify: `file-explorer/public/app.js`
- Modify: `file-explorer/public/storage-map.js`
- Modify: `file-explorer/public/styles.css`
- Create: `file-explorer/test/storage-map-ui.test.mjs`
- Modify: `file-explorer/test/server.test.ts`

**Interfaces:**
- Consumes: `createStorageMap`, existing `openFile`, selected root, `formatSize`
- Produces DOM hooks: `[data-storage-map]`, `[data-storage-open]`, `[data-storage-close]`, `[data-storage-refresh]`, `[data-storage-cancel]`, `[data-storage-canvas]`, `[data-storage-details]`, `[data-storage-status]`

- [ ] **Step 1: Write failing shell and UI-state tests**

Assert the shell includes every hook above. In `storage-map-ui.test.mjs`, load `index.html` into jsdom, instantiate the controller with mocked operations, and assert:

```js
await controller.open("share");
expect(document.querySelector("[data-storage-map]").hidden).toBe(false);
expect(document.querySelector("[data-storage-status]").textContent).toContain("Scanning");

await completeMockedScan();
expect(document.querySelectorAll("[data-storage-node]").length).toBeGreaterThan(0);
expect(document.querySelector("[data-storage-summary]").textContent).toContain("files");

await clickDirectoryNode();
expect(operations.storageScanResult).toHaveBeenLastCalledWith("job-1", "media");

await clickFileNode();
expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "media/movie.mp4" }));
```

Also test incomplete labeling, aggregate non-opening, Cancel, closing without cancellation, focus restoration, keyboard Enter, connection retry, and mobile detail-sheet selection.

- [ ] **Step 2: Run UI tests and verify failure**

Run:

```sh
pnpm vitest run test/storage-map-ui.test.mjs test/server.test.ts
```

Expected: FAIL because the focus-view shell and rendering hooks are absent.

- [ ] **Step 3: Add semantic focus-view markup**

Add a `Storage map` header button and a sibling focus view to `main`:

```html
<button data-storage-open>Storage map</button>
<section class="storage-map" data-storage-map hidden aria-label="Storage map">
  <header class="storage-map-header">
    <button data-storage-close aria-label="Close storage map">← Back</button>
    <nav data-storage-breadcrumbs aria-label="Storage map path"></nav>
    <div class="storage-map-actions">
      <span data-storage-age></span>
      <button data-storage-refresh>Refresh scan</button>
      <button data-storage-cancel hidden>Cancel</button>
    </div>
  </header>
  <div class="storage-map-summary" data-storage-summary></div>
  <div class="storage-map-legend" data-storage-legend aria-label="File type legend"></div>
  <div class="storage-map-canvas" data-storage-canvas role="tree" aria-label="Files sized by storage use"></div>
  <aside class="storage-map-details" data-storage-details hidden></aside>
  <div class="storage-map-status" data-storage-status aria-live="polite"></div>
</section>
```

- [ ] **Step 4: Render hierarchy, legend, details, and interactions**

Use CSS custom properties for type colors (`--fe-type-model`, `archive`, `video`, `audio`, `image`, `text`, `other`). Directory rectangles receive borders/labels and recursively lay out children inside an inset content rectangle. File/aggregate rectangles receive type colors. Hide labels when a rectangle cannot fit at least 44×24 px, but preserve its accessible name and details.

In `app.js`, create one controller. `onOpenFile` must call the existing `openFile` with `{ name, path: relativePath, type: "file", size }`; `onClose` restores focus to `[data-storage-open]`. Opening the map must not discard editor state. Normal file opening still runs the existing dirty-editor confirmation.

Directory and file nodes use buttons with `data-storage-node`, `role="treeitem"`, `aria-label` containing formatted size, and Enter activation. Arrow keys move through visible nodes using bounded index logic. Aggregate nodes set `aria-disabled="true"` for opening but remain focusable for details.

- [ ] **Step 5: Add responsive and reduced-motion styling**

The focus view must be `position: fixed; inset: 0; z-index: 20`, use Home Assistant theme variables, and reserve a bottom details sheet on widths below 720 px. Controls must remain at least 40 px high. Add no animated transitions under `prefers-reduced-motion: reduce`. Ensure map text uses both contrast and labels/icons so color is not the only type indicator.

- [ ] **Step 6: Run UI, accessibility-contract, and full tests**

Run:

```sh
pnpm vitest run test/storage-map-ui.test.mjs test/server.test.ts test/ui.test.ts
pnpm test
pnpm lint
pnpm build
```

Expected: all scan states, drill-down, file opening, aggregate behavior, keyboard behavior, and responsive DOM contracts pass.

- [ ] **Step 7: Commit focus UI**

```sh
git add file-explorer/public/index.html file-explorer/public/app.js file-explorer/public/storage-map.js file-explorer/public/styles.css file-explorer/test/storage-map-ui.test.mjs file-explorer/test/server.test.ts
git commit -m "feat(file-explorer): show storage treemap"
```

---

### Task 10: Release metadata, documentation, and final verification

**Files:**
- Modify: `file-explorer/config.yaml`
- Modify: `file-explorer/README.md`
- Modify: `file-explorer/test/packaging.test.ts`

**Interfaces:**
- Publishes: File Explorer `0.2.0`
- Adds options: `storage_scan_max_entries`, `storage_scan_timeout_seconds`, `storage_scan_cache_seconds`, `storage_map_max_nodes`

- [ ] **Step 1: Write failing release assertions**

Extend `test/packaging.test.ts` to read `config.yaml` and `README.md` and assert:

```ts
expect(config).toContain('version: "0.2.0"');
expect(config).toContain("storage_scan_max_entries: 200000");
expect(config).toContain("storage_scan_timeout_seconds: 120");
expect(config).toContain("storage_scan_cache_seconds: 60");
expect(config).toContain("storage_map_max_nodes: 5000");
expect(readme).toContain("Storage map");
expect(readme).toContain("logical file sizes");
expect(readme).toContain("does not follow symlinks");
```

- [ ] **Step 2: Run release test and verify failure**

Run: `pnpm vitest run test/packaging.test.ts`

Expected: FAIL because version/options/documentation are not updated.

- [ ] **Step 3: Update add-on configuration**

Set version `0.2.0`. Add defaults under `options` and validated ranges under `schema`:

```yaml
  storage_scan_max_entries: 200000
  storage_scan_timeout_seconds: 120
  storage_scan_cache_seconds: 60
  storage_map_max_nodes: 5000
```

```yaml
  storage_scan_max_entries: int(1000,1000000)
  storage_scan_timeout_seconds: int(5,600)
  storage_scan_cache_seconds: int(5,3600)
  storage_map_max_nodes: int(100,10000)
```

- [ ] **Step 4: Document behavior and limitations**

Add Storage map to Features; add all four options to the table; explain on-demand caching, Refresh, incomplete scans, logical sizes, tiny-file aggregation, selected-root scope, and that scanning does not follow symlinks. Add manual checks for Up/Root/breadcrumb navigation, desktop/mobile focus mode, cancellation, refresh after mutation, and an intentionally created symlink.

Change Development install command to the verified standalone command:

```sh
pnpm install --frozen-lockfile
```

- [ ] **Step 5: Run fresh completion verification**

Run from `file-explorer/`:

```sh
rm -rf node_modules dist
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm prune --prod
test -f dist/server.js
```

Then run from the repository root:

```sh
git diff --check
git status --short
```

Expected:

- frozen install exits 0 and esbuild’s allowed postinstall runs;
- lint exits 0;
- all tests pass with no skipped storage-safety tests;
- build exits 0 and `dist/server.js` exists;
- production prune exits 0;
- diff check emits no output;
- status lists only intentional feature files before commit.

If Docker is available, also run:

```sh
docker build -t file-explorer:0.2.0 file-explorer
```

Expected: image build completes. If Docker is unavailable, record the exact daemon error as a remaining verification limitation without claiming an image build.

- [ ] **Step 6: Commit release**

```sh
git add file-explorer/config.yaml file-explorer/README.md file-explorer/test/packaging.test.ts
git commit -m "docs(file-explorer): release storage map"
```

- [ ] **Step 7: Rebase after PR #29 and rerun verification**

After PR #29 merges:

```sh
git fetch origin main
git rebase origin/main
cd file-explorer
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
cd ..
git diff --check origin/main...HEAD
```

Expected: rebase is clean, verification passes, and the feature diff contains the storage-map work without duplicating the already-merged build-policy commit.
