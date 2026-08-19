# Journal, Photos, Measurements, and Activity Timeline

Companion design document for the Phase 1 slice that completes spec.md
sections 8.4 (Activity Timeline) and 12 (Journal, Photos, and Measurements).

## 1. Purpose

Grows, Plants, Cultivars, and Lifecycle Stages are complete. The remaining
Phase 1 gaps are the record-keeping surfaces that make a Plant's history
legible day to day: free-form journal entries, photos, quantitative
measurements, and a single chronological Activity Timeline that merges all
of it together with stage transitions.

## 2. Product Decisions

* Journal entries may belong to a Plant or a Grow (spec 12.1: "Plant or
  grow"). Photos and Measurements are Plant-only, matching spec 12.2/12.3,
  which list only "Plant" as their subject.
* The Activity Timeline (spec 8.4) is Plant-scoped for this slice. Grow-level
  timeline aggregation is part of spec section 11.2 "Grow Timeline", which
  belongs to the Phase 2 "Visual timeline" deliverable, not Phase 1 "Basic
  timeline". Grow-scoped journal entries remain visible on the Grow detail
  page as a plain list, without being merged into a cross-plant timeline.
* Journal entries carry a required `entry_type` drawn from the manual subset
  of spec 8.4's supported-events vocabulary (the events a person chooses when
  writing a note, as opposed to events a future domain module — irrigation,
  feeding — will emit automatically). Default is `note`.
* Photos store only the original upload for this slice. Spec 12.2 lists a
  "Thumbnail" field, but generating one server-side would add an image
  library (Pillow) to a multi-arch Alpine image (amd64, aarch64, armv7),
  which is a real cross-build risk for a first cut. The frontend renders the
  original with CSS-constrained sizing in grid/timeline views. Real
  server-side thumbnailing is deferred to Phase 5 (Release Hardening /
  performance).
* Uploaded photo content type is restricted to `image/jpeg`, `image/png`, and
  `image/webp`. Stored filenames are derived from the Photo's own UUID and
  the validated content type — never from the client-supplied filename — to
  remove any path-traversal or extension-spoofing surface.
* Files live under `{data_dir}/photos/{plant_id}/{photo_id}.{ext}`, outside
  the SQLite database, consistent with `/data` being the durable Supervisor
  volume. `backup_exclude` in `cultivation/config.yaml` already excludes only
  `*/cache/*`, so photo files are included in Supervisor backups by default.
* Measurements store a free `unit` string per record rather than a hard-coded
  canonical unit, because container/plant weight and custom metrics have no
  single natural unit. The frontend suggests sensible defaults (cm, g) but
  does not enforce them.

## 3. Scope

### Included

* `journal_entries`: Plant- or Grow-scoped notes with tags, an optional
  related Lifecycle Stage, an optional related-issue free-text field, and
  zero or more attached Photos.
* `measurements`: Plant-scoped quantitative records (height, width, canopy
  diameter, stem diameter, node count, container weight, plant weight, or a
  named custom metric).
* `photos`: Plant-scoped image uploads with caption, tags, optional Journal
  Entry attachment, and optional Measurement reference.
* A read-only, per-Plant Activity Timeline endpoint merging stage
  transitions, journal entries, measurements, and photos into one
  chronologically ordered feed.
* Frontend: a Plant detail "Activity" tab replacing the current
  lifecycle-only history view, with a composer for journal entries,
  measurements, and photo uploads, plus a photo grid view.

### Deferred

* Grow-level timeline merge (spec 11.2, Phase 2).
* Photo before/after and weekly comparison views (spec 12.2, Phase 2/5).
* Server-side thumbnail generation (Phase 5).
* Automatic timeline events from irrigation/feeding/reservoir domains (Phase
  2/3), since those domains do not exist yet.
* Photo export into reports (spec 12.2, Phase 4 reports).

## 4. Domain Boundaries

