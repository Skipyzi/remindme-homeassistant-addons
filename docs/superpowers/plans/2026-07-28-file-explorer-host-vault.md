# File Explorer Host Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an encrypted, read-only, idle-locking SSHFS vault that exposes actual Home Assistant OS `/` as a Host root.

**Architecture:** Built-in Node crypto protects a dedicated SSH key at rest. An injectable SSHFS adapter verifies the pinned host key and owns the FUSE child/mount; `HostVaultService` owns setup, lockout, one token, idle expiry, and cleanup. A request guard authorizes Host reads before the existing filesystem APIs, while storage jobs carry the owning vault session and support subtree-specific limits/exclusions.

**Tech Stack:** Node.js 22 crypto/child_process/fs, TypeScript 5.9, Express 5, SSHFS/FUSE 3/OpenSSH client, browser ES modules, Vitest/Supertest/jsdom, pnpm 11.

## Global Constraints

- Host is read-only in UI and backend.
- Dedicated unencrypted OpenSSH private key is encrypted at rest with scrypt `N=32768`, `r=8`, `p=1`, `maxmem=64 MiB`, 32-byte derived key, and AES-256-GCM.
- Passphrase, plaintext key, token, raw stderr, and `/host/...` paths never persist or appear in responses/logs.
- Verify SHA-256 host fingerprint before every mount and use strict known-host checking.
- One 256-bit token, stored only in browser `sessionStorage`; 15 minutes idle.
- Five failed unlocks trigger timed lockout.
- Mount remote `/` at `/host` read-only; local roots remain usable while locked.
- Whole Host scans exclude recursive `/proc`, `/sys`, `/dev`, and `/run` sizes but keep them browsable.
- Host defaults: 1,000,000 entries, 600 seconds, 300-second cache, 10,000 nodes.
- Use `homeassistant_config` mapped explicitly to `/config`.
- Request `/dev/fuse` and `SYS_ADMIN`; never set `full_access`.
- Release File Explorer `0.3.0` and update PR #30.

---

### Task 1: Encrypt and persist vault configuration

**Files:**
- Create: `file-explorer/src/hostVaultTypes.ts`
- Create: `file-explorer/src/hostVaultCrypto.ts`
- Create: `file-explorer/src/hostVaultStore.ts`
- Create: `file-explorer/test/hostVaultCrypto.test.ts`
- Create: `file-explorer/test/hostVaultStore.test.ts`

**Interfaces:**
- `encryptPrivateKey(privateKey, passphrase, metadata): Promise<EncryptedVault>`
- `decryptPrivateKey(vault, passphrase): Promise<Buffer>`
- `HostVaultStore.read/write/remove`

- [ ] **Step 1: Write failing crypto tests**

Assert round trip, randomized ciphertext, wrong passphrase, tampered metadata/tag, and secret absence:

```ts
const first = await encryptPrivateKey(KEY, "vault phrase", metadata);
const second = await encryptPrivateKey(KEY, "vault phrase", metadata);
expect(first.ciphertext).not.toBe(second.ciphertext);
await expect(decryptPrivateKey(first, "vault phrase")).resolves.toEqual(Buffer.from(KEY));
await expect(decryptPrivateKey(first, "wrong")).rejects.toMatchObject({ code: "INVALID_VAULT_PASSPHRASE" });
expect(JSON.stringify(first)).not.toContain(KEY);
expect(JSON.stringify(first)).not.toContain("vault phrase");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/hostVaultCrypto.test.ts`

Expected: crypto module is missing.

- [ ] **Step 3: Implement exact encrypted schema**

Define:

```ts
export interface HostConnectionMetadata {
  host: string;
  port: number;
  username: string;
  fingerprint: string;
}

export interface EncryptedVault extends HostConnectionMetadata {
  version: 1;
  kdf: { name: "scrypt"; N: 32768; r: 8; p: 1; maxmem: 67108864 };
  salt: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}
```

Use random 16-byte salt and 12-byte nonce. Canonically serialize metadata/version/KDF as GCM additional authenticated data. Normalize fingerprint to `SHA256:<base64>` and reject blank/weak passphrases before crypto.

- [ ] **Step 4: Write failing atomic-store tests**

