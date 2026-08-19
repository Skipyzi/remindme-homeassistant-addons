# RemindMe Model Disk Inventory Design

**Date:** 2026-07-28  
**Status:** Approved design

## Problem

RemindMe's Models page currently derives an `installed` flag from a catalog variant's exact expected filename under `/data/models`. A physical model can therefore consume persistent add-on storage while its card still says **Available**. This occurs when the file is unknown to the current catalog, has a different filename, or lives in a legacy llama.cpp cache beneath `/data/.cache`.

The existing card-level **Remove** control is conditional on that unreliable flag, so affected files cannot be found or deleted through the UI. Home Assistant's available SSH shell cannot be assumed to expose Docker or the Supervisor host filesystem.

## Goals

- Discover actual model files in the llama.cpp add-on's persistent storage.
- Show those files in RemindMe independently of catalog-card detection.
- Include managed, custom, unknown, and legacy cached GGUF files.
- Allow safe removal of non-active files and report reclaimed disk space.
- Protect active and in-progress models.
- Avoid exposing container paths, host paths, credentials, or arbitrary cache contents.
- Preserve all existing model installation, verification, activation, and removal APIs.

## Non-goals

- A separate UI in the Local llama.cpp add-on sidebar.
- A bulk **Clear cache** action.
- Arbitrary filesystem browsing.
- Removing unrelated cache data.
- Managing incomplete `.partial` downloads in this iteration.
- Moving legacy cache files into `/data/models` automatically.

## Architecture

### Model manager inventory service

The llama.cpp model manager will own physical model discovery because it has direct, private access to `/data` and already enforces model lifecycle safety.

It will scan two approved roots:

1. `/data/models` — manager and manually supplied models.
2. `/data/.cache` — legacy llama.cpp/Hugging Face cache storage.

The scan will recurse without following directory symlinks. It will be bounded by a maximum depth and entry count, with deterministic ordering. Entries outside the approved roots are impossible to return. Files are candidates when their filename ends in `.gguf`, case-insensitively. The service reads only the small GGUF header needed to classify a file as valid or invalid; an invalid `.gguf` remains visible and removable because it can still occupy substantial storage.

Each result contains:

- an opaque deterministic inventory ID derived from source category and root-relative path;
- basename, byte size, and modification timestamp;
- source category: `managed` or `legacy_cache`;
- GGUF validity;
- matching catalog model ID when filename matching is unambiguous;
- `active`, `inProgress`, and `removable` state.

No API response contains an absolute path or unrestricted relative path.

### API

The authenticated manager API adds:

- `GET /manager/v1/models/inventory`
- `DELETE /manager/v1/models/inventory/{inventoryId}`

The RemindMe server proxies these as:

- `GET /api/models/inventory`
- `DELETE /api/models/inventory/{inventoryId}`

Manager authentication remains server-side. The browser never receives the manager token.

### Deletion resolution

Deletion does not accept a path. On every request, the manager rescans the approved roots and finds the file represented by the supplied inventory ID. It then revalidates that the target is a regular file within an approved canonical root and that no traversed path component is a symlink.

Before unlinking, it compares the canonical target with the supervisor's active model and current operation. Active and in-progress targets return a conflict. A file that disappeared after inventory loading is treated as already removed. Permission and I/O failures return a scoped error without changing manager state.

The existing catalog deletion endpoint remains available for compatibility, but the inventory endpoint is authoritative for physical-file discovery.

## RemindMe interface

The Models page gains a **Downloaded models** section, loaded separately from catalog variants.

Each row shows:

- filename;
- source label: **Managed** or **Legacy cache**;
- formatted file size;
- catalog model identity when known;
- status such as **Running**, **In progress**, **Invalid GGUF**, or **Unknown model**.

A removable row has a **Remove** button. Active or in-progress rows show **In use** with removal disabled. Selecting **Remove** opens a confirmation that names the file and states the disk space expected to be reclaimed. On success, RemindMe refreshes both inventory and catalog data immediately.

Inventory scan failures appear as a warning within this section and do not disable chat, inference, or the catalog. An empty inventory displays a clear **No downloaded model files found** message.

The existing catalog-card **Remove** action stays in place for compatibility. The new section is the reliable storage view even when catalog matching fails.

## Catalog reconciliation

Managed inventory entries whose filenames unambiguously match catalog variants contribute to catalog installed-state calculation. Legacy-cache matches do not become activatable automatically because activation expects a verified file in `/data/models`; they remain labeled as legacy cache entries until removed or downloaded through the manager.

Unknown managed files appear in inventory but do not gain catalog actions. Deleting any entry refreshes the catalog so a removed managed file no longer appears installed or verified.

## Error behavior

The manager returns stable, credential-free errors:

- `inventory_scan_failed` when an approved root cannot be inspected;
- `inventory_item_not_found` when an ID is unknown after rescanning;
- `model_protected` when the target is active or in progress;
- `invalid_inventory_target` for a non-regular file, symlink, or root escape;
- `remove_failed` for permission or filesystem failures.

A missing file discovered between resolution and deletion is a successful idempotent removal. Partial scan results are not returned as complete inventory; root-specific warnings may accompany otherwise successful results when one approved root is absent or unreadable.

## Security and privacy

- Inventory and deletion remain behind existing manager authentication.
- RemindMe proxies requests with the protected server-side token.
- Scans are confined to fixed roots and never follow symlinks.
- Deletion resolves opaque IDs from a fresh server-side scan rather than trusting browser paths.
- Responses expose basenames and categories, not physical paths.
- Tokens, signed URLs, checksums, and unrelated cached filenames are never returned.
- Bounds prevent pathological directory trees from exhausting memory or blocking the manager indefinitely.

## Testing

### Manager unit and integration tests

- discovers top-level and nested GGUF files under both approved roots;
- classifies managed and legacy-cache files;
- validates GGUF headers while retaining invalid `.gguf` files in inventory;
- matches known filenames and preserves unknown files;
- handles duplicate basenames with distinct deterministic IDs;
- produces IDs without embedding paths;
- ignores unrelated files and `.partial` downloads;
- does not follow directory or file symlinks;
- enforces depth and entry bounds;
- protects active and in-progress model paths;
- deletes a selected non-active file;
- treats an already-missing file idempotently when it disappears after resolution;
- reports permission and scan failures safely;
- reconciles managed inventory with catalog installed state.

### RemindMe server tests

- proxies inventory requests with manager authentication;
- proxies deletion without exposing tokens;
- preserves manager error status and safe message handling;
- invalidates pairing credentials consistently with existing manager routes.

### Browser tests

- renders known, unknown, invalid, and legacy-cache rows;
- formats sizes and statuses;
- shows confirmation before deletion;
- disables removal for protected files;
- refreshes inventory and catalog after success;
- shows empty and scan-error states without breaking the Models page.

## Compatibility and rollout

The feature is additive. Existing installations keep their current model configuration and manager state. The first inventory request discovers files already on disk without migration. Existing install, activate, YAML, credentials, pairing, SSE, and catalog endpoints remain unchanged.

The Local llama.cpp add-on and RemindMe add-on versions must both be bumped because the feature crosses the authenticated manager boundary and its UI proxy. Documentation will identify **Downloaded models** as the supported way to find and reclaim persistent model storage.
