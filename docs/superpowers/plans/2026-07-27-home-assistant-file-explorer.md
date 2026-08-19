# Home Assistant File Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, administrator-only Home Assistant ingress add-on for safe full file management across selectable `/config`, `/share`, and `/media` roots.

**Architecture:** A TypeScript/Express service owns root configuration, path authorization, filesystem operations, search, trash, and backups. A locally served vanilla JavaScript interface uses root IDs and relative paths only, with an adaptive two-pane layout and Home Assistant theme variables.

**Tech Stack:** Node.js 22, TypeScript, Express 5, pnpm, Vitest, Supertest, vanilla JavaScript, HTML, CSS, Home Assistant add-on ingress.

## Global Constraints

- The add-on is standalone under `homeassistant-addons/file-explorer/` and remains independent of RemindMe AI.
- Home Assistant ingress is the only browser entry point; `panel_admin` is enabled and no host port is exposed.
- Selectable roots are `/config`, `/share`, and `/media`; `/ssl` and `/backup` are excluded from v1.
- Browser APIs use stable root IDs and normalized relative paths, never unrestricted host paths.
- Every filesystem route delegates source and target authorization to the central path-policy service.
- The UI follows Home Assistant theme variables in light and dark modes and loads no runtime CDN assets.
- The editor remains a simple bounded text editor; IDE autocomplete, diagnostics, shell access, and multi-user roles are excluded.
- Tests use temporary directories only and never touch a real Home Assistant installation.
- Use pnpm for dependency, build, lint, and test commands.

## Planned File Structure

```text
homeassistant-addons/file-explorer/
├── Dockerfile                         # Multi-stage add-on image
├── README.md                          # Installation, options, safety, manual verification
├── config.yaml                        # HA metadata, ingress, admin panel, mounts, options
├── package.json                       # pnpm scripts and dependencies
├── pnpm-lock.yaml                     # Add-on lockfile
├── run.sh                             # Add-on entrypoint
├── tsconfig.json                      # TypeScript build configuration
├── public/
│   ├── index.html                     # Ingress-safe application shell
│   ├── app.js                         # Client state and API coordination
│   ├── api.js                         # Ingress-relative HTTP client
│   ├── tree.js                        # Root and directory tree behavior
│   ├── editor.js                      # Preview, dirty state, conflicts, save
│   ├── operations.js                  # Dialogs, upload, move, trash, restore
│   └── styles.css                     # HA adaptive theme and responsive layout
├── src/
│   ├── server.ts                      # Express composition and startup
│   ├── config.ts                      # Add-on options and numeric limits
│   ├── errors.ts                      # Stable domain/API error types
│   ├── types.ts                       # Shared backend contracts
│   ├── roots.ts                       # Enabled root registry
│   ├── pathPolicy.ts                  # Canonical path authorization
│   ├── filesystem.ts                  # Reads and ordinary mutations
│   ├── safety.ts                      # Backups, trash manifests, restore, purge
│   ├── search.ts                      # Bounded cancellable name/content search
│   └── routes/
│       ├── browse.ts                  # Roots, list, metadata, text reads
│       ├── files.ts                   # Create, save, rename, move, upload/download
│       ├── search.ts                  # Search endpoint
│       └── trash.ts                   # Delete, trash listing, restore, purge
└── test/
    ├── fixtures.ts                    # Temporary root harness
    ├── pathPolicy.test.ts             # Shared malicious path corpus
    ├── browse.test.ts                 # Root/list/read/download API
    ├── mutations.test.ts              # Create/save/move/upload and conflicts
    ├── safety.test.ts                 # Backup/trash/restore/purge behavior
    ├── search.test.ts                 # Name/content search limits and cancellation
    ├── securityRoutes.test.ts         # Corpus applied to every filesystem route
    ├── ui.test.ts                     # jsdom client-state tests
    └── smoke.test.ts                  # End-to-end API workflow
```

---

### Task 1: Add-on Shell and Ingress-Safe Server

**Files:**

- Create: `homeassistant-addons/file-explorer/config.yaml`
- Create: `homeassistant-addons/file-explorer/package.json`
- Create: `homeassistant-addons/file-explorer/pnpm-lock.yaml`
- Create: `homeassistant-addons/file-explorer/tsconfig.json`
- Create: `homeassistant-addons/file-explorer/run.sh`
- Create: `homeassistant-addons/file-explorer/Dockerfile`
- Create: `homeassistant-addons/file-explorer/src/server.ts`
- Create: `homeassistant-addons/file-explorer/public/index.html`
- Test: `homeassistant-addons/file-explorer/test/server.test.ts`

**Interfaces:**

- Produces: `createApp(options?: { publicDir?: string }): Express`
- Produces: `GET /api/health -> { ok: true, service: "file-explorer" }`
- Produces: static assets addressed with relative URLs under arbitrary ingress prefixes.

- [ ] **Step 1: Create package metadata and a failing server test**

```json
{
  "name": "home-assistant-file-explorer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^24.0.0",
    "jsdom": "^26.1.0",
    "supertest": "^7.1.4",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

```ts
// test/server.test.ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

describe("server shell", () => {
  it("reports health", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, service: "file-explorer" });
  });

  it("serves an ingress-relative application shell", async () => {
    const response = await request(createApp()).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toContain('src="./app.js"');
    expect(response.text).toContain('href="./styles.css"');
  });
});
```

- [ ] **Step 2: Install dependencies and verify the test fails**

Run: `cd homeassistant-addons/file-explorer && pnpm install && pnpm test -- test/server.test.ts`

Expected: FAIL because `src/server.ts` and `createApp` do not exist.

- [ ] **Step 3: Implement the minimal Express shell and ingress-safe HTML**

```ts
// src/server.ts
import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function createApp(options: { publicDir?: string } = {}): Express {
  const app = express();
  const publicDir = options.publicDir ?? path.resolve(moduleDir, "../public");
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "file-explorer" });
  });
  app.use(express.static(publicDir, { index: "index.html", fallthrough: false }));
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 8091);
  createApp().listen(port, "0.0.0.0", () => {
    console.log(`file-explorer listening on ${port}`);
  });
}
```

```html
<!-- public/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>File Explorer</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main id="app" aria-busy="true">Loading File Explorer…</main>
    <script type="module" src="./app.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Add Home Assistant packaging**