Use a temporary directory; assert final JSON mode `0600`, valid read, atomic replacement, and remove. Inject a write failure before rename and assert the old vault remains intact and no plaintext exists.

- [ ] **Step 5: Implement `HostVaultStore`**

Write JSON to a mode-`0600` sibling temporary file, `sync`, close, rename, and remove the temporary in `finally`. Validate schema/version/KDF/base64 fields on read and return a safe `INVALID_VAULT_CONFIG` error.

- [ ] **Step 6: Verify and commit**

```sh
pnpm vitest run test/hostVaultCrypto.test.ts test/hostVaultStore.test.ts
pnpm lint
```

```sh
git add file-explorer/src/hostVaultTypes.ts file-explorer/src/hostVaultCrypto.ts file-explorer/src/hostVaultStore.ts file-explorer/test/hostVaultCrypto.test.ts file-explorer/test/hostVaultStore.test.ts
git commit -m "feat(file-explorer): encrypt host vault credentials"
```

---

### Task 2: Verify host identity and manage SSHFS

**Files:**
- Create: `file-explorer/src/sshfsMount.ts`
- Create: `file-explorer/test/sshfsMount.test.ts`
- Modify: `file-explorer/src/errors.ts`

**Interfaces:**
- `SshfsMountAdapter.verifyHost(metadata, runtimeDir): Promise<string>`
- `SshfsMountAdapter.mount(metadata, keyPath, knownHostsPath, mountPath): Promise<MountHandle>`
- `MountHandle.unmount(): Promise<void>` and `isAlive(): boolean`

- [ ] **Step 1: Write failing command-adapter tests**

Inject fake `execFile`, `spawn`, `/dev/fuse` access, and mount checks. Assert:

```ts
expect(execFile).toHaveBeenCalledWith("ssh-keyscan", ["-p", "22222", "172.30.32.1"], expect.any(Object));
expect(spawn).toHaveBeenCalledWith("sshfs", expect.arrayContaining([
  "root@172.30.32.1:/", "/host", "-o", "ro", "-o", "StrictHostKeyChecking=yes",
  "-o", expect.stringContaining("IdentityFile="),
  "-o", expect.stringContaining("UserKnownHostsFile="),
  "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
]), expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }));
```

Assert fingerprint mismatch, missing FUSE, early child exit, mount timeout, normal unmount, bounded escalation, and stderr sanitization.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/sshfsMount.test.ts`

Expected: adapter is missing.

- [ ] **Step 3: Implement fingerprint verification**

Run `ssh-keyscan` with timeout/output limits, write candidate known-host line under runtime dir, run `ssh-keygen -lf ... -E sha256`, parse exact `SHA256:` token, normalize and compare using `timingSafeEqual`. Never trust/store a candidate key when mismatch occurs.

- [ ] **Step 4: Implement mount lifecycle**

Check `/dev/fuse`, create mountpoint/runtime directory, spawn SSHFS with exact read-only/strict options plus `reconnect`, `ServerAliveInterval=15`, and `ServerAliveCountMax=3`. Poll `/proc/self/mountinfo` for the exact mountpoint with a 15-second deadline. Capture at most 8 KiB stderr and map known failures to safe codes:

- `FUSE_UNAVAILABLE`
- `HOST_KEY_MISMATCH`
- `SSH_UNAVAILABLE`
- `HOST_MOUNT_FAILED`

Unmount with `fusermount3 -u`; after bounded failure use `fusermount3 -u -z`, then terminate/wait for child.

- [ ] **Step 5: Verify and commit**

```sh
pnpm vitest run test/sshfsMount.test.ts
pnpm lint
```

```sh
git add file-explorer/src/sshfsMount.ts file-explorer/src/errors.ts file-explorer/test/sshfsMount.test.ts
git commit -m "feat(file-explorer): manage read-only SSHFS mount"
```

---

### Task 3: Implement vault setup, unlock, lockout, and idle lifecycle

**Files:**
- Create: `file-explorer/src/hostVaultService.ts`
- Create: `file-explorer/test/hostVaultService.test.ts`
- Modify: `file-explorer/src/hostVaultTypes.ts`

**Interfaces:**
- `status(token?): HostVaultStatus`
- `setup(input): Promise<void>`
- `unlock(passphrase): Promise<{ token: string; expiresAt: string }>`
- `authorize(token): HostVaultSession`
- `touch(token): void`
- `lock(token?): Promise<void>`
- `reset(confirmation): Promise<void>`
- `onLock(callback): unsubscribe`
- `dispose(): Promise<void>`

- [ ] **Step 1: Write failing lifecycle tests**

Use fake store/crypto/mount/clock/token generator. Cover:

- setup validates confirmation/key/metadata, mount-tests, unmounts, then persists;
- setup failure persists nothing;
- unlock decrypts, writes mode-`0600` runtime key, mounts, and returns token;
- second unlock locks/invalidate previous token;
- wrong passphrase increments failures;
- fifth failure sets lockout and blocks decryption until clock advances;
- valid `authorize/touch` moves expiry to now + 15 minutes;
- local operations cannot call `touch` through this API;
- idle timer invokes lock callbacks, unmounts, removes runtime directory;
- manual lock and dispose perform identical cleanup;
- exact reset phrase required and reset locks first.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/hostVaultService.test.ts`

