# File Explorer

File Explorer is a standalone, administrator-only Home Assistant ingress add-on for safely managing files in `/config`, `/share`, and `/media`.

## Features

- Adaptive two-pane interface using Home Assistant light and dark theme variables.
- Browse, preview, edit, create, rename, move, upload, download, and search.
- Navigate safely with Up, Root, and clickable breadcrumb controls.
- Open an on-demand Storage map whose file blocks are sized by storage use and colored by file type.
- Recoverable trash with restore and permanent purge.
- Automatic pre-save backups and stale-file conflict detection.
- Central path authorization that rejects traversal and symlink escapes.
- Responsive mobile file-tree drawer and keyboard navigation.

## Installation

1. Add this repository to **Settings → Add-ons → Add-on store → Repositories**.
2. Install **File Explorer**.
3. Review the root and limit options.
4. Start the add-on and enable **Show in sidebar**.

Only Home Assistant administrators can open the ingress panel.

## Options

| Option | Purpose | Default |
| --- | --- | ---: |
| `enable_config` | Show `/config` | `true` |
| `enable_share` | Show `/share` | `true` |
| `enable_media` | Show `/media` | `true` |
| `text_edit_max_bytes` | Largest editable text file | 1 MiB |
| `search_file_max_bytes` | Largest file scanned for text | 2 MiB |
| `upload_max_bytes` | Largest upload | 100 MiB |
| `search_max_results` | Maximum results | 500 |
| `search_timeout_seconds` | Search time limit | 15 seconds |
| `retention_days` | Backup/trash retention target | 30 days |
| `storage_scan_max_entries` | Maximum entries measured in one storage scan | 200,000 |
| `storage_scan_timeout_seconds` | Storage scan time limit | 120 seconds |
| `storage_scan_cache_seconds` | Reuse time for a completed scan | 60 seconds |
| `storage_map_max_nodes` | Maximum nodes returned for one map view | 5,000 |

## Safety model

Browser requests contain a root ID and relative path. The backend canonicalizes every source and destination, rejects absolute paths and traversal, and verifies existing paths and create parents do not escape through symlinks.

Saving an existing text file checks its modification signature, creates a timestamped backup, flushes a temporary sibling, closes it, and replaces the destination. If another process changed the file, File Explorer preserves the browser text and refuses the stale write.

Delete moves items to add-on-managed trash. Restore detects destination conflicts and supports an alternate relative path. Permanent deletion requires confirmation in the interface.

## Storage map

Choose one enabled root and select **Storage map** to start an on-demand scan. The focus view shows logical file sizes: block area represents bytes, color represents file type, and directory blocks drill into cached results. Selecting a real file returns to the existing editor or preview. Very small same-extension files may be combined into an informational aggregate block so totals remain accurate without rendering thousands of unusable rectangles.

Scans are bounded by the configured entry, time, and result limits. A bounded result is labeled **Incomplete** rather than presented as a complete total. Successful file changes invalidate the affected cached root, **Refresh scan** forces a new scan, and otherwise completed data is reused for the configured cache interval. The scanner uses only the selected `/config`, `/share`, or `/media` root and does not follow symlinks. Sizes are logical bytes reported by the filesystem, not allocated disk blocks.

## Manual verification

1. Confirm an administrator can open the panel and a non-administrator cannot.
2. Toggle each root option and confirm disabled roots disappear.
3. Create, edit, upload, rename, move, search, delete, restore, and download a temporary file.
4. Change an open file outside the editor and confirm stale save is refused without losing browser text.
5. Verify both Home Assistant light and dark themes.
6. Verify the file-tree drawer and editor at a narrow mobile width.
7. Enter nested folders and verify Up, Root, and every breadcrumb segment navigates correctly.
8. Open Storage map for each enabled root; verify progress, drill-down, file opening, Refresh, and Cancel.
9. Add many tiny files and confirm aggregate blocks preserve the displayed total.
10. Create a symlink inside a test root and confirm the map reports it as skipped without showing the target.
11. Mutate a mapped root and confirm reopening the map produces a fresh scan.
12. Confirm the focus view and bottom details sheet work at a narrow mobile width.
13. Confirm assets and API requests work through the full ingress URL prefix.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
```

Tests use temporary directories and never access a real Home Assistant installation.