* `journal` is a new vertical slice owning `journal_entries`, `measurements`,
  and `photos` — they are record-keeping data, not lifecycle state, so they
  live outside `plants/` even though most routes nest under
  `/plants/{plant_id}`.
* The timeline projection is a read model assembled in `journal/service.py`
  from `journal`'s own repository plus a read-only query against
  `plant_stage_transitions` (via a small repository method on
  `PlantRepository`, mirroring how `grows/service.py` already reads
  `GrowSpace` for validation without owning it).
* Photo file I/O is isolated behind a small `journal/storage.py` module so
  the service layer never touches the filesystem directly and tests can
  substitute a temporary directory.

## 5. Data Model

### 5.1 `journal_entries`

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| subject_type | text | `plant` or `grow`, check-constrained |
| subject_id | UUID | FK to `plants.id` or `grows.id` depending on `subject_type`; enforced in the service layer (SQLite cannot do a conditional FK) |
| entry_type | text | check-constrained to the manual vocabulary (below) |
| occurred_at | datetime (UTC) | when the entry describes; defaults to creation time |
| title | text, nullable | |
| notes | text, nullable | |
| tags | JSON list[str] | default `[]` |
| related_stage_id | UUID, nullable | FK `lifecycle_stages.id`, RESTRICT; only meaningful when `subject_type == plant` |
| related_issue | text, nullable | free text |
| created_at / updated_at | datetime (UTC) | |

`entry_type` values: `watered`, `fed`, `transplanted`, `topped`, `trained`,
`defoliated`, `light_schedule_changed`, `flowering_initiated`,
`first_flowers_observed`, `problem_observed`, `treatment_applied`,
`harvested`, `drying_started`, `jarred`, `cure_milestone`, `note`.

(The remaining spec 8.4 events — `Reservoir refilled`, `Irrigation
completed`, `Photo added`, `Measurement recorded` — are timeline-only labels
produced by other tables, not values a person picks for a Journal Entry.)

Indexes: `(subject_type, subject_id, occurred_at)` for timeline assembly and
list queries.

### 5.2 `measurements`

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| plant_id | UUID | FK `plants.id`, CASCADE |
| metric_type | text | check-constrained: `height`, `width`, `canopy_diameter`, `stem_diameter`, `node_count`, `container_weight`, `plant_weight`, `custom` |
| custom_metric_name | text, nullable | required (service-enforced) when `metric_type == custom` |
| value | numeric (float) | |
| unit | text | free text, e.g. `cm`, `g`, `count` |
| occurred_at | datetime (UTC) | defaults to creation time |
| notes | text, nullable | |
| created_at / updated_at | datetime (UTC) | |

Index: `(plant_id, occurred_at)`.

### 5.3 `photos`

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| plant_id | UUID | FK `plants.id`, CASCADE |
| journal_entry_id | UUID, nullable | FK `journal_entries.id`, SET NULL |
| measurement_id | UUID, nullable | FK `measurements.id`, SET NULL |
| stage_id | UUID, nullable | FK `lifecycle_stages.id`, RESTRICT — the Plant's stage at capture time, defaulted from the Plant's current stage |
| caption | text, nullable | |
| tags | JSON list[str] | default `[]` |
| file_path | text | relative to `{data_dir}/photos/` |
| content_type | text | one of the allowlisted MIME types |
| file_size | integer | bytes, for basic client-side display and future quota work |
| occurred_at | datetime (UTC) | defaults to creation time |
| created_at / updated_at | datetime (UTC) | |

Index: `(plant_id, occurred_at)`.

Deleting a Photo removes both the DB row and the underlying file
(best-effort; a missing file on disk is not a delete failure).

## 6. Timeline Projection Rules

`GET /api/v1/plants/{plant_id}/timeline` returns entries sorted by
`occurred_at` descending, each shaped as:

```json
{
  "id": "string",
  "event_type": "string",
  "occurred_at": "datetime",
  "summary": "string",
  "journal_entry": { ... } | null,
  "measurement": { ... } | null,
  "photo": { ... } | null,
  "stage_transition": { ... } | null
}
```

