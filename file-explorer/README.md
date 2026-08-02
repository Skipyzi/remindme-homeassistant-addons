# File Explorer

File Explorer is a standalone, administrator-only Home Assistant ingress add-on for managing `/config`, `/share`, and `/media`. An optional, password-protected **Host Vault** can mount the actual Home Assistant OS `/` read-only through debug SSH on port 22222.

## Features

- Adaptive two-pane interface using Home Assistant light and dark theme variables.
- Browse, preview, edit, create, rename, move, upload, download, and search local roots.
- Navigate with Up, Root, and clickable breadcrumbs.
- Right-click, `Shift+F10`, Context Menu key, and touch long-press actions.
- On-demand WinDirStat-style Storage map with file-type colors and folder scans.
- Recoverable trash, automatic pre-save backups, and stale-file conflict detection.
- Bounded, symlink-safe storage scans that tolerate files disappearing during traversal.
- Optional encrypted Host Vault with pinned host identity and a 15-minute idle lock.

## Installation

1. Add this repository to **Settings → Add-ons → Add-on store → Repositories**.
2. Install **File Explorer**.
3. Review the root and scan-limit options.
4. Start the add-on and enable **Show in sidebar**.

Only Home Assistant administrators can open the ingress panel.

## Local options

| Option | Purpose | Default |
| --- | --- | ---: |
| `enable_config` | Show `/config` | `true` |
| `enable_share` | Show `/share` | `true` |
| `enable_media` | Show `/media` | `true` |
| `text_edit_max_bytes` | Largest editable text file | 1 MiB |
| `search_file_max_bytes` | Largest file searched for text | 2 MiB |
| `upload_max_bytes` | Largest upload | 100 MiB |
| `search_max_results` | Maximum results | 500 |
| `search_timeout_seconds` | Search time limit | 15 seconds |
| `retention_days` | Backup/trash retention target | 30 days |
| `storage_scan_max_entries` | Local scan entry limit | 200,000 |
| `storage_scan_timeout_seconds` | Local scan time limit | 120 seconds |
| `storage_scan_cache_seconds` | Local completed-scan cache | 60 seconds |
| `storage_map_max_nodes` | Local nodes returned per map view | 5,000 |
| `host_scan_max_entries` | Host scan entry limit | 1,000,000 |
| `host_scan_timeout_seconds` | Host scan time limit | 600 seconds |
| `host_scan_cache_seconds` | Host completed-scan cache | 300 seconds |
| `host_map_max_nodes` | Host nodes returned per map view | 10,000 |

Keys, passphrases, fingerprints, and encrypted vault contents are not add-on options.

## Host Vault security boundary

Host Vault is disabled and unmounted until setup succeeds. It uses a separate vault passphrase to encrypt a dedicated SSH key at rest with scrypt and AES-256-GCM. The expected host-key fingerprint is pinned before SSHFS mounts remote `/` at container path `/host`.

File Explorer enforces the Host root as read-only in both the interface and backend. It omits create, edit, upload, move, rename, trash, restore, and purge actions. SSHFS is also mounted with its read-only option.

**Important:** the dedicated debug SSH key authenticates as host `root`. A compromised File Explorer process could use that key outside the read-only SSHFS policy while the vault is unlocked. Use a dedicated SSH key, do not reuse it, and lock the vault when finished. Host Vault lowers the add-on isolation boundary because it requires `/dev/fuse` and `SYS_ADMIN`; it does not enable `full_access`.

The vault supports one browser session. Successful Host requests reset its idle deadline. After 15 minutes without Host activity, or after manual lock, File Explorer rejects Host requests, cancels Host scans, unmounts SSHFS, terminates the child process, and removes temporary key material.

## Preparing Home Assistant OS debug SSH

Host Vault connects to the Home Assistant OS debug SSH service on **port 22222**, not the limited Terminal/SSH add-on on port 22.

1. Follow the Home Assistant OS developer documentation to enable debug SSH and install an authorized public key.
2. Generate a dedicated SSH key on a trusted computer:

   ```bash
   ssh-keygen -t ed25519 -f haos-file-explorer -N ''
   ```

