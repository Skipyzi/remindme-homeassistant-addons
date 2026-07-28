# File Explorer Host Vault and Context Actions Design

**Date:** 2026-07-28
**Status:** Approved design draft
**Extends:** `2026-07-28-file-explorer-storage-map-design.md`

## Summary

Extend File Explorer `0.2.0` with an opt-in, read-only **Host Vault** that exposes the actual Home Assistant OS root filesystem through debug SSH on port 22222. The remote `/` is mounted with SSHFS at `/host` only while an administrator has an unlocked vault session. The SSH private key remains encrypted at rest, the host key is pinned, and the mount is automatically removed after 15 minutes without successful Host-root activity.

The release also adds an expanded, accessible context menu for file and folder rows and fixes storage scans that currently fail when active files disappear between directory enumeration and metadata lookup.

This specification supersedes the earlier storage-map non-goal that excluded the Home Assistant host root. All other storage-map safety and compatibility requirements remain in force.

## Goals

- Expose actual HA OS paths such as `/etc`, `/usr`, `/tmp`, `/mnt`, and Supervisor app-data directories through a clearly labeled **Host /** root.
- Make the Host root read-only through every File Explorer API and interface.
- Keep Host `/` absent from filesystem access until a vault passphrase successfully unlocks it.
- Encrypt the dedicated SSH private key at rest and never persist its plaintext or the vault passphrase.
- Pin the remote SSH host key and reject changed/unknown keys.
- Automatically unmount and erase temporary key material after 15 minutes of Host inactivity.
- Allow whole-host and folder-scoped storage maps with explicit virtual-filesystem exclusions and bounded work.
- Prevent active files disappearing during scans from aborting the whole job.
- Provide an expanded right-click, keyboard, and touch context menu without weakening existing mutation protections.
- Replace the legacy Home Assistant config mapping with `homeassistant_config` mounted explicitly at `/config`.

## Non-goals

- Writable Host-root operations.
- Hiding that SSH root access and `SYS_ADMIN` materially lower the add-on security posture.
- Making root debug SSH safe against a fully compromised, currently unlocked File Explorer process.
- Automatically enabling HA OS debug SSH or installing the authorized public key on the host.
- Supporting password-based SSH authentication.
- Automating the interactive `login` command from Terminal/SSH add-ons on port 22.
- Following symlinks during storage scans.
- Assigning meaningful storage sizes to virtual filesystems or device nodes.
- Sharing one unlocked session among multiple browser clients.

## User experience

### Roots

File Explorer displays four root tabs:

- Config
- Share
- Media
- Host /

Config, Share, and Media behave as before. Host `/` is always visible as a locked root tab so its existence and status are explicit. Selecting it while locked opens the Host Vault screen rather than issuing filesystem requests.

### First-time Host Vault setup

When no vault exists, the Host root opens a setup form containing:

- SSH host, default `172.30.32.1`;
- SSH port, default `22222`;
- SSH username, default `root`;
- expected SHA-256 host-key fingerprint;
- dedicated, unencrypted OpenSSH private key;
- vault passphrase;
- vault passphrase confirmation.

The form explains how to enable HA OS debug SSH, install the corresponding public key, retrieve the host-key fingerprint out of band, and why the dedicated key must not be reused elsewhere.

Setup validates all fields, tests encryption/decryption in memory, verifies the supplied private-key structure, verifies the live host fingerprint, and confirms read-only SSHFS mounting before persisting the encrypted vault. If the mount test fails, setup returns a specific error and stores no vault.

### Unlock and lock

Unlock asks only for the vault passphrase. On success:

1. the private key is decrypted into a mode-`0600` file beneath `/run/file-explorer-host/`;
2. the pinned known-host entry is written into the same temporary directory;
3. SSHFS mounts remote `/` read-only at `/host`;
4. the backend issues a random 256-bit session token;
5. the browser stores the token in `sessionStorage` and sends it only in `X-File-Explorer-Vault`;
6. Host `/` becomes browsable for that session.

The UI displays connection state and remaining idle time. Successful Host API activity resets the 15-minute server-side timer. Local-root activity does not.

Manual **Lock Host Vault**, idle expiry, add-on shutdown, SSHFS process death, or loss of the active session performs the same cleanup:

- invalidate the token;
- reject new Host requests;
- cancel Host scan jobs;
- unmount `/host` with `fusermount3`;
- terminate the SSHFS child;
- remove temporary private-key and known-host files;
- return Host `/` to the locked screen.

Only one vault session may be active. A new successful unlock invalidates and replaces the previous session.

### Failed attempts and recovery

Vault passphrase failures are rate-limited. After five consecutive failures, unlock is blocked temporarily; the UI displays the remaining delay. A successful unlock resets the failure counter.

The stored private key cannot be recovered without the vault passphrase. A destructive **Reset Host Vault** action deletes only the encrypted vault configuration and requires typing `RESET HOST VAULT`; it does not touch the host or its authorized keys. Setup must then be completed again.

### Read-only Host interaction

Host files can be previewed read-only and downloaded. Host folders can be browsed, searched, and mapped. The UI does not render create, edit, upload, move, rename, trash, restore, or purge actions for Host entries. Server-side root metadata sets `readOnly: true`, so crafted mutation requests are rejected independently of the UI.

Paths are displayed as Host-absolute paths (for example `/mnt/data/supervisor/apps/data/...`) but backend filesystem paths such as `/host/...` are never returned.

## Context menu

### Activation

- Desktop: `contextmenu`/right-click on a file or folder row.
- Keyboard: Context Menu key or `Shift+F10` on the focused row.
- Touch: deliberate long press opens a bottom-sheet presentation.

The native browser menu is prevented only for File Explorer rows. Escape, outside click, selecting an action, or focus leaving the menu closes it. Focus enters the first enabled action and returns to the originating row when the menu closes. Arrow keys navigate; Enter/Space activates. Desktop positioning is clamped to the viewport.

### Local file actions

- Open
- Preview/Edit when supported
- Download
- Rename/Move
- Copy relative path
- Storage details
- Move to trash

### Local folder actions

- Open
- New file
- New folder
- Upload here
- Rename/Move
- Copy relative path
- Map this folder
- Move to trash

### Host file actions

- Open read-only preview
- Download
- Copy absolute Host path
- Storage details
- Show in storage map

### Host folder actions

- Open
- Copy absolute Host path
- Map this folder

Mutation actions are omitted rather than merely disabled for Host entries.

## Architecture

### HostVaultService

A new `HostVaultService` owns:

- persisted encrypted vault configuration;
- setup validation and destructive reset;
- passphrase verification and lockout state;
- temporary key/known-host material;
- SSHFS child process and mount health;
- one active opaque session token;
- the 15-minute idle deadline;
- lock cleanup callbacks for scan cancellation;
- status snapshots that never contain secrets.

The service receives injectable crypto, process, filesystem, and clock adapters so encryption, mount lifecycle, failures, and timeouts are testable without real SSH or FUSE.

### Encryption format

The persisted `/data/file-explorer/host-vault.json` is mode `0600` and contains:

- schema version;
- host, port, username;
- pinned SHA-256 fingerprint;
- random scrypt salt;
- random AES-GCM nonce;
- ciphertext;
- authentication tag;
- KDF parameters.

Use Node’s asynchronous `crypto.scrypt` to derive a 32-byte key with `N=32768`, `r=8`, `p=1`, and `maxmem=64 MiB`. Encrypt the private key using AES-256-GCM with vault metadata as authenticated additional data. Compare/verify through authenticated decryption; never store a separate plaintext password verifier.

The setup endpoint accepts a dedicated unencrypted private key because the vault provides its at-rest encryption. The key is transmitted only through authenticated Home Assistant ingress and must never be logged, echoed, or included in an error.

### Host-key verification

Setup/unlock runs `ssh-keyscan` for the configured host/port, computes the SHA-256 fingerprint using `ssh-keygen`, and compares it using a timing-safe comparison against the configured fingerprint. The verified key line becomes the temporary `known_hosts` file. SSHFS uses:

- `StrictHostKeyChecking=yes`;
- explicit `UserKnownHostsFile`;
- explicit `IdentityFile`;
- read-only mount option;
- disabled password and keyboard-interactive authentication;
- reconnect and bounded server-alive options.

A mismatch or scan failure prevents mounting.

### SSHFS lifecycle

The add-on image installs OpenSSH client, SSHFS, and FUSE 3. Add-on configuration requests `/dev/fuse` and `SYS_ADMIN`; documentation states whether Protection mode must be disabled on the target HA version.

Mountpoint `/host` is never used as a configured root unless `HostVaultService` confirms both a live SSHFS child and an active token. Unmount first rejects API access and cancels scans, then invokes `fusermount3 -u`, escalating to lazy unmount only when normal unmount cannot complete within a bounded period.

The SSHFS mount is policy read-only. However, the decrypted debug-SSH key authenticates as host root while unlocked, so compromise of the running process remains high impact. The UI and documentation must state this limitation plainly.

### Root registry and authorization

Extend `RootId` with `host`. The base root registry publishes locked metadata for Host but does not expose `/host` as an authorized path. Host authorization requires all of:

- root ID `host`;
- valid active `X-File-Explorer-Vault` token;
- healthy mounted state;
- read intent;
- normalized path contained beneath `/host`.

All Host mutation intents return `READ_ONLY_ROOT` before touching the filesystem. Existing local roots continue through the current path policy without vault headers.

### API

#### Vault status

`GET /api/host-vault/status`

Returns configured/locked/unlocked state, safe connection metadata, lockout remaining time, idle deadline for the active session when authorized, and mount health. It never returns ciphertext, key paths, tokens, or KDF material.

#### Setup

`POST /api/host-vault/setup`

Accepts connection metadata, expected fingerprint, private key, and passphrase confirmation. Validates and mount-tests before atomic persistence.

#### Unlock

`POST /api/host-vault/unlock`

Accepts the vault passphrase and returns the opaque session token plus idle expiry. Errors distinguish invalid passphrase, lockout, host-key mismatch, SSH unavailable, FUSE unavailable, and mount failure without exposing command output containing secrets.

#### Lock

`POST /api/host-vault/lock`

Requires the active token and performs immediate cleanup.

#### Reset

`DELETE /api/host-vault`

Requires confirmation value `RESET HOST VAULT`. If currently unlocked, lock first; then atomically remove the encrypted configuration.

### Token propagation

The browser holds the token only in `sessionStorage`. `createApi` accepts a token provider and adds `X-File-Explorer-Vault` only when a request targets Host data. Host downloads/previews use authenticated `fetch` and object URLs instead of direct `<a href>`/`<img src>` URLs that cannot set the header.

Storage jobs started for Host record the active vault session. Status, result, and cancel endpoints require that same session token. Locking invokes `StorageScanService.invalidate("host")` and cancels every Host job.

## Storage scanning

### Disappearing entries

`StorageScanner` classifies `ENOENT` and `ESTALE` from `readdir`/`lstat` as `ENTRY_DISAPPEARED` warnings and continues. This fixes active Config directories where files are atomically replaced between enumeration and metadata lookup.

Expected disappearing-entry warnings are capped and do not by themselves mark totals incomplete because the vanished entry no longer exists at the end of the scan. Permission errors and unsupported disk-backed entries remain incomplete warnings.

Host transport failures (`ENOTCONN`, disconnected SSHFS child, or equivalent mount failure) stop the scan with a typed `HOST_CONNECTION_LOST` error. The service logs only scan ID, root ID, and safe error code; browser errors remain actionable but path- and secret-free.

### Subtree scans

Extend scan creation with an optional root-relative `path`. Jobs and caches are keyed by root, normalized scan path, and generation. **Map this folder** starts or reuses a scan for that subtree instead of scanning the entire root first. Whole-host mapping uses Host path `/`, represented internally as relative `""`.

### Host limits

Host scans use independent configurable defaults:

- `host_scan_max_entries`: 1,000,000;
- `host_scan_timeout_seconds`: 600;
- `host_scan_cache_seconds`: 300;
- `host_map_max_nodes`: 10,000.

Local roots retain their existing limits. Traversal concurrency remains tightly bounded to avoid flooding SSHFS.

### Virtual filesystem exclusions

For a whole Host scan, these top-level paths are excluded from recursive size traversal:

- `/proc`
- `/sys`
- `/dev`
- `/run`

They remain fully browsable. The Host map shows them as informational **Virtual filesystem · excluded from size scan** entries with zero mapped area and lists them in summary metadata. `/etc`, `/usr`, `/tmp`, `/mnt`, and `/mnt/data` are included.

Host totals are logical file sizes. Documentation and UI state that hard-linked files may be double-counted and that logical bytes differ from allocated filesystem blocks.

## Error handling

Every vault and scan failure has a visible state and recovery action:

- invalid passphrase → retry count and lockout state;
- host-key mismatch → stop, show expected/observed safe fingerprints, require setup correction;
- SSH unavailable → retry connection;
- FUSE/device/capability missing → deployment instructions;
- mount failure → safe reason and retry;
- mount disconnected → lock vault, cancel scans, retry unlock;
- Config entry disappeared → continue with warning;
- Host scan connection lost → explicit failed state with Retry;
- expired token → return to locked screen;
- reset → return to first-time setup.

No route may swallow a rejected vault or storage promise. Internal logs use opaque operation IDs and safe error codes. Browser responses exclude absolute container paths, command lines, private keys, passphrases, ciphertext, and raw stderr.

## Add-on configuration

### Modern Home Assistant config mount

Replace:

```yaml
- type: config
  read_only: false
```

with:

```yaml
- type: homeassistant_config
  path: /config
  read_only: false
```

### Required Host Vault capabilities

Add the narrow requested capability/device rather than `full_access`:

```yaml
privileged:
  - SYS_ADMIN
devices:
  - /dev/fuse
```

If Supervisor requires Protection mode to be disabled for these grants, setup detects the missing capability and links to the documented requirement. Host Vault remains opt-in even though the declared container capability exists for every installation of this add-on version.

### Options

Add safe non-secret options only for scan bounds. SSH private key, vault passphrase, and encrypted key material never appear in `options.json`.

## Testing

### Scanner regression tests

- `ENOENT` between `readdir` and `lstat` produces `ENTRY_DISAPPEARED` and continues;
- `ESTALE` behaves identically;
- permission errors remain incomplete;
- `ENOTCONN` becomes `HOST_CONNECTION_LOST`;
- virtual exclusions do not contribute sizes;
- `/etc`, `/usr`, `/tmp`, and `/mnt` fixtures do contribute;
- warning caps and path sanitization hold.

### Vault crypto tests

- encryption/decryption round trip;
- randomized salts/nonces produce different ciphertext;
- wrong passphrase and modified metadata/tag fail authentication;
- persisted JSON lacks plaintext key/passphrase;
- file mode is `0600`;
- secret-bearing inputs never appear in errors/logs.

### Vault lifecycle tests

- setup validation and atomic persistence;
- host fingerprint match/mismatch;
- missing `/dev/fuse` and mount capability errors;
- SSHFS arguments enforce read-only and strict host-key checking;
- successful unlock issues one token;
- second unlock invalidates the first token;
- five failures trigger timed lockout;
- Host activity resets idle expiry;
- local activity does not reset it;
- manual/idle lock rejects access, cancels scans, unmounts, kills child, and removes temp files;
- shutdown performs the same cleanup;
- reset requires exact confirmation.

### Authorization tests

- locked Host browse/search/download/scan requests fail;
- missing, wrong, replaced, and expired tokens fail;
- valid token allows reads only;
- every Host mutation route returns `READ_ONLY_ROOT`;
- local roots remain usable while Host is locked;
- Host responses display `/...` and never `/host/...`.

### Context-menu tests

- action sets for local file, local folder, Host file, and Host folder;
- Host mutation actions are absent;
- right-click, Context Menu key, `Shift+F10`, and long press;
- viewport clamping and mobile bottom sheet;
- arrow navigation, activation, Escape, outside click, and focus restoration;
- Map this folder starts the exact subtree scan;
- authenticated Host preview/download uses the vault token.

### Packaging and integration tests

- image contains `sshfs`, `fusermount3`, `ssh`, `ssh-keyscan`, and `ssh-keygen`;
- config requests only `/dev/fuse` and `SYS_ADMIN`, not `full_access`;
- modern `homeassistant_config` mapping targets `/config`;
- frozen pnpm install, lint, tests, build, and production prune pass;
- Docker image build passes where a daemon is available;
- HA OS manual verification mounts actual `/`, excludes virtual size trees, displays `/mnt/data/supervisor/apps/data`, finds llama.cpp model files, locks after 15 idle minutes, and leaves no mount/key after locking.

## Documentation and rollout

Release as File Explorer `0.3.0` and update PR #30.

Documentation must include:

- explicit security warning and root-key limitation;
- debug SSH port 22222 setup and dedicated key guidance;
- host fingerprint retrieval and pinning;
- FUSE/SYS_ADMIN/Protection-mode implications;
- first-time setup, unlock, lock, timeout, reset, and recovery;
- read-only Host action matrix;
- virtual filesystem exclusions;
- whole-host performance/limit guidance;
- logical-size and hard-link caveats;
- llama.cpp app-data discovery under variable Supervisor app slugs.

Host Vault is disabled until setup succeeds. Existing users who do not configure it retain local File Explorer behavior, aside from the Config scan resilience fix, modern config mount, and new local context menu.