Exactly one of the four detail fields is populated per entry:

* Stage transitions project `event_type = "stage_changed"` with a summary
  like `"Seedling → Vegetative"` (or `"→ Seedling"` for the first transition,
  since `from_stage_id` is null there).
* Journal entries project `event_type = entry.entry_type` with `summary =
  entry.title or entry.entry_type`.
* Measurements project `event_type = "measurement_recorded"` with a summary
  like `"Height: 32 cm"`.
* Photos project `event_type = "photo_added"` unconditionally, even when
  attached to a Journal Entry, so a quick photo capture and a written note
  both surface as distinct, findable moments.

Pagination: offset/limit like the existing list endpoints, default limit
50, max 200.

## 7. API Design

```text
GET    /api/v1/plants/{plant_id}/journal-entries
POST   /api/v1/plants/{plant_id}/journal-entries
GET    /api/v1/grows/{grow_id}/journal-entries
POST   /api/v1/grows/{grow_id}/journal-entries
PATCH  /api/v1/journal-entries/{id}
DELETE /api/v1/journal-entries/{id}

GET    /api/v1/plants/{plant_id}/measurements
POST   /api/v1/plants/{plant_id}/measurements
PATCH  /api/v1/measurements/{id}
DELETE /api/v1/measurements/{id}

GET    /api/v1/plants/{plant_id}/photos
POST   /api/v1/plants/{plant_id}/photos          (multipart/form-data)
GET    /api/v1/photos/{id}/file
PATCH  /api/v1/photos/{id}                       (caption/tags/links only)
DELETE /api/v1/photos/{id}

GET    /api/v1/plants/{plant_id}/timeline
```

Entry/measurement/photo mutation routes are flat (`/journal-entries/{id}`,
not nested) once created, matching how a single record is addressed
independent of its parent — the same pattern would apply if Grows ever
needed a similar flat update route. Creation stays nested because the
subject is required input, not derivable from the body alone for the
Grow case.

`POST .../photos` accepts `multipart/form-data` with a `file` part and
optional `caption`, `tags` (repeated form field or JSON-encoded string),
`journal_entry_id`, `measurement_id`, `stage_id`, and `occurred_at` fields.
Files over 15 MB or outside the content-type allowlist return `422` with a
machine-readable `code`.

## 8. Service and Transaction Behavior

* All writes go through `Database.transaction()` and call `audit_record()`
  inside the same transaction, matching every existing slice.
* Photo creation order: validate content type/size → begin transaction →
  insert the `Photo` row (to obtain its UUID) → write audit row → commit →
  **then** write the file to disk using the committed Photo's id. If the
  file write fails after commit, the row is deleted in a best-effort cleanup
  transaction and the request fails with `502`. This ordering (DB commit
  before disk write) avoids ever referencing a database row for a file that
  doesn't exist, which is the more common failure mode and the one the
  timeline/detail views actually read.
* Photo deletion: delete the DB row inside a transaction first (with its own
  audit row), then delete the file from disk after commit succeeds. A
  missing file at that point is logged, not raised.
* Journal Entry `subject_type`/`subject_id` validation happens in the
  service: `plant` must resolve via `PlantRepository`, `grow` via
  `GrowRepository`; a dangling reference raises `JournalValidationError`
  before any row is written.
* `related_stage_id` and Photo `stage_id` are validated against
  `LifecycleRepository` the same way Plant creation validates
  `current_stage_id` today.

## 9. Frontend Experience

### 9.1 Plant detail — Activity tab

Replaces the existing plain "Lifecycle history" list on `PlantDetailPage`
with a tabbed view: **Activity** (the merged timeline) and **Photos** (grid).
The Activity tab keeps showing stage transitions exactly as today, now
interleaved with journal/measurement/photo entries. A composer bar above the
feed offers three quick actions: **Add note**, **Log measurement**, **Add
photo** — each opens a small inline form rather than a full-page navigation,
consistent with `StageTransitionDialog`'s existing dialog pattern.

