# Home Assistant File Explorer Add-on Design

## Purpose

Create a standalone Home Assistant add-on that provides an administrator-only file explorer through Home Assistant ingress. The first version supports full file management for explicitly enabled Home Assistant roots while keeping filesystem policy, backups, and destructive-operation safety server-side.

The add-on is independent of the existing RemindMe AI add-on and lives under `homeassistant-addons/file-explorer/`.

## Scope

### Included in v1

- Browse selectable `/config`, `/share`, and `/media` roots.
- Preview supported files and download all regular files.
- Edit text files with a simple editor.
- Create files and folders.
- Rename and move files and folders within enabled roots.
- Upload and download files.
- Move deleted items to trash, restore them, or purge them permanently.
- Create timestamped backups before overwriting existing files.
- Search file and folder names and bounded text-file content.
- Work on desktop, tablet, and mobile through Home Assistant ingress.

### Deferred

- IDE autocomplete, diagnostics, command palettes, and code formatting.
- Shell or terminal access.
- Multi-user read/write roles.
- Remote mounts and cloud storage.
- `/ssl` and `/backup` roots.

## Architecture

The implementation is a standalone TypeScript and Node.js add-on with an Express backend and a locally served browser interface. It exposes no separate login or public application port. Home Assistant ingress is the only browser entry point, and the sidebar panel is restricted to administrators.

The browser communicates with compact JSON endpoints and streamed upload/download responses using stable root IDs and normalized relative paths. It never receives unrestricted host filesystem paths.

The add-on maps `/config`, `/share`, and `/media`. Add-on options determine which mapped roots appear in the explorer. The backend builds a root registry at startup and rejects operations for disabled or unavailable roots.

## Component Boundaries

### Browser interface

- **Application shell:** ingress-safe routing, adaptive Home Assistant theme, responsive pane state, global notifications, and dialogs.
- **Root and file tree:** root switching, folder expansion, selection, keyboard navigation, and refresh.
- **Viewer/editor:** supported previews, simple text editing, dirty-state protection, save conflicts, and downloads.
- **Command surfaces:** toolbar, contextual menus, upload progress, search, trash, and restore actions.

### Backend

- **Root registry:** turns add-on options and mounted directories into stable root IDs.
- **Path policy:** centrally authorizes every source and target path, operation, symlink, protected path, and configured limit.
- **Filesystem service:** lists, reads, streams, creates, uploads, atomically saves, renames, moves, and deletes.
- **Search service:** performs cancellable, bounded directory walks with filename and text-content matching.
- **Safety service:** manages timestamped pre-save backups, trash manifests, restore operations, retention, and purge.
- **HTTP API:** validates request shapes and translates domain errors into stable API error codes.

Each filesystem endpoint must use the same path-policy service. Route handlers cannot resolve or mutate paths directly.

## Data Flow

### Reads

1. The browser sends a root ID and relative path.
2. The API validates the request shape and limits.
3. The path policy resolves and verifies the requested path beneath the enabled root.
4. The filesystem or search service reads bounded content and metadata.
5. The API returns normalized metadata, JSON content, or a streamed response.

### Writes

1. The browser sends the operation, root ID, relative source, and optional relative target.
2. The API and path policy validate the source, target, type, permissions, and limits.
3. The safety service creates the required backup or trash record.
4. The filesystem service performs the mutation atomically where supported.
5. The API returns current metadata so the browser can update without assuming success.

Cross-device moves use copy-then-delete only after the copy completes successfully.

## Interaction Design

The explorer uses an adaptive two-pane layout:

- A collapsible root and file tree occupies the left pane.
- The right pane contains the file preview or simple text editor.
- On narrow screens, the tree becomes a slide-over and the content pane uses the full width.

The top toolbar exposes search, new item, upload, and trash. Rename, move, download, and delete are available through contextual or overflow menus. Dirty state, upload progress, conflicts, read-only state, and failures are always visible.

Opening another file with unsaved changes requires an explicit discard or save decision. Save requests include the file's last-known modification signature. If the file changed externally, the editor refuses to overwrite it and offers reload or save-as.

The interface supports keyboard tree navigation, focus restoration, predictable Escape behavior, and touch-friendly controls.

## Visual System

The interface follows Home Assistant theme variables rather than defining a fixed branded palette. It adapts automatically to the user's light or dark Home Assistant theme.