Expected: service is missing.

- [ ] **Step 3: Implement state machine**

Use states `unconfigured`, `locked`, `unlocking`, `unlocked`, `locking`, `error`. Serialize setup/unlock/lock through one promise queue so mount and cleanup cannot overlap. Keep token/passphrase/plaintext key only in local memory. Write temporary key with `open(..., 0o600)` and remove the entire runtime directory recursively on every exit path.

Use five failures and a 60-second lockout. Idle deadline is exactly 900,000 ms after each successful Host authorization. A 5-second unref'd timer checks expiry. `status` reveals safe metadata and lockout duration but no secret fields.

- [ ] **Step 4: Verify and commit**

```sh
pnpm vitest run test/hostVaultService.test.ts test/hostVaultCrypto.test.ts test/sshfsMount.test.ts
pnpm lint
```

```sh
git add file-explorer/src/hostVaultService.ts file-explorer/src/hostVaultTypes.ts file-explorer/test/hostVaultService.test.ts
git commit -m "feat(file-explorer): manage host vault sessions"
```

---

### Task 4: Expose safe Host Vault APIs

**Files:**
- Create: `file-explorer/src/routes/hostVault.ts`
- Create: `file-explorer/test/hostVaultRoutes.test.ts`
- Modify: `file-explorer/src/server.ts`

**Interfaces:**
- `GET /api/host-vault/status`
- `POST /api/host-vault/setup`
- `POST /api/host-vault/unlock`
- `POST /api/host-vault/lock`
- `DELETE /api/host-vault`

- [ ] **Step 1: Write failing route tests**

Assert safe status, setup validation, unlock token, lock header, reset phrase, lockout HTTP 429, and no secret reflection. Include a private key/passphrase marker and assert neither appears in any response or captured logger call.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/hostVaultRoutes.test.ts`

Expected: routes return 404/405.

- [ ] **Step 3: Implement router**

Validate exact field types/lengths before service calls. Read token from `X-File-Explorer-Vault`; never body/query. Return setup 204, unlock 200, lock 204, reset 204. Map typed service errors to stable status codes through `DomainError`; add `Retry-After` for lockout.

Construct service in `createConfiguredApp()` using:

- encrypted store under `${dataDir}/host-vault.json`;
- runtime directory `/run/file-explorer-host`;
- mountpoint `/host`;
- concrete SSHFS adapter.

Register shutdown handlers for SIGTERM/SIGINT that await `dispose` before exiting.

- [ ] **Step 4: Verify and commit**

```sh
pnpm vitest run test/hostVaultRoutes.test.ts test/server.test.ts
pnpm test
```

```sh
git add file-explorer/src/routes/hostVault.ts file-explorer/src/server.ts file-explorer/test/hostVaultRoutes.test.ts
git commit -m "feat(file-explorer): expose host vault API"
```

---

### Task 5: Add token-gated read-only Host root

**Files:**
- Modify: `file-explorer/src/types.ts`
- Modify: `file-explorer/src/config.ts`
- Modify: `file-explorer/src/roots.ts`
- Modify: `file-explorer/src/pathPolicy.ts`
- Create: `file-explorer/src/hostRequestGuard.ts`
- Modify: `file-explorer/src/server.ts`
- Modify: `file-explorer/src/routes/browse.ts`
- Modify: `file-explorer/src/routes/search.ts`
- Modify: `file-explorer/src/routes/files.ts`
- Modify: `file-explorer/src/routes/trash.ts`
- Create: `file-explorer/test/hostAuthorization.test.ts`

**Interfaces:**
- Extends `RootId` with `host`
- Adds locked root metadata `{ id: "host", label: "Host /", readOnly: true, locked: boolean }`
- Adds request-local authorized vault session

- [ ] **Step 1: Write failing authorization matrix**

Using a fake unlocked vault and mounted `/host` fixture, assert:

- roots lists locked Host safely without token;
- local reads work locked;
- Host read without/wrong token returns 401;
- correct token lists/reads/downloads/searches Host;
- Host response paths begin `/` for display and never contain local mount path;
- every create/upload/text/move/trash/restore mutation targeting Host returns 403 `READ_ONLY_ROOT` even with token;
- expired token returns 401 and does not touch filesystem.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/hostAuthorization.test.ts`