```yaml
# config.yaml
name: File Explorer
version: "0.1.0"
slug: file_explorer
description: Safe administrator-only file management through Home Assistant ingress
arch:
  - aarch64
  - amd64
  - armv7
startup: application
boot: auto
init: false
ingress: true
ingress_port: 8091
panel_icon: mdi:folder-cog-outline
panel_title: File Explorer
panel_admin: true
options:
  enable_config: true
  enable_share: true
  enable_media: true
  text_edit_max_bytes: 1048576
  search_file_max_bytes: 2097152
  upload_max_bytes: 104857600
  search_max_results: 500
  search_timeout_seconds: 15
  retention_days: 30
schema:
  enable_config: bool
  enable_share: bool
  enable_media: bool
  text_edit_max_bytes: int(1024,10485760)
  search_file_max_bytes: int(1024,10485760)
  upload_max_bytes: int(1048576,1073741824)
  search_max_results: int(10,5000)
  search_timeout_seconds: int(1,120)
  retention_days: int(1,365)
map:
  - type: config
    read_only: false
  - type: share
    read_only: false
  - type: media
    read_only: false
```

```sh
#!/usr/bin/with-contenv sh
set -eu
export PORT=8091
export FILE_EXPLORER_OPTIONS=/data/options.json
export FILE_EXPLORER_DATA=/data/file-explorer
exec node /app/dist/server.js
```

```dockerfile
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM} AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${BUILD_FROM}
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY public ./public
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
```

- [ ] **Step 5: Run shell verification**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/server.test.ts && pnpm build`

Expected: both tests PASS and TypeScript exits successfully.

- [ ] **Step 6: Commit the shell**

```bash
git add homeassistant-addons/file-explorer
git commit -m "feat(file-explorer): scaffold ingress add-on"
```

---

### Task 2: Configuration, Root Registry, and Path Policy

**Files:**

- Create: `homeassistant-addons/file-explorer/src/types.ts`
- Create: `homeassistant-addons/file-explorer/src/config.ts`
- Create: `homeassistant-addons/file-explorer/src/errors.ts`
- Create: `homeassistant-addons/file-explorer/src/roots.ts`
- Create: `homeassistant-addons/file-explorer/src/pathPolicy.ts`
- Create: `homeassistant-addons/file-explorer/test/fixtures.ts`
- Test: `homeassistant-addons/file-explorer/test/pathPolicy.test.ts`

**Interfaces:**

- Produces: `ExplorerConfig`, `RootDefinition`, `AuthorizedPath`, and `EntryMetadata` from `src/types.ts`.
- Produces: `loadConfig(optionsPath, dataDir): Promise<ExplorerConfig>`.
- Produces: `createRootRegistry(config): ReadonlyMap<string, RootDefinition>`.
- Produces: `PathPolicy.authorize(rootId, relativePath, intent): Promise<AuthorizedPath>` where `intent` is `"read" | "write" | "create"`.
- Produces: `DomainError(code, status, message)` with stable error codes.

- [ ] **Step 1: Write the malicious-path corpus and failing policy tests**

```ts
// test/pathPolicy.test.ts
import path from "node:path";
import { symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFixtureRoots } from "./fixtures.js";
import { PathPolicy } from "../src/pathPolicy.js";

const rejectedPaths = [
  "../outside.txt",
  "../../etc/passwd",
  "/etc/passwd",
  "C:\\Windows\\win.ini",
  "%2e%2e/outside.txt",
  "folder/../../../outside.txt",
];