- Home Assistant blue is reserved for primary actions, selection, and focus.
- Surfaces, dividers, text, and disabled states derive from Home Assistant theme tokens.
- Error, warning, and success colors use semantic theme values.
- The layout avoids heavy navy surfaces and excessive saturation.
- Icons are bundled locally or use ingress-safe Home Assistant-compatible assets; no runtime CDN is required.

## File Handling

The editor accepts only files classified as bounded text content. The text-editing limit, content-search file-size limit, upload limit, search result cap, and search duration are configurable with safe defaults.

Large or binary files remain available for download and for supported previews. Uploads and downloads stream rather than buffering entire files in memory. Interrupted uploads and temporary files are cleaned up.

Protected trash and backup directories are hidden from ordinary browsing and cannot be changed through general file operations.

## Trash and Backups

Deleting a file or folder moves it into add-on-managed trash and writes a manifest containing its original root, path, deletion time, type, and stored location. Restore detects destination conflicts and requires an explicit replacement or alternate name.

Before replacing an existing file, the safety service stores its prior contents in timestamped backup storage. New content is written to a temporary sibling, flushed, and atomically replaces the destination where the platform supports it.

Trash and backup retention are configurable. Permanent purge is a separate confirmed action.

## Search

Search supports names and bounded text content within the selected enabled root. It:

- Skips trash, backups, configured ignored paths, and unsupported binary content.
- Returns normalized relative paths and bounded match excerpts.
- Caps results and scan duration.
- Supports cancellation when the query or root changes.
- Reports partial read failures without discarding successful results.

No persistent content index is required for v1.

## Security

- Home Assistant ingress is the only browser entry point.
- The panel is administrator-only.
- Every path is represented by a root ID and relative path.
- Canonical path resolution must keep source and target paths within the selected root.
- Traversal, absolute paths, encoded separator tricks, and symlink escapes are rejected.
- Protected internal storage cannot be addressed through general file APIs.
- Browser code never receives Supervisor credentials or unrestricted host paths.
- Operation, file-size, result, and duration limits are enforced server-side.
- User-visible confirmation is required for permanent purge and overwrite-like conflict resolution.

## Error Handling

The API returns stable machine-readable codes with safe messages, including:

- `PATH_OUTSIDE_ROOT`
- `ROOT_DISABLED`
- `NOT_FOUND`
- `NAME_CONFLICT`
- `FILE_CHANGED`
- `TOO_LARGE`
- `UNSUPPORTED_FILE`
- `READ_ONLY_ROOT`
- `SEARCH_LIMIT_REACHED`

The browser maps each code to a specific recovery action. Failed mutations do not update the UI optimistically. Partial search failures remain visible, failed uploads remove temporary data, and failed cross-device moves preserve the source.

## Testing

### Unit tests

- Path-policy tests cover traversal, absolute paths, encoded separators, symlink escapes, disabled roots, protected paths, and source/target combinations.
- Filesystem tests cover listing, reading, atomic saving, backups, trash manifests, restore, purge, moves, and conflicts.
- Search tests cover filename and text matching, ignored paths, binary detection, result and duration limits, cancellation, and partial failures.

### Integration tests

- API tests cover request validation, stable error codes, streamed upload/download, save-conflict detection, and root configuration.
- Every filesystem endpoint runs against the same malicious path corpus so new routes cannot bypass central policy.
- Tests use temporary mapped directories and never touch a real Home Assistant installation.

### Interface and end-to-end tests

- UI tests cover root switching, tree navigation, dirty-state protection, dialogs, context actions, search results, keyboard behavior, and responsive pane changes.
- An end-to-end smoke test performs create, edit, rename, search, delete, restore, upload, and download against temporary roots.
- Manual Home Assistant verification covers installation, admin-only ingress, arbitrary ingress prefixes, adaptive light/dark theming, desktop layout, and mobile layout.

## Completion Criteria

The feature is complete when:

- The add-on builds for its declared Home Assistant architectures.
- Administrator-only ingress loads all local assets under arbitrary ingress prefixes.
- Selectable `/config`, `/share`, and `/media` roots work as configured.
- Full file operations, search, trash, restore, backups, uploads, and downloads pass automated tests.
- The shared path-policy security corpus passes for every filesystem endpoint.
- Save conflicts and failed operations preserve user data.
- The interface follows Home Assistant light and dark themes and works on desktop and mobile.