Expected: Host root does not exist.

- [ ] **Step 3: Add dynamic Host root and guard**

Keep local registry static. Add a root provider that returns Host definition only for authorization while mounted and a public locked descriptor always. `hostRequestGuard` identifies Host from query/body `root`/`targetRoot`, validates the header before routers, and stores the session token in `response.locals.hostVaultToken`. Never infer authorization from mount existence alone.

Path policy must reject Host mutation intent before `realpath`; read intent uses `/host`, normalizes paths, and returns display-relative path without exposing mountpoint. Filesystem metadata uses existing relative paths; browser formatting prepends `/` for Host.

- [ ] **Step 4: Gate streams and aborted requests**

Authorize before creating download streams. Touch idle only after successful authorization. If the request aborts, destroy download streams/search controllers without extending idle again.

- [ ] **Step 5: Verify and commit**

```sh
pnpm vitest run test/hostAuthorization.test.ts test/securityRoutes.test.ts test/pathPolicy.test.ts
pnpm test
pnpm lint
```

```sh
git add file-explorer/src/types.ts file-explorer/src/config.ts file-explorer/src/roots.ts file-explorer/src/pathPolicy.ts file-explorer/src/hostRequestGuard.ts file-explorer/src/server.ts file-explorer/src/routes/browse.ts file-explorer/src/routes/search.ts file-explorer/src/routes/files.ts file-explorer/src/routes/trash.ts file-explorer/test/hostAuthorization.test.ts
git commit -m "feat(file-explorer): add read-only Host root"
```

---

### Task 6: Add subtree scans, Host ownership, limits, and exclusions

**Files:**
- Modify: `file-explorer/src/types.ts`
- Modify: `file-explorer/src/storageTypes.ts`
- Modify: `file-explorer/src/storageScanner.ts`
- Modify: `file-explorer/src/storageScanService.ts`
- Modify: `file-explorer/src/routes/storageMap.ts`
- Modify: `file-explorer/test/config.test.ts`
- Modify: `file-explorer/test/storageScanner.test.ts`
- Modify: `file-explorer/test/storageScanService.test.ts`
- Modify: `file-explorer/test/storageMapRoutes.test.ts`

**Interfaces:**
- `start(rootId, path, refresh, sessionToken?)`
- Cache key: root + normalized scan path + generation
- Host result metadata: `excludedPaths`

- [ ] **Step 1: Write failing Host config tests**

Assert defaults and clamps:

```ts
expect(config.hostStorageScan).toEqual({
  maxEntries: 1_000_000,
  timeoutMs: 600_000,
  cacheTtlMs: 300_000,
  maxResultNodes: 10_000,
});
```

- [ ] **Step 2: Write failing exclusion/subtree tests**

Build a Host fixture with `proc`, `sys`, `dev`, `run`, `etc`, `usr`, `tmp`, and `mnt/data`. Scan root with excluded paths and assert only disk-backed files contribute, while result reports `excludedPaths: ["proc", "sys", "dev", "run"]`. Scan `mnt/data` and assert no siblings appear.

- [ ] **Step 3: Write failing session ownership tests**

