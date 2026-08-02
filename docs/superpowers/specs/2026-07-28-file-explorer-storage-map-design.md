# File Explorer Storage Map Design

**Date:** 2026-07-28
**Status:** Approved design

## Summary

Add a WinDirStat-style storage visualization to the standalone Home Assistant File Explorer add-on. The feature analyzes the currently selected authorized root (`config`, `share`, or `media`) on demand and renders a full-screen, interactive treemap in which file area is proportional to size and color represents file type.

The work also repairs a prerequisite navigation gap: entering a directory currently replaces the listing without providing a way to move to its parent. The explorer will gain an Up button, clickable breadcrumbs, and an explicit Root action.

## Goals

- Let administrators understand which files consume space within the selected File Explorer root.
- Keep the visualization responsive and useful on desktop and mobile.
- Support direct drill-down into directories and opening real files with the existing editor or preview.
- Avoid continuous background indexing or unrestricted host access.
- Preserve all existing path-policy, trash, backup, upload, and editor protections.
- Bound filesystem work, never follow symlinks, and report incomplete results honestly.

## Non-goals

- Scanning the Home Assistant host root or arbitrary host paths.
- Combining `/config`, `/share`, and `/media` into one map.
- Direct permanent deletion from the treemap.
- Continuous filesystem watching or a persistent on-disk index.
- Following symlinks, hard-link deduplication, or filesystem-block accounting.
- Replacing existing browse, editor, preview, trash, or search APIs.

## User experience

### Folder navigation

The existing tree toolbar path becomes a navigation bar containing:

- an **Up** button, disabled at the selected root;
- clickable breadcrumb segments beginning with the selected root;
- an explicit **Root** action;
- the existing Refresh action.

All navigation remains relative to the selected authorized root. Navigating while an editor contains unsaved changes uses the existing discard confirmation. Root tabs continue to switch between enabled roots and reset the path to that root.

### Opening the storage map

A **Storage map** action is added to the main header. It analyzes the currently selected root, regardless of the directory currently open in the normal browser.

Opening it replaces the entire explorer with a focus view containing:

- Back/Close;
- selected root and map breadcrumbs;
- Up and Root controls;
- Refresh scan;
- scan age;
- summary totals for scanned bytes, files, directories, duration, and completeness;
- a file-type legend;
- the treemap or the current scan state.

Closing focus mode returns to the previous explorer location and content state.

### Scan states

A running scan shows:

- files and directories visited;
- bytes observed;
- current relative directory when safely representable;
- elapsed time;
- Cancel.

The view distinguishes complete, incomplete, cancelled, failed, and disconnected states. Partial safe results remain viewable, but totals and the map are marked **Incomplete** with a reason.

### Treemap

The browser renders a responsive squarified hierarchical treemap:

- file tile area is proportional to logical file size;
- file color is derived from normalized extension/type groups;
- directories form labeled grouping boundaries rather than receiving misleading file-type colors;
- a compact legend explains visible type colors;
- empty files and directories remain discoverable in details but do not receive visible area;
- tiny files are grouped by containing directory and extension into aggregate tiles such as `Other .json files`;
- aggregate tiles preserve byte and file totals but cannot open as a single file.

Hover and keyboard focus show name, root-relative path, exact size, type, percentage, and whether the item is aggregated. On touch/narrow screens, selection opens a bottom details sheet rather than depending on hover.

Clicking or pressing Enter on a directory drills into it using the cached scan. Clicking a real file closes focus mode and opens it through the existing editor or preview behavior. Opening binary files continues to use the existing error/download behavior where no preview exists.

## Architecture

### Components

1. **`StorageScanService`**
   - Owns scan jobs, cancellation, cache entries, and eviction.
   - Deduplicates concurrent requests for the same root and cache generation.
   - Exposes progress snapshots without exposing absolute paths.

2. **`StorageScanner`**
   - Traverses one approved root with `lstat`/directory reads.
   - Does not follow symbolic links.
   - Builds an internal hierarchical size tree and aggregate totals.
   - Records bounded warnings and an explicit truncation reason.

3. **Storage-map API routes**
   - Start/refresh scans, poll progress, retrieve compacted results, and cancel jobs.
   - Accept only root IDs and opaque job IDs.

4. **Browser storage-map module**
   - Manages focus-view state, polling, result navigation, treemap layout, details, legend, cancellation, and return to the explorer.

5. **Navigation module changes**
   - Compute parent paths and safe breadcrumb segments from normalized root-relative paths.
   - Render accessible Up, Root, and breadcrumb controls.

### API

#### Start or reuse a scan

`POST /api/storage-map/scans`

```json
{
  "root": "share",
  "refresh": false
}
```

Returns an opaque job ID and current status. A valid non-expired cache may return a job already in `complete` state. `refresh: true` increments the root cache generation and starts a new scan.

#### Poll status

`GET /api/storage-map/scans/:jobId`

Returns:

```json
{
  "job": {
    "id": "opaque-id",
    "root": "share",
    "status": "running",
    "progress": {
      "files": 1250,
      "directories": 84,
      "bytes": 734003200,
      "currentPath": "media/photos",
      "elapsedMs": 3210
    },
    "warnings": [],
    "truncated": false,
    "truncationReason": null
  }
}
```

Absolute filesystem paths, implementation details, and stack traces are never returned.

#### Retrieve a result view

`GET /api/storage-map/scans/:jobId/result?path=<root-relative-path>`

Returns summary metadata and a compacted hierarchical tree for the requested directory. The path is resolved against the job’s authorized root with the existing path policy. The response is bounded by a render-node budget; files below the visual threshold are grouped by extension without changing total bytes.

#### Cancel

`DELETE /api/storage-map/scans/:jobId`