### 9.2 Grow detail — Journal section

A simple reverse-chronological list of Grow-scoped journal entries with the
same "Add note" composer, no timeline merge.

### 9.3 Photo grid

Plant detail's Photos tab shows a responsive grid of thumbnails (rendered
from the original via CSS `object-fit: cover`), each opening a lightbox with
caption/tags and a delete action.

## 10. Validation and Error Handling

* `JournalNotFound` / `MeasurementNotFound` / `PhotoNotFound` → 404.
* `JournalValidationError` (bad subject reference, bad entry_type, oversized
  or wrong-content-type photo, missing `custom_metric_name` for a custom
  measurement) → 422.
* Photo storage I/O failure after a committed row → 502, with the row
  cleaned up.
* All list endpoints support `include_archived`-style filtering is not
  needed here (no soft-delete state on these records — delete is real
  delete, matching spec's record-keeping nature; only Plants/Grows/Grow
  Spaces are archivable, not their journal trail).

## 11. Migration and Compatibility

New Alembic migration `0005_journal_photos_measurements.py` adds
`journal_entries`, `measurements`, and `photos`. No existing table changes.
Downgrade drops all three in FK-safe order (`photos` → `measurements` →
`journal_entries`).

## 12. Testing Strategy

### Backend

* Migration upgrade/downgrade tests (`test_journal_migration.py`), including
  a full-record downgrade check like the `0004` migration test.
* `journal/rules.py` unit tests for entry_type validation and the
  custom-metric-name requirement (pure functions, no DB).
* API tests per resource (`test_journal_entry_api.py`,
  `test_measurement_api.py`, `test_photo_api.py`) covering create/list/
  update/delete, validation errors, and cross-subject scoping.
* `test_photo_storage.py` for the storage module in isolation (temp dir,
  content-type allowlist, path derivation, delete-is-idempotent).
* `test_plant_timeline_api.py` covering ordering, pagination, and that each
  entry populates exactly one detail field.

### Frontend

* Typed API client tests for all five new resources (Ingress-relative URLs,
  multipart photo upload).
* `PlantDetailPage` Activity tab test: merged feed renders in order, composer
  actions work.
* Photo grid test: renders thumbnails, opens lightbox, delete removes it from
  the grid.
* Grow detail journal section test.

### Final verification

Same gate as every prior slice: `pnpm verify` (ESLint, Ruff, mypy, Vitest,
pytest, TypeScript, production build), OpenAPI export, add-on context sync,
fresh + upgrade migration smoke test, and container smoke tests in both
degraded and authenticated modes.

## 13. Release and Publication

Same flow as the `0.3.0` release: version bump (this ships as `0.4.0`,
migration head `0005`), changelog entry, `docs/openapi.json` regeneration,
`pnpm sync:addon`, Docker build + both container smoke modes, commit into the
publication clone under `cultivation-assistant/`, committed-archive build
check, push, and a PR against `main`.

## 14. Acceptance Criteria

1. A user can write a Plant or Grow journal entry with a title, notes, tags,
   an optional related stage, and an optional related issue.
2. A user can attach one or more photos to a journal entry, or upload a
   photo standalone.
3. A user can log a measurement against a Plant, including a named custom
   metric with its own unit.
4. A Plant's Activity tab shows stage transitions, journal entries,
   measurements, and photos in one chronological feed.
5. Photo upload rejects disallowed content types and oversized files with a
   clear, machine-readable error.
6. Deleting a photo removes both its database row and its file.
7. All new endpoints follow the existing error envelope, audit logging, and
   transaction-boundary conventions.
8. `pnpm verify` passes with zero new lint/type warnings.
9. Fresh (`0001→0005`) and upgrade (`0004→0005`) migrations both succeed and
   are covered by tests.
10. Both container smoke-test modes (degraded, authenticated) show no
    tracebacks and a `0005` schema revision.