Start Host job with token A. Assert status/result/cancel with missing/token B fail; token A succeeds. Invoke vault lock callback and assert job cancellation/cache invalidation. Local jobs remain token-free.

- [ ] **Step 4: Implement limits, paths, exclusions, ownership**

Add Host options and choose limits by root. Authorize scan path before launching. Scanner accepts `excludedRelativePaths`; it emits informational excluded nodes/metadata without `lstat` recursion. Service records `scanPath` and `ownerSessionId`, includes both in cache/job authorization, and offers `cancelRoot("host")` for vault lock.

Update API start body to `{ root, path: "", refresh }`; Host routes require request-local token for every job endpoint.

- [ ] **Step 5: Verify and commit**

```sh
pnpm vitest run test/config.test.ts test/storageScanner.test.ts test/storageScanService.test.ts test/storageMapRoutes.test.ts
pnpm test
pnpm lint
```

```sh
git add file-explorer/src/types.ts file-explorer/src/storageTypes.ts file-explorer/src/storageScanner.ts file-explorer/src/storageScanService.ts file-explorer/src/routes/storageMap.ts file-explorer/test/config.test.ts file-explorer/test/storageScanner.test.ts file-explorer/test/storageScanService.test.ts file-explorer/test/storageMapRoutes.test.ts
git commit -m "feat(file-explorer): scan Host storage safely"
```

---

### Task 7: Build Host Vault setup and unlock UI

**Files:**
- Create: `file-explorer/public/host-vault.js`
- Create: `file-explorer/test/host-vault-ui.test.mjs`
- Modify: `file-explorer/public/api.js`
- Modify: `file-explorer/public/operations.js`
- Modify: `file-explorer/public/index.html`
- Modify: `file-explorer/public/app.js`
- Modify: `file-explorer/public/styles.css`
- Modify: `file-explorer/public/tree.js`

**Interfaces:**
- `createHostVaultController({ api, operations, onUnlocked, onLocked })`
- API token provider reads `sessionStorage`
- DOM hooks for setup, unlock, lock, reset, status, expiry

- [ ] **Step 1: Write failing UI state tests**

Test unconfigured setup, locked unlock, five-attempt lockout, unlocked countdown, manual lock, token persistence only in `sessionStorage`, expiry returning to locked view, and secret input clearing after submit/failure.

Assert the private key/passphrase never appear in rendered status/error HTML.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/host-vault-ui.test.mjs test/server.test.ts`

Expected: controller and DOM hooks are missing.

- [ ] **Step 3: Add vault operation methods**

Add status/setup/unlock/lock/reset methods. Modify `createApi` to accept `getVaultToken` and a request option `{ hostVault: true }`; strip that option before `fetch` and attach `X-File-Explorer-Vault` only then. Never attach token to local requests.

- [ ] **Step 4: Implement accessible screens**

Use one Host panel with unconfigured, locked, unlocking, unlocked, lockout, and error sections. Setup uses password managers safely (`autocomplete="new-password"`); unlock uses `current-password`. Clear key/passphrase fields immediately after converting input values into request body. Add plain security/capability warnings and recovery actions.

When Host root is selected while locked, render vault panel instead of calling entries. On unlock, reload Host root. On lock/expiry, close Host storage map/previews, revoke object URLs, clear token, and return to locked panel.

- [ ] **Step 5: Verify and commit**

```sh
pnpm vitest run test/host-vault-ui.test.mjs test/ui.test.ts test/server.test.ts
node --check public/host-vault.js
```

```sh
git add file-explorer/public/host-vault.js file-explorer/public/api.js file-explorer/public/operations.js file-explorer/public/index.html file-explorer/public/app.js file-explorer/public/styles.css file-explorer/public/tree.js file-explorer/test/host-vault-ui.test.mjs file-explorer/test/server.test.ts
git commit -m "feat(file-explorer): add Host Vault interface"
```

---

### Task 8: Authenticate Host previews, downloads, context actions, and maps

**Files:**
- Modify: `file-explorer/public/operations.js`
- Modify: `file-explorer/public/app.js`
- Modify: `file-explorer/public/storage-map.js`
- Modify: `file-explorer/public/context-menu.js`
- Modify: `file-explorer/test/ui.test.ts`
- Modify: `file-explorer/test/storage-map-ui.test.mjs`
- Modify: `file-explorer/test/context-menu.test.mjs`

**Interfaces:**
- Host download/preview uses authenticated fetch + object URL
- `storageMap.open(root, path)` starts exact subtree

- [ ] **Step 1: Write failing browser integration tests**

Assert Host text/read/download/search/storage requests carry vault option/token; local equivalents do not. Assert object URLs are revoked on replacement/lock. Assert Host file context menu has no mutation actions and `map-folder` sends exact path.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/ui.test.ts test/storage-map-ui.test.mjs test/context-menu.test.mjs`