describe("PathPolicy", () => {
  it.each(rejectedPaths)("rejects escaping path %s", async (candidate) => {
    const fixture = await createFixtureRoots();
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    await expect(policy.authorize("config", candidate, "read")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    await fixture.cleanup();
  });

  it("authorizes a regular relative path", async () => {
    const fixture = await createFixtureRoots();
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    const result = await policy.authorize("config", "automations/morning.yaml", "create");
    expect(result.absolutePath).toBe(path.join(fixture.configRoot, "automations", "morning.yaml"));
    await fixture.cleanup();
  });
});
```

- [ ] **Step 2: Run the policy test to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/pathPolicy.test.ts`

Expected: FAIL because the policy and fixture modules do not exist.

- [ ] **Step 3: Define contracts and stable errors**

```ts
// src/types.ts
export type RootId = "config" | "share" | "media";
export type PathIntent = "read" | "write" | "create";

export interface RootDefinition {
  id: RootId;
  label: string;
  absolutePath: string;
  enabled: boolean;
  readOnly: boolean;
}

export interface ExplorerConfig {
  roots: RootDefinition[];
  dataDir: string;
  textEditMaxBytes: number;
  searchFileMaxBytes: number;
  uploadMaxBytes: number;
  searchMaxResults: number;
  searchTimeoutMs: number;
  retentionDays: number;
}

export interface AuthorizedPath {
  root: RootDefinition;
  relativePath: string;
  absolutePath: string;
}

export interface EntryMetadata {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: string;
  signature: string;
}
```

```ts
// src/errors.ts
export type ErrorCode =
  | "PATH_OUTSIDE_ROOT"
  | "ROOT_DISABLED"
  | "NOT_FOUND"
  | "NAME_CONFLICT"
  | "FILE_CHANGED"
  | "TOO_LARGE"
  | "UNSUPPORTED_FILE"
  | "READ_ONLY_ROOT"
  | "SEARCH_LIMIT_REACHED";

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
```

- [ ] **Step 4: Implement root registry, configuration, and canonical authorization**

```ts
// src/roots.ts
import type { ExplorerConfig, RootDefinition } from "./types.js";

export function createRootRegistry(config: ExplorerConfig): ReadonlyMap<string, RootDefinition> {
  return new Map(config.roots.filter((root) => root.enabled).map((root) => [root.id, root]));
}
```

```ts
// src/config.ts
import { readFile } from "node:fs/promises";
import type { ExplorerConfig, RootDefinition, RootId } from "./types.js";

interface RawOptions {
  enable_config?: boolean;
  enable_share?: boolean;
  enable_media?: boolean;
  text_edit_max_bytes?: number;
  search_file_max_bytes?: number;
  upload_max_bytes?: number;
  search_max_results?: number;
  search_timeout_seconds?: number;
  retention_days?: number;
}

export async function loadConfig(optionsPath: string, dataDir: string): Promise<ExplorerConfig> {
  const raw: RawOptions = JSON.parse(await readFile(optionsPath, "utf8"));
  const roots: RootDefinition[] = ([
    ["config", "Config", "/config", raw.enable_config ?? true],
    ["share", "Share", "/share", raw.enable_share ?? true],
    ["media", "Media", "/media", raw.enable_media ?? true],
  ] satisfies Array<[RootId, string, string, boolean]>).map(([id, label, absolutePath, enabled]) => ({
    id, label, absolutePath, enabled, readOnly: false,
  }));
  return {
    roots,
    dataDir,
    textEditMaxBytes: raw.text_edit_max_bytes ?? 1_048_576,
    searchFileMaxBytes: raw.search_file_max_bytes ?? 2_097_152,
    uploadMaxBytes: raw.upload_max_bytes ?? 104_857_600,
    searchMaxResults: raw.search_max_results ?? 500,
    searchTimeoutMs: (raw.search_timeout_seconds ?? 15) * 1_000,
    retentionDays: raw.retention_days ?? 30,
  };
}
```

```ts
// src/pathPolicy.ts
import path from "node:path";
import { realpath } from "node:fs/promises";
import { DomainError } from "./errors.js";
import type { AuthorizedPath, PathIntent, RootDefinition } from "./types.js";

function assertContained(rootReal: string, candidateReal: string): void {
  const relative = path.relative(rootReal, candidateReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path leaves its root");
  }
}

export class PathPolicy {
  constructor(
    private readonly roots: ReadonlyMap<string, RootDefinition>,
    private readonly protectedPaths: readonly string[],
  ) {}

  async authorize(rootId: string, rawPath: string, intent: PathIntent): Promise<AuthorizedPath> {
    const root = this.roots.get(rootId);
    if (!root) throw new DomainError("ROOT_DISABLED", 404, "Root is not enabled");
    if (intent !== "read" && root.readOnly) throw new DomainError("READ_ONLY_ROOT", 403, "Root is read-only");

    const decoded = decodeURIComponent(rawPath.replaceAll("\\", "/"));
    if (decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded)) {
      throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path must be relative");
    }
    const normalized = path.posix.normalize(decoded);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path leaves its root");
    }

    const rootReal = await realpath(root.absolutePath);
    const absolutePath = path.resolve(rootReal, normalized === "." ? "" : normalized);
    assertContained(rootReal, absolutePath);

    if (intent === "create") {
      const parentReal = await realpath(path.dirname(absolutePath));
      assertContained(rootReal, parentReal);
    } else {
      const candidateReal = await realpath(absolutePath).catch(() => {
        throw new DomainError("NOT_FOUND", 404, "Path does not exist");
      });
      assertContained(rootReal, candidateReal);
    }

    if (this.protectedPaths.some((item) => absolutePath === item || absolutePath.startsWith(`${item}${path.sep}`))) {
      throw new DomainError("PATH_OUTSIDE_ROOT", 403, "Protected path is unavailable");
    }
    return { root, relativePath: normalized === "." ? "" : normalized, absolutePath };
  }
}
```

- [ ] **Step 5: Add temporary fixture roots and complete symlink tests**

```ts
// test/fixtures.ts
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { ExplorerConfig } from "../src/types.js";
import { createRootRegistry } from "../src/roots.js";

export async function createFixtureRoots() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ha-file-explorer-"));
  const configRoot = path.join(base, "config");
  const dataDir = path.join(base, "data");
  await mkdir(path.join(configRoot, "automations"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(configRoot, "automations", "morning.yaml"), "alias: Morning\n");
  const config: ExplorerConfig = {
    roots: [{ id: "config", label: "Config", absolutePath: configRoot, enabled: true, readOnly: false }],
    dataDir,
    textEditMaxBytes: 1_048_576,
    searchFileMaxBytes: 2_097_152,
    uploadMaxBytes: 104_857_600,
    searchMaxResults: 500,
    searchTimeoutMs: 15_000,
    retentionDays: 30,
  };
  return {
    base,
    configRoot,
    dataDir,
    registry: createRootRegistry(config),
    protectedPaths: [path.join(dataDir, "trash"), path.join(dataDir, "backups")],
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
```

Add the symlink regression to `pathPolicy.test.ts`:

```ts
it("rejects an existing symlink whose target leaves the root", async () => {
  const fixture = await createFixtureRoots();
  const outside = path.join(fixture.base, "outside.txt");
  await writeFile(outside, "private\n");
  await symlink(outside, path.join(fixture.configRoot, "outside-link"), "file");
  const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
  await expect(policy.authorize("config", "outside-link", "read")).rejects.toMatchObject({
    code: "PATH_OUTSIDE_ROOT",
  });
  await fixture.cleanup();
});
```

For create operations, the policy resolves and validates the existing parent directory so a symlinked parent cannot escape the root.

- [ ] **Step 6: Run policy tests and commit**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/pathPolicy.test.ts && pnpm lint`

Expected: all path-policy tests PASS and TypeScript reports no errors.

```bash
git add homeassistant-addons/file-explorer/src homeassistant-addons/file-explorer/test
git commit -m "feat(file-explorer): enforce root path policy"
```

---

### Task 3: Browse, Read, Metadata, and Download APIs

**Files:**

- Create: `homeassistant-addons/file-explorer/src/filesystem.ts`
- Create: `homeassistant-addons/file-explorer/src/routes/browse.ts`
- Modify: `homeassistant-addons/file-explorer/src/server.ts`
- Test: `homeassistant-addons/file-explorer/test/browse.test.ts`

**Interfaces:**

- Consumes: `PathPolicy.authorize`, `ExplorerConfig`, `EntryMetadata`.
- Produces: `FilesystemService.list`, `stat`, `readText`, and `createReadStream`.
- Produces: `GET /api/roots`, `GET /api/entries`, `GET /api/text`, and `GET /api/download`.

- [ ] **Step 1: Write failing browse API tests**

```ts
// test/browse.test.ts
it("lists roots and directory entries without absolute paths", async () => {
  const response = await request(app).get("/api/entries").query({ root: "config", path: "automations" });
  expect(response.status).toBe(200);
  expect(response.body.entries[0]).toMatchObject({
    name: "morning.yaml",
    path: "automations/morning.yaml",
    type: "file",
  });
  expect(JSON.stringify(response.body)).not.toContain(fixture.base);
});

it("returns bounded text with a conflict signature", async () => {
  const response = await request(app).get("/api/text").query({ root: "config", path: "automations/morning.yaml" });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ content: "alias: Morning\n", encoding: "utf-8" });
  expect(response.body.signature).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/browse.test.ts`

Expected: FAIL with missing browse routes.

- [ ] **Step 3: Implement normalized metadata and bounded reads**

```ts
// src/filesystem.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "./errors.js";
import type { AuthorizedPath, EntryMetadata } from "./types.js";

function signature(size: number, modifiedMs: number): string {
  return createHash("sha256").update(`${size}:${modifiedMs}`).digest("hex");
}

export class FilesystemService {
  async list(target: AuthorizedPath): Promise<EntryMetadata[]> {
    const entries = await readdir(target.absolutePath, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      const absolute = path.join(target.absolutePath, entry.name);
      const details = await stat(absolute);
      return {
        name: entry.name,
        path: path.posix.join(target.relativePath, entry.name),
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        size: details.size,
        modifiedAt: details.mtime.toISOString(),
        signature: signature(details.size, details.mtimeMs),
      };
    }));
  }

  async readText(target: AuthorizedPath, maxBytes: number) {
    const details = await stat(target.absolutePath);
    if (details.size > maxBytes) throw new DomainError("TOO_LARGE", 413, "File exceeds the text-editing limit");
    const content = await readFile(target.absolutePath, "utf8");
    if (content.includes("\u0000")) throw new DomainError("UNSUPPORTED_FILE", 415, "File is not supported text");
    return { content, encoding: "utf-8" as const, signature: signature(details.size, details.mtimeMs) };
  }

  download(target: AuthorizedPath) {
    return createReadStream(target.absolutePath);
  }
}
```

- [ ] **Step 4: Add routes and error middleware**

```ts
// src/routes/browse.ts
router.get("/entries", asyncHandler(async (request, response) => {
  const target = await policy.authorize(String(request.query.root), String(request.query.path ?? ""), "read");
  response.json({ entries: await filesystem.list(target) });
}));