Requests cancellation. Cancellation is idempotent. Only a running job is affected; a reusable completed cache remains intact.

### Result model

Each visible node contains only browser-safe data:

- stable job-scoped opaque node ID;
- display name;
- root-relative path for real entries;
- `file`, `directory`, or `aggregate` kind;
- logical size in bytes;
- descendant file/directory counts;
- normalized type group and extension for files/aggregates;
- child nodes for visible directory groups;
- aggregate count and non-openable marker where applicable.

Node IDs are not accepted as filesystem authority. Any operation that opens a file still passes through the existing root/path authorization.

## Scanning, compaction, and caching

### Traversal

- Traverse sequentially or with tightly bounded directory-read concurrency.
- Call `lstat`; do not recurse into symlinks.
- Treat regular-file `size` as logical bytes.
- Skip unsupported node types and report bounded warnings.
- Continue after permission errors where possible.
- Check abort, timeout, and entry limits throughout traversal.

### Default limits

Expose add-on options with conservative defaults:

- `storage_scan_max_entries`: 200,000;
- `storage_scan_timeout_seconds`: 120;
- `storage_scan_cache_seconds`: 60;
- `storage_map_max_nodes`: 5,000.

Values are validated and clamped to safe ranges at startup. Reaching a limit yields a partial result with a machine-readable reason; it must not be presented as complete.

### Tiny-file aggregation

The internal scan tree retains measured totals up to the scan-entry limit. Result projection applies the node budget deterministically:

1. Preserve directory grouping and the largest real files that fit the budget.
2. Group remaining files by containing directory and normalized extension/type.
3. Preserve exact grouped byte and file counts.
4. Mark aggregate nodes as informational and non-openable.
5. Ensure visible node sizes sum to the directory’s reported scanned bytes, excluding only explicitly reported unsupported/inaccessible entries.

### Cache

- Cache completed or safely partial scan trees by root and generation.
- Deduplicate concurrent scans for the same root/generation.
- Keep a small least-recently-used cache bounded by count and estimated node memory.
- Expire entries after the configured cache interval.
- Invalidate affected roots after successful create, text save, upload, move, trash, restore, or purge operations.
- A cross-root move, if later supported, invalidates both roots.
- Closing focus mode does not cancel a scan; Cancel explicitly does.
- Failed and cancelled scans are not reused as successful caches.

## Security and privacy

- The add-on remains administrator-only through its existing Home Assistant ingress configuration.
- Only enabled roots in the existing root registry can be scanned.
- Every requested result path is normalized and authorized by the existing path policy.
- Symlinks are never followed during scans or result projection.
- Browser responses use root-relative paths only; absolute container or host paths are excluded.
- Job IDs are random, opaque, short-lived, and scoped to this process.
- Warnings are sanitized and capped.
- No treemap action bypasses existing editor, preview, backup, or trash safety checks.

## Accessibility and responsive behavior

- Up, Root, breadcrumb, refresh, cancel, close, directory, and file controls receive accessible names.
- Breadcrumbs use navigation semantics and identify the current segment.
- Treemap nodes are keyboard reachable with Enter activation and a deterministic order.
- Focus is moved into focus view on open and restored to the Storage map button on close.
- Status changes use an `aria-live` region without announcing every scan tick.
- Colors meet usable contrast where text is rendered and are never the only indication of type.
- On narrow screens, details use a bottom sheet and controls remain touch-sized.
- Reduced-motion preferences disable animated treemap transitions.

## Error handling

The UI provides specific recovery for:

- **Permission warning:** show partial data and warning count.
- **Entry limit:** show partial map, configured limit, and incomplete label.
- **Timeout:** show partial map and Refresh.
- **Cancelled:** keep safe partial totals if available and offer Resume as a new scan.
- **Root unavailable:** leave focus view open with retry and close actions.
- **Connection failure:** stop polling, retain the last safe state, and offer Retry.
- **Expired job/cache:** transparently start a new scan after user confirmation when needed.

## Testing

### Unit tests

- parent-path and breadcrumb generation;
- root-level disabled Up behavior;
- nested size aggregation and empty directories;
- extension/type normalization;
- deterministic tiny-file grouping and total preservation;
- symlink non-traversal;
- permission and unsupported-entry warnings;
- timeout, cancellation, and entry-limit behavior;
- concurrent scan deduplication;
- cache expiry, LRU eviction, refresh, and mutation invalidation.

### Route tests

- reject disabled/unknown roots and malformed bodies;
- create, reuse, refresh, poll, retrieve, expire, and cancel jobs;
- authorize result subpaths;
- hide absolute paths and sanitize warnings;
- return stable complete/partial/error contracts.

### Browser tests

- Up, Root, and clickable breadcrumbs;
- unsaved-editor confirmation;
- focus-view open/close and focus restoration;
- progress, complete, incomplete, cancelled, and failed states;
- hierarchical layout and proportional sizing;
- file-type legend;
- directory drill-down and file opening;
- aggregate-node details without file activation;
- keyboard and mobile details behavior.

### Verification

Run from `file-explorer/`:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm prune --prod
```

Also run `git diff --check` and build the add-on image when a Docker daemon is available. Validate manually with representative `/config`, `/share`, and `/media` trees, including large files, many tiny files, inaccessible entries, and symlinks.

## Rollout

- Release as File Explorer `0.2.0`.
- Keep existing APIs and options backward compatible.
- Add the new scan-limit/cache options with safe defaults.
- Document that sizes are logical file sizes, scans are bounded/on demand, symlinks are not followed, and maps cover only the selected configured root.
- Keep PR #29’s pnpm build-policy fix separate; the feature branch currently builds on that commit and should be rebased onto `main` after PR #29 merges.