Expected: Host requests lack authentication and map start lacks path.

- [ ] **Step 3: Implement authenticated operations**

For Host preview/download, fetch blobs with vault header and use object URLs. Keep direct ingress-relative URLs for local roots. Update storage operations to mark Host requests and include path. Pass token/session through status/result/cancel automatically.

Render Host path as `/` + relative path; never show `/host`. Read-only preview omits Save/Move/Trash toolbar controls.

- [ ] **Step 4: Verify and commit**

```sh
pnpm vitest run test/ui.test.ts test/storage-map-ui.test.mjs test/context-menu.test.mjs test/host-vault-ui.test.mjs
pnpm test
```

```sh
git add file-explorer/public/operations.js file-explorer/public/app.js file-explorer/public/storage-map.js file-explorer/public/context-menu.js file-explorer/test/ui.test.ts file-explorer/test/storage-map-ui.test.mjs file-explorer/test/context-menu.test.mjs
git commit -m "feat(file-explorer): secure Host file actions"
```

---

### Task 9: Package, document, and release Host Vault

**Files:**
- Modify: `file-explorer/Dockerfile`
- Modify: `file-explorer/config.yaml`
- Modify: `file-explorer/README.md`
- Modify: `file-explorer/test/packaging.test.ts`

**Interfaces:**
- Releases File Explorer `0.3.0`
- Declares `/dev/fuse`, `SYS_ADMIN`, modern Config map, Host scan options

- [ ] **Step 1: Write failing packaging assertions**

Assert:

```ts
expect(dockerfile).toContain("apk add --no-cache");
for (const binaryPackage of ["openssh-client", "sshfs", "fuse3"]) expect(dockerfile).toContain(binaryPackage);
expect(config).toContain('version: "0.3.0"');
expect(config).toContain("type: homeassistant_config");
expect(config).toContain("path: /config");
expect(config).toContain("- SYS_ADMIN");
expect(config).toContain("- /dev/fuse");
expect(config).not.toContain("full_access: true");
```

Also assert all four Host scan defaults/options and required security documentation phrases.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/packaging.test.ts`

Expected: version/packages/capabilities/docs are absent.

- [ ] **Step 3: Update image and add-on metadata**

Install `openssh-client sshfs fuse3` in the runtime image only. Set version `0.3.0`, replace legacy Config map, add Host options/schema, `/dev/fuse`, and `SYS_ADMIN`. Do not add `full_access` or secret options.

- [ ] **Step 4: Document setup and risks**

Add exact port-22222 debug SSH prerequisites, dedicated-key generation/public-key installation, fingerprint retrieval, Protection-mode implications, setup/unlock/lock/reset, read-only action table, idle timeout, virtual exclusions, logical-size/hard-link caveat, limits, and llama.cpp app-data discovery.

- [ ] **Step 5: Run clean verification**

```sh
rm -rf node_modules dist
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm prune --prod
test -f dist/server.js
command -v node
```

From repository root:

```sh
git diff --check origin/main...HEAD
test -z "$(git status --short)"
```

When Docker is available:

```sh
docker build -t file-explorer:0.3.0 file-explorer
docker run --rm --entrypoint sh file-explorer:0.3.0 -c 'command -v sshfs && command -v fusermount3 && command -v ssh && command -v ssh-keyscan && command -v ssh-keygen'
```

Record Docker daemon unavailability verbatim if blocked. Real SSHFS mount/unmount remains a required HA OS deployment check.

- [ ] **Step 6: Commit**

```sh
git add file-explorer/Dockerfile file-explorer/config.yaml file-explorer/README.md file-explorer/test/packaging.test.ts
git commit -m "docs(file-explorer): release Host Vault"
```