router.get("/text", asyncHandler(async (request, response) => {
  const target = await policy.authorize(String(request.query.root), String(request.query.path), "read");
  response.json(await filesystem.readText(target, config.textEditMaxBytes));
}));

router.get("/download", asyncHandler(async (request, response) => {
  const target = await policy.authorize(String(request.query.root), String(request.query.path), "read");
  response.attachment(path.basename(target.absolutePath));
  filesystem.download(target).pipe(response);
}));
```

Mount the router at `/api` and serialize `DomainError` as `{ error: { code, message } }` with its declared HTTP status.

- [ ] **Step 5: Run browse tests and commit**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/browse.test.ts && pnpm build`

Expected: browse, bounded-read, binary, disabled-root, and download tests PASS.

```bash
git add homeassistant-addons/file-explorer/src homeassistant-addons/file-explorer/test/browse.test.ts
git commit -m "feat(file-explorer): add safe browse APIs"
```

---

### Task 4: Atomic Saves, Backups, Create, Rename, and Move

**Files:**

- Create: `homeassistant-addons/file-explorer/src/safety.ts`
- Create: `homeassistant-addons/file-explorer/src/routes/files.ts`
- Modify: `homeassistant-addons/file-explorer/src/filesystem.ts`
- Modify: `homeassistant-addons/file-explorer/src/server.ts`
- Test: `homeassistant-addons/file-explorer/test/mutations.test.ts`
- Test: `homeassistant-addons/file-explorer/test/safety.test.ts`

**Interfaces:**

- Produces: `SafetyService.backup(target): Promise<BackupRecord>`.
- Produces: `FilesystemService.saveAtomic(target, content, expectedSignature)`.
- Produces: `FilesystemService.createDirectory`, `createFile`, and `move`.
- Produces: `POST /api/files`, `PUT /api/text`, and `POST /api/move`.

- [ ] **Step 1: Write failing save-conflict and backup tests**

```ts
it("backs up the old file before an atomic save", async () => {
  const response = await request(app).put("/api/text").send({
    root: "config",
    path: "automations/morning.yaml",
    content: "alias: Updated\n",
    signature: originalSignature,
  });
  expect(response.status).toBe(200);
  expect(await readFile(filePath, "utf8")).toBe("alias: Updated\n");
  expect(await readFile(response.body.backup.storedPath, "utf8")).toBe("alias: Morning\n");
});

it("refuses to overwrite a file changed externally", async () => {
  await writeFile(filePath, "alias: External\n");
  const response = await request(app).put("/api/text").send({
    root: "config",
    path: "automations/morning.yaml",
    content: "alias: Browser\n",
    signature: originalSignature,
  });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe("FILE_CHANGED");
});
```

- [ ] **Step 2: Run mutation tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/mutations.test.ts test/safety.test.ts`

Expected: FAIL because save, backup, and mutation routes do not exist.

- [ ] **Step 3: Implement backup records and atomic replacement**

```ts
export interface BackupRecord {
  id: string;
  rootId: string;
  originalPath: string;
  storedPath: string;
  createdAt: string;
}

export class SafetyService {
  constructor(private readonly backupDir: string, private readonly trashDir: string) {}