3. Install only `haos-file-explorer.pub` in HA OS debug SSH authorized keys. The private key is intentionally unencrypted before import because Host Vault encrypts it with the separate vault passphrase.
4. Obtain the host-key fingerprint through a trusted HA OS console, not from an unverified network scan. For the Ed25519 host key this is normally:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
   ```

5. Confirm debug SSH is reachable at the default Supervisor gateway `172.30.32.1` on port 22222.
6. Ensure the add-on receives `/dev/fuse` and `SYS_ADMIN`. Depending on the Home Assistant/Supervisor version, **Protection mode** may need to be disabled for those grants.

Do not continue when the observed host-key fingerprint differs from the value obtained through the trusted console.

## Setting up and using Host Vault

1. Open **Host /** in File Explorer.
2. Enter host, port, username, the trusted SHA-256 host-key fingerprint, the dedicated SSH private key, and a new vault passphrase.
3. Select **Verify and create vault**. File Explorer verifies the host key and performs a temporary read-only mount test before storing the encrypted key.
4. Enter the vault passphrase and select **Unlock Host /**.
5. Browse, search, download, or map Host files. Host paths are displayed as `/etc/...` or `/mnt/...`; the internal `/host` mountpoint is never displayed.
6. Select **Lock Host Vault** when finished.

Five failed passphrase attempts trigger a temporary lockout. If the passphrase is lost, **Reset Host Vault** deletes only the encrypted vault configuration after the exact confirmation `RESET HOST VAULT`. It does not change the host authorized keys.

Explicit errors distinguish an invalid passphrase, host-key mismatch, unreachable SSH, unavailable FUSE, mount failure, and a lost Host connection. SSH command output and secret-bearing values are not returned to the browser.

## Storage map

Select **Storage map** for the current root, or use **Map this folder** from a folder context menu. A folder action scans that exact subtree rather than scanning the entire root first. Block area represents logical file sizes and color represents file type. Very small same-extension files may be aggregated while preserving measured totals.

Scans are bounded by entry, time, cache, and result limits; bounded results are labeled **Incomplete**. The scanner does not follow symlinks. `ENOENT` and `ESTALE` races caused by active files disappearing become bounded warnings rather than aborting the scan. A disconnected SSHFS mount fails explicitly instead of presenting partial Host totals as complete.

Whole-Host scans keep `/proc`, `/sys`, `/dev`, and `/run` browsable but exclude them from recursive size totals because they are virtual filesystems. Disk-backed paths including `/etc`, `/usr`, `/tmp`, `/mnt`, and `/mnt/data` remain included.

Sizes are logical file sizes reported by the filesystem, not allocated blocks; hard links may therefore be counted more than once.

## Finding add-on data and llama.cpp models

Current Home Assistant OS Supervisor app data is normally under:

```text
/mnt/data/supervisor/apps/data/<full-addon-slug>/
```

Legacy installations may use:

```text
/mnt/data/supervisor/addons/data/<full-addon-slug>/
```

The local llama.cpp add-on keeps managed models in its persistent `/data/models` and legacy downloads under `/data/.cache`. From Host Vault, locate the llama.cpp add-on slug beneath `/mnt/data/supervisor/apps/data` (or the legacy path) and inspect those directories. Model removal remains in **RemindMe → Models**; do not delete active model files through host access.

## Local-root safety model

Browser requests contain a root ID and relative path. The backend canonicalizes every source and destination, rejects absolute paths and traversal, and verifies paths do not escape through symlinks.

Saving text checks its modification signature, creates a backup, flushes a temporary sibling, and atomically replaces the destination. Delete moves local items to add-on-managed trash; permanent purge requires confirmation.

## Manual HA OS verification

1. Confirm administrator-only ingress access and local Config/Share/Media behavior.
2. Confirm Config is mounted through `homeassistant_config` at `/config`.
3. Confirm context menus work by mouse, keyboard, and touch and omit every Host mutation.
4. Configure debug SSH port 22222 with a dedicated SSH key and trusted host-key fingerprint.
5. Verify a wrong fingerprint prevents setup.
6. Verify Host `/` exposes actual `/etc`, `/usr`, `/tmp`, `/mnt`, and `/mnt/data` read-only.
7. Verify `/proc`, `/sys`, `/dev`, and `/run` can be browsed but are excluded from whole-Host totals.
8. Verify `/mnt/data/supervisor/apps/data` is visible and the llama.cpp model files can be located.
9. Start a Host folder map, disconnect SSH, and verify the scan reports **Host connection lost**.
10. Lock manually and verify `/host` is unmounted and `/run/file-explorer-host` contains no key.
11. Unlock again, leave Host idle for 15 minutes, and verify the same cleanup.
12. Restart/stop the add-on while unlocked and verify shutdown cleanup.

## Development

```bash
pnpm install --frozen-lockfile --prod=false
pnpm lint
pnpm test
pnpm build
```

Tests use temporary directories and injected mount adapters; they never access a real Home Assistant host.