  async backup(target: AuthorizedPath): Promise<BackupRecord> {
    const id = randomUUID();
    const storedPath = path.join(this.backupDir, id);
    await mkdir(this.backupDir, { recursive: true });
    await copyFile(target.absolutePath, storedPath, constants.COPYFILE_EXCL);
    const record = { id, rootId: target.root.id, originalPath: target.relativePath, storedPath, createdAt: new Date().toISOString() };
    await writeFile(`${storedPath}.json`, JSON.stringify(record), { flag: "wx" });
    return record;
  }
}
```

```ts
async saveAtomic(target: AuthorizedPath, content: string, expectedSignature: string, safety: SafetyService) {
  const current = await this.stat(target);
  if (current.signature !== expectedSignature) {
    throw new DomainError("FILE_CHANGED", 409, "File changed after it was opened");
  }
  const backup = await safety.backup(target);
  const temporary = `${target.absolutePath}.file-explorer-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target.absolutePath);
    return { metadata: await this.stat(target), backup };
  } finally {
    await rm(temporary, { force: true });
  }
}
```

- [ ] **Step 4: Implement create and move routes with both paths authorized**

```ts
router.post("/files", asyncHandler(async (request, response) => {
  const target = await policy.authorize(request.body.root, request.body.path, "create");
  const metadata = request.body.type === "directory"
    ? await filesystem.createDirectory(target)
    : await filesystem.createFile(target);
  response.status(201).json({ entry: metadata });
}));

router.post("/move", asyncHandler(async (request, response) => {
  const source = await policy.authorize(request.body.root, request.body.source, "write");
  const target = await policy.authorize(request.body.targetRoot ?? request.body.root, request.body.target, "create");
  response.json({ entry: await filesystem.move(source, target) });
}));
```

The move implementation first tries `rename`; on `EXDEV`, it copies recursively to the target, verifies completion, and removes the source only after success.

- [ ] **Step 5: Run mutation tests and commit**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/mutations.test.ts test/safety.test.ts && pnpm build`

Expected: atomic-save, backup, conflict, create, rename, same-root move, cross-device fallback, and conflict tests PASS.

```bash
git add homeassistant-addons/file-explorer/src homeassistant-addons/file-explorer/test
git commit -m "feat(file-explorer): add backed-up file mutations"
```

---

### Task 5: Streaming Uploads, Trash, Restore, and Purge

**Files:**

- Modify: `homeassistant-addons/file-explorer/src/filesystem.ts`
- Modify: `homeassistant-addons/file-explorer/src/safety.ts`
- Modify: `homeassistant-addons/file-explorer/src/routes/files.ts`
- Create: `homeassistant-addons/file-explorer/src/routes/trash.ts`
- Test: `homeassistant-addons/file-explorer/test/uploads.test.ts`
- Modify: `homeassistant-addons/file-explorer/test/safety.test.ts`

**Interfaces:**

- Produces: `PUT /api/upload?root=&path=` streaming request bodies to a temporary sibling.
- Produces: `SafetyService.trash`, `listTrash`, `restore`, and `purge`.
- Produces: `DELETE /api/files`, `GET /api/trash`, `POST /api/trash/:id/restore`, and `DELETE /api/trash/:id`.

- [ ] **Step 1: Write failing upload and trash lifecycle tests**

```ts
it("streams an upload and removes temporary data on failure", async () => {
  const response = await request(app)
    .put("/api/upload?root=config&path=uploads/demo.bin")
    .set("content-type", "application/octet-stream")
    .send(Buffer.from([1, 2, 3, 4]));
  expect(response.status).toBe(201);
  expect(await readFile(path.join(fixture.configRoot, "uploads", "demo.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));
});

it("moves a file to trash and restores it", async () => {
  const removed = await request(app).delete("/api/files").send({ root: "config", path: "automations/morning.yaml" });
  expect(removed.status).toBe(200);
  expect(await pathExists(filePath)).toBe(false);
  const restored = await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({});
  expect(restored.status).toBe(200);
  expect(await readFile(filePath, "utf8")).toBe("alias: Morning\n");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/uploads.test.ts test/safety.test.ts`

Expected: FAIL with missing upload and trash endpoints.

- [ ] **Step 3: Implement bounded streaming uploads**

```ts
router.put("/upload", asyncHandler(async (request, response) => {
  const target = await policy.authorize(String(request.query.root), String(request.query.path), "create");
  const entry = await filesystem.receiveUpload(target, request, config.uploadMaxBytes);
  response.status(201).json({ entry });
}));
```

`receiveUpload` writes to a random temporary sibling through `pipeline`, counts bytes in a `Transform`, raises `TOO_LARGE` at the configured limit, atomically renames on success, and removes the temporary file in `finally`.

- [ ] **Step 4: Implement trash manifests and restore conflict handling**

```ts
export interface TrashRecord {
  id: string;
  rootId: string;
  originalPath: string;
  storedPath: string;
  entryType: "file" | "directory";
  deletedAt: string;
}

async trash(target: AuthorizedPath): Promise<TrashRecord> {
  const id = randomUUID();
  const storedPath = path.join(this.trashDir, id, "item");
  await mkdir(path.dirname(storedPath), { recursive: true });
  await rename(target.absolutePath, storedPath);
  const details = await stat(storedPath);
  const record: TrashRecord = {
    id,
    rootId: target.root.id,
    originalPath: target.relativePath,
    storedPath,
    entryType: details.isDirectory() ? "directory" : "file",
    deletedAt: new Date().toISOString(),
  };
  await writeFile(path.join(this.trashDir, id, "manifest.json"), JSON.stringify(record), { flag: "wx" });
  return record;
}
```

Restore authorizes the manifest destination through `PathPolicy`; an occupied destination returns `NAME_CONFLICT` unless the request supplies an alternate relative path. Purge removes only the selected trash-record directory.

- [ ] **Step 5: Add retention cleanup and run tests**

At startup and once every 24 hours, purge backup and trash records older than `retentionDays`. Log individual failures and continue processing other records.

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/uploads.test.ts test/safety.test.ts`

Expected: upload size, cleanup, trash, restore, alternate-name restore, purge, and retention tests PASS.

- [ ] **Step 6: Commit safe destructive operations**

```bash
git add homeassistant-addons/file-explorer/src homeassistant-addons/file-explorer/test
git commit -m "feat(file-explorer): add uploads and recoverable deletion"
```

---

### Task 6: Bounded Name and Text Search

**Files:**

- Create: `homeassistant-addons/file-explorer/src/search.ts`
- Create: `homeassistant-addons/file-explorer/src/routes/search.ts`
- Modify: `homeassistant-addons/file-explorer/src/server.ts`
- Test: `homeassistant-addons/file-explorer/test/search.test.ts`

**Interfaces:**

- Produces: `SearchService.search({ target, query, signal }): Promise<SearchResponse>`.
- Produces: `GET /api/search?root=&path=&q=` returning `{ results, truncated, failures }`.

- [ ] **Step 1: Write failing search behavior tests**

```ts
it("matches names and bounded text content", async () => {
  const response = await request(app).get("/api/search").query({ root: "config", path: "", q: "morning" });
  expect(response.status).toBe(200);
  expect(response.body.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "automations/morning.yaml", matchedBy: "name" }),
    expect.objectContaining({ path: "scripts/day.yaml", matchedBy: "content" }),
  ]));
});

it("skips binary files and protected storage", async () => {
  const response = await request(app).get("/api/search").query({ root: "config", path: "", q: "secret-marker" });
  expect(response.body.results).toEqual([]);
});
```

- [ ] **Step 2: Run search tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/search.test.ts`

Expected: FAIL because the search service and route do not exist.

- [ ] **Step 3: Implement cancellable bounded traversal**

```ts
export interface SearchResult {
  path: string;
  type: "file" | "directory";
  matchedBy: "name" | "content";
  excerpt?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
  failures: Array<{ path: string; message: string }>;
}

async search(input: { target: AuthorizedPath; query: string; signal: AbortSignal }): Promise<SearchResponse> {
  const deadline = Date.now() + this.config.searchTimeoutMs;
  const results: SearchResult[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  const queue = [input.target.absolutePath];
  while (queue.length > 0 && results.length < this.config.searchMaxResults && Date.now() < deadline) {
    input.signal.throwIfAborted();
    const current = queue.shift()!;
    try {
      await this.inspectPath(current, input.target, input.query, queue, results);
    } catch (error) {
      failures.push({ path: this.relativePath(input.target, current), message: error instanceof Error ? error.message : "Read failed" });
    }
  }
  return { results, truncated: queue.length > 0, failures };
}
```

`inspectPath` skips protected/ignored paths, does not follow symlink directories, tests filename first, and reads content only when a regular file is no larger than `searchFileMaxBytes` and its first chunk contains no NUL byte.

- [ ] **Step 4: Connect HTTP aborts and run tests**

```ts
router.get("/search", asyncHandler(async (request, response) => {
  const controller = new AbortController();
  request.once("close", () => controller.abort());
  const target = await policy.authorize(String(request.query.root), String(request.query.path ?? ""), "read");
  const result = await search.search({ target, query: String(request.query.q ?? "").trim(), signal: controller.signal });
  response.json(result);
}));
```

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/search.test.ts`

Expected: name, content, binary, ignored-path, result-cap, timeout, cancellation, and partial-failure tests PASS.

- [ ] **Step 5: Commit search**

```bash
git add homeassistant-addons/file-explorer/src homeassistant-addons/file-explorer/test/search.test.ts
git commit -m "feat(file-explorer): add bounded content search"
```

---

### Task 7: Adaptive Application Shell and Tree Navigation

**Files:**

- Create: `homeassistant-addons/file-explorer/public/api.js`
- Create: `homeassistant-addons/file-explorer/public/tree.js`
- Create: `homeassistant-addons/file-explorer/public/app.js`
- Create: `homeassistant-addons/file-explorer/public/styles.css`
- Modify: `homeassistant-addons/file-explorer/public/index.html`
- Create: `homeassistant-addons/file-explorer/test/ui.test.ts`

**Interfaces:**

- Produces: `api.request(relativePath, options)` preserving arbitrary ingress prefixes through relative URLs.
- Produces: `createExplorerState(api)` with `roots`, `selectedRoot`, `selectedPath`, `entries`, `expanded`, and `loadDirectory`.
- Produces: keyboard-accessible tree DOM with `role="tree"` and `role="treeitem"`.

- [ ] **Step 1: Write failing ingress URL and tree-state tests**

```ts
// test/ui.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../public/api.js";
import { createExplorerState } from "../public/tree.js";

it("uses ingress-relative API URLs", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  await createApi(fetcher).request("api/health");
  expect(fetcher).toHaveBeenCalledWith("./api/health", expect.any(Object));
});

it("loads a selected root directory", async () => {
  const api = { request: vi.fn().mockResolvedValue({ entries: [{ name: "automations", path: "automations", type: "directory" }] }) };
  const state = createExplorerState(api);
  await state.loadDirectory("config", "");
  expect(state.selectedRoot).toBe("config");
  expect(state.entries.get("config:")?.[0].name).toBe("automations");
});
```

- [ ] **Step 2: Run UI tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/ui.test.ts`

Expected: FAIL because client modules do not exist.

- [ ] **Step 3: Implement the relative API client and state model**

```js
// public/api.js
export function createApi(fetcher = globalThis.fetch.bind(globalThis)) {
  return {
    async request(relativePath, options = {}) {
      const response = await fetcher(`./${relativePath.replace(/^\/+/, "")}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : response;
      if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "Request failed"), body?.error);
      return body;
    },
  };
}
```

```js
// public/tree.js
export function createExplorerState(api) {
  return {
    roots: [], selectedRoot: null, selectedPath: "", entries: new Map(), expanded: new Set(),
    async loadDirectory(root, path) {
      const result = await api.request(`api/entries?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      this.selectedRoot = root;
      this.selectedPath = path;
      this.entries.set(`${root}:${path}`, result.entries);
      return result.entries;
    },
  };
}
```

- [ ] **Step 4: Build the adaptive shell and Home Assistant theme CSS**

```css
:root {
  color-scheme: light dark;
  --fe-bg: var(--primary-background-color, #fafafa);
  --fe-surface: var(--card-background-color, #fff);
  --fe-text: var(--primary-text-color, #212121);
  --fe-muted: var(--secondary-text-color, #727272);
  --fe-divider: var(--divider-color, #e0e0e0);
  --fe-accent: var(--primary-color, #03a9f4);
  --fe-error: var(--error-color, #db4437);
}
body { margin: 0; background: var(--fe-bg); color: var(--fe-text); font: 14px system-ui, sans-serif; }
.explorer { display: grid; grid-template-columns: minmax(240px, 34%) 1fr; min-height: 100vh; }
.tree-pane { border-right: 1px solid var(--fe-divider); background: var(--fe-surface); }
.content-pane { min-width: 0; }
:focus-visible { outline: 2px solid var(--fe-accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .explorer { grid-template-columns: 1fr; }
  .tree-pane { position: fixed; inset: 0 15% 0 0; z-index: 10; transform: translateX(-105%); }
  .tree-pane[data-open="true"] { transform: translateX(0); }
}
```

Render root tabs, toolbar, tree items, empty content state, live notification region, and the mobile tree toggle. Keep icon assets local and label icon-only buttons with `aria-label`.

- [ ] **Step 5: Test navigation and commit**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/ui.test.ts`

Expected: ingress-relative request, root switching, expanded state, selection, Arrow key navigation, Enter activation, and mobile drawer tests PASS.

```bash
git add homeassistant-addons/file-explorer/public homeassistant-addons/file-explorer/test/ui.test.ts
git commit -m "feat(file-explorer): add adaptive file tree shell"
```

---

### Task 8: Editor, Previews, Commands, Search, and Trash UI

**Files:**

- Create: `homeassistant-addons/file-explorer/public/editor.js`
- Create: `homeassistant-addons/file-explorer/public/operations.js`
- Modify: `homeassistant-addons/file-explorer/public/app.js`
- Modify: `homeassistant-addons/file-explorer/public/styles.css`
- Modify: `homeassistant-addons/file-explorer/test/ui.test.ts`

**Interfaces:**

- Produces: `createEditorState(api)` with `open`, `update`, `save`, `discard`, and `dirty`.
- Produces: `createOperations(api)` with create, move, upload, search, trash, restore, and purge methods.
- Consumes all API endpoints from Tasks 3–6.

- [ ] **Step 1: Write failing dirty-state and conflict tests**

```ts
it("marks edited text dirty and preserves it on a save conflict", async () => {
  const api = {
    request: vi.fn()
      .mockResolvedValueOnce({ content: "alias: Morning\n", signature: "sig-1" })
      .mockRejectedValueOnce(Object.assign(new Error("Changed"), { code: "FILE_CHANGED" })),
  };
  const editor = createEditorState(api);
  await editor.open("config", "automations/morning.yaml");
  editor.update("alias: Updated\n");
  expect(editor.dirty).toBe(true);
  await expect(editor.save()).rejects.toMatchObject({ code: "FILE_CHANGED" });
  expect(editor.content).toBe("alias: Updated\n");
  expect(editor.dirty).toBe(true);
});

it("requires explicit confirmation before permanent purge", async () => {
  const api = { request: vi.fn() };
  const operations = createOperations(api);
  await operations.purge("trash-1", false);
  expect(api.request).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run UI tests to verify failure**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/ui.test.ts`

Expected: FAIL because editor and operations modules do not exist.

- [ ] **Step 3: Implement simple editor state and conflict preservation**

```js
// public/editor.js
export function createEditorState(api) {
  return {
    root: null, path: null, content: "", original: "", signature: null, error: null,
    get dirty() { return this.content !== this.original; },
    async open(root, path) {
      if (this.dirty) throw Object.assign(new Error("Unsaved changes"), { code: "UNSAVED_CHANGES" });
      const file = await api.request(`api/text?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      Object.assign(this, { root, path, content: file.content, original: file.content, signature: file.signature, error: null });
    },
    update(content) { this.content = content; },
    discard() { this.content = this.original; this.error = null; },
    async save() {
      try {
        const result = await api.request("api/text", {
          method: "PUT",
          body: JSON.stringify({ root: this.root, path: this.path, content: this.content, signature: this.signature }),
        });
        this.original = this.content;
        this.signature = result.entry.signature;
        return result;
      } catch (error) {
        this.error = error;
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Implement operations and explicit destructive actions**

```js
// public/operations.js
export function createOperations(api) {
  return {
    create(root, path, type) { return api.request("api/files", { method: "POST", body: JSON.stringify({ root, path, type }) }); },
    move(root, source, target, targetRoot = root) { return api.request("api/move", { method: "POST", body: JSON.stringify({ root, source, target, targetRoot }) }); },
    trash(root, path) { return api.request("api/files", { method: "DELETE", body: JSON.stringify({ root, path }) }); },
    restore(id, alternatePath) { return api.request(`api/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ alternatePath }) }); },
    purge(id, confirmed) {
      if (!confirmed) return Promise.resolve({ cancelled: true });
      return api.request(`api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    search(root, path, query, signal) {
      return api.request(`api/search?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`, { signal });
    },
  };
}
```

Use `XMLHttpRequest` or fetch request streams supported by the target browser for upload progress; keep upload destination authorization on the server. Render image/audio/video previews only for supported MIME types and use the download endpoint for all other files.

- [ ] **Step 5: Wire dialogs, status, search cancellation, and responsive editor**

The application shell must render:

```html
<section class="content-pane" aria-label="File content">
  <header class="content-toolbar">
    <strong data-file-name></strong>
    <span data-dirty hidden>Unsaved</span>
    <button type="button" data-download>Download</button>
    <button type="button" data-save>Save</button>
  </header>
  <textarea data-editor aria-label="File content editor" spellcheck="false"></textarea>
  <div data-preview hidden></div>
  <footer aria-live="polite" data-file-status></footer>
</section>
```

Changing search query or root aborts the previous `AbortController`. Opening another file while dirty opens a save/discard/cancel dialog. `FILE_CHANGED` opens reload/save-as actions without clearing browser text. `NAME_CONFLICT` offers alternate naming. Permanent purge requires typed or explicit confirmation.

- [ ] **Step 6: Run UI tests and commit**

Run: `cd homeassistant-addons/file-explorer && pnpm test -- test/ui.test.ts`

Expected: editor, dirty state, save, conflict preservation, create, move, search cancellation, trash, restore conflict, purge confirmation, preview, keyboard focus, and mobile pane tests PASS.

```bash
git add homeassistant-addons/file-explorer/public homeassistant-addons/file-explorer/test/ui.test.ts
git commit -m "feat(file-explorer): complete file management interface"
```

---

### Task 9: Security Regression, End-to-End Smoke Test, Docker, and Documentation

**Files:**

- Create: `homeassistant-addons/file-explorer/test/securityRoutes.test.ts`
- Create: `homeassistant-addons/file-explorer/test/smoke.test.ts`
- Create: `homeassistant-addons/file-explorer/README.md`

**Interfaces:**

- Consumes every filesystem endpoint and the shared malicious-path corpus.
- Produces a documented installation and manual Home Assistant verification procedure.
- Produces a reproducible add-on image build.

- [ ] **Step 1: Apply the malicious corpus to every route**

```ts
const routeCases = [
  { method: "get", url: (pathValue) => `/api/entries?root=config&path=${encodeURIComponent(pathValue)}` },
  { method: "get", url: (pathValue) => `/api/text?root=config&path=${encodeURIComponent(pathValue)}` },
  { method: "get", url: (pathValue) => `/api/download?root=config&path=${encodeURIComponent(pathValue)}` },
  { method: "delete", url: () => "/api/files", body: (pathValue) => ({ root: "config", path: pathValue }) },
  { method: "post", url: () => "/api/files", body: (pathValue) => ({ root: "config", path: pathValue, type: "file" }) },
  { method: "post", url: () => "/api/move", body: (pathValue) => ({ root: "config", source: "safe.txt", target: pathValue }) },
];

for (const routeCase of routeCases) {
  it.each(rejectedPaths)(`rejects %s through ${routeCase.method}`, async (candidate) => {
    const call = request(app)[routeCase.method](routeCase.url(candidate));
    const response = routeCase.body ? await call.send(routeCase.body(candidate)) : await call;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe("PATH_OUTSIDE_ROOT");
  });
}
```

- [ ] **Step 2: Write the full temporary-root smoke workflow**

```ts
it("completes the v1 file lifecycle", async () => {
  await request(app).post("/api/files").send({ root: "config", path: "notes", type: "directory" }).expect(201);
  await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" }).expect(201);
  const opened = await request(app).get("/api/text").query({ root: "config", path: "notes/home.txt" }).expect(200);
  await request(app).put("/api/text").send({ root: "config", path: "notes/home.txt", content: "kitchen morning", signature: opened.body.signature }).expect(200);
  await request(app).post("/api/move").send({ root: "config", source: "notes/home.txt", target: "notes/routine.txt" }).expect(200);
  const search = await request(app).get("/api/search").query({ root: "config", path: "", q: "morning" }).expect(200);
  expect(search.body.results[0].path).toBe("notes/routine.txt");
  const removed = await request(app).delete("/api/files").send({ root: "config", path: "notes/routine.txt" }).expect(200);
  await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({}).expect(200);
  await request(app).get("/api/download").query({ root: "config", path: "notes/routine.txt" }).expect(200, "kitchen morning");
});
```

- [ ] **Step 3: Run the complete automated verification**

Run: `cd homeassistant-addons/file-explorer && pnpm lint && pnpm test && pnpm build`

Expected: TypeScript exits successfully, all tests PASS, and `dist/server.js` exists.

- [ ] **Step 4: Build and inspect the Docker image**

Run: `docker build -t ha-file-explorer:test homeassistant-addons/file-explorer`

Expected: image builds successfully with no runtime dev dependencies.

Run: `docker run --rm -d --name ha-file-explorer-test -p 8091:8091 -v "$(mktemp -d):/config" -v "$(mktemp -d):/share" -v "$(mktemp -d):/media" ha-file-explorer:test`

Expected: `curl http://127.0.0.1:8091/api/health` returns `{"ok":true,"service":"file-explorer"}`. Stop with `docker stop ha-file-explorer-test`.

- [ ] **Step 5: Document installation, options, recovery, and manual checks**

```markdown
# File Explorer

File Explorer is an administrator-only Home Assistant ingress add-on for `/config`, `/share`, and `/media`.

## Safety

All browser paths are relative to an enabled root. Existing text files are backed up before save. Delete moves items to recoverable trash; permanent purge requires confirmation.

## Manual verification

1. Install and start the add-on.
2. Confirm only an administrator can open the sidebar panel.
3. Toggle each root option and confirm disabled roots disappear.
4. Complete create, edit, upload, rename, move, search, delete, restore, and download operations.
5. Change a file outside the editor and confirm stale save is refused.
6. Verify both Home Assistant light and dark themes.
7. Verify the tree slide-over and editor on a narrow mobile viewport.
8. Confirm assets and API calls work through the full ingress URL prefix.
```

No repository-level synchronization change is required: `scripts/sync-addon.mjs` is intentionally scoped to `discord-pi-bot`, and `homeassistant-addons/repository.yaml` does not enumerate add-ons.

- [ ] **Step 6: Run final repository checks**

Run: `pnpm --dir homeassistant-addons/file-explorer lint && pnpm --dir homeassistant-addons/file-explorer test && pnpm --dir homeassistant-addons/file-explorer build`

Expected: all commands exit 0.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Commit the completed add-on**

```bash
git add homeassistant-addons/file-explorer
git commit -m "test(file-explorer): verify add-on lifecycle and packaging"
```

## Final Manual Acceptance

- [ ] Install the local repository in Home Assistant and start File Explorer.
- [ ] Verify the sidebar entry is visible to an administrator and unavailable to a non-administrator.
- [ ] Verify `/config`, `/share`, and `/media` independently follow their enable options.
- [ ] Repeat the full lifecycle smoke workflow through the browser.
- [ ] Verify save conflict recovery does not lose browser text.
- [ ] Verify trash restore and backup artifacts survive an add-on restart.
- [ ] Verify arbitrary ingress prefixes, desktop, mobile, keyboard navigation, and Home Assistant light/dark themes.
