# Grows, Plants, and Lifecycle Tracking

**Date:** 2026-07-23

**Status:** Ready for user review

**Scope:** Next Phase 1 vertical slice after Grow Spaces

## 1. Purpose

Add the first usable cultivation-record layer on top of Grow Spaces. Users can
create a Grow within a physical Grow Space, add individually identifiable
Plants, associate each Plant with a minimal structured cultivar record, and
record an auditable lifecycle history using customizable stages.

This milestone establishes the identities and event history required by later
journals, photos, measurements, projected timelines, feeding, costs, yield, and
reports. It does not implement those later capabilities.

## 2. Product Decisions

The approved design uses these decisions:

- A Grow is a first-class record and belongs to one Grow Space.
- A Grow can contain one or more individually identifiable Plants.
- Plants are created individually. A Duplicate action opens a prefilled creation
  form but never copies lifecycle history.
- Cultivars are minimal structured records rather than free text.
- A cultivar's breeder is optional so unknown, local, or gifted genetics can be
  recorded honestly.
- Lifecycle stage definitions are installation-wide, stable records. Users can
  rename, disable, reorder, or add stages.
- A Plant may transition to any enabled stage after explicit confirmation.
  Backward and skipped transitions are valid because corrections, imports, and
  re-vegetation are real workflows.
- Stage transition history is append-only. Corrections are represented by a new
  transition, not by rewriting prior history.
- Consequential mutations and their audit records commit or roll back together.

## 3. Scope

### Included

- Minimal breeder and cultivar records
- Installation-wide lifecycle stage definitions and customization
- Grow creation, listing, detail, editing, status changes, and filtering
- Plant creation, listing, detail, editing, status changes, and filtering
- Plant Duplicate workflow
- Audited lifecycle-stage transitions
- Backdated transitions and deterministic current-stage calculation
- Grow- and Plant-focused frontend routes
- Loading, empty, validation, conflict, inactive-parent, and retry states
- Migration, OpenAPI, packaging, release, and container verification

### Deferred

- Full breeder and cultivar library fields
- Source provenance and verification workflows
- Timeline projections, confidence, and projection versioning
- Journal entries, activity events, photos, and measurements
- Environment targets and stage-specific guidance
- Feeding plans and actual feeding records
- Reservoir and irrigation records
- Costs, yield projections, harvest reports, and exports
- Custom stage sets per Grow
- Batch Plant creation
- Home Assistant entities or actions for individual Plants

## 4. Domain Boundaries

The feature remains a vertical slice in the modular monolith.

- `library` owns minimal Breeder and Cultivar identity records.
- `lifecycle` owns installation-wide stage definitions and transition rules.
- `grows` owns Grow records and their relationship to Grow Spaces.
- `plants` owns Plant records, duplication drafts, and lifecycle transitions.
- The existing audit infrastructure records consequential changes.
- Home Assistant is not required for these local cultivation records.

The domain layer remains independent of FastAPI and Home Assistant. Routers map
stable HTTP contracts onto application services; repositories contain database
queries and no HTTP policy.

## 5. Data Model

Alembic revision `0004` adds the following tables. UUID strings and UTC
timestamps follow the existing project conventions.

### 5.1 `breeders`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `name` | string | Required, trimmed, case-insensitively unique |
| `active` | boolean | Defaults to true |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

A breeder can be made inactive but is not physically deleted when referenced.
Inactive breeders remain readable and selectable when editing an existing
cultivar that already references one.

### 5.2 `cultivars`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `name` | string | Required and trimmed |
| `breeder_id` | UUID string or null | Optional foreign key to `breeders` |
| `seed_type` | string | `regular`, `feminized`, `autoflower`, or `unknown` |
| `active` | boolean | Defaults to true |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

Cultivar identity is case-insensitively unique by `(breeder_id, name,
seed_type)`. The service handles the null-breeder case explicitly because SQLite
unique constraints treat null values as distinct.

These fields are intentionally smaller than the eventual cultivar library. Later
migrations can add lineage, flowering ranges, traits, descriptions, provenance,
and verification without changing Plant identity.

### 5.3 `lifecycle_stages`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `key` | string | Stable, unique machine identifier |
| `label` | string | Required user-facing name |
| `position` | integer | Non-negative display order |
| `enabled` | boolean | Defaults to true |
| `built_in` | boolean | True for seeded defaults |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

Revision `0004` seeds deterministic built-in records in this order:

1. Seed
2. Germination
3. Seedling
4. Vegetative
5. Transition
6. Flowering
7. Finishing
8. Harvest
9. Drying
10. Curing
11. Completed

Built-in keys never change when labels are renamed. Built-in stages cannot be
physically deleted; users disable them. A custom stage can be physically deleted
only while unreferenced. Once referenced, it can only be disabled. Disabled
stages remain readable in history but are excluded from new-transition choices.

Reordering is atomic. The API accepts the complete ordered ID list and assigns
contiguous positions, preventing duplicate or sparse ordering.

### 5.4 `grows`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `grow_space_id` | UUID string | Required foreign key to `grow_spaces` |
| `name` | string | Required and trimmed |
| `status` | string | `planned`, `active`, `completed`, or `archived` |
| `start_date` | date or null | Required when status is `active` or `completed` |
| `end_date` | date or null | Optional; cannot precede start date |
| `notes` | text or null | Optional |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

Grow names are case-insensitively unique within one Grow Space among
non-archived Grows. Archived Grows remain readable, editable, and restorable;
restoration reapplies the uniqueness rule.

A Grow Space may contain multiple simultaneous active Grows. The application
does not impose a one-Grow-per-space rule because perpetual and overlapping
cultivation cycles are valid.

A Grow may be created in an inactive Grow Space, but the UI warns that the
physical space is inactive. Inactivating a Grow Space does not alter Grow or
Plant history.

### 5.5 `plants`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `grow_id` | UUID string | Required foreign key to `grows` |
| `cultivar_id` | UUID string | Required foreign key to `cultivars` |
| `name` | string | Required and trimmed |
| `propagation_source` | string | `seed` or `clone` |
| `seed_type` | string or null | Plant-specific value for seed; null for clone |
| `start_date` | date or null | Required when status is `active` or later |
| `current_stage_id` | UUID string | Required foreign key to `lifecycle_stages` |
| `status` | string | `planned`, `active`, `harvested`, `completed`, `lost`, or `archived` |
| `container` | string or null | Optional free-text container description |
| `medium` | string or null | Optional free-text medium description |
| `location` | string or null | Optional location within the Grow Space |
| `expected_harvest_start` | date or null | User-entered plan only |
| `expected_harvest_end` | date or null | User-entered plan only |
| `actual_harvest_date` | date or null | Actual record only |
| `notes` | text or null | Optional |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

Plant names are case-insensitively unique within one Grow among non-archived
Plants. The cultivar remains required, but its breeder may be unknown. The Plant
wizard can create a minimal cultivar inline without leaving the workflow.

`seed_type` defaults from the selected cultivar for seed-grown Plants but can be
overridden because an individual seed or source lot may differ. Clone-grown
Plants store null `seed_type`.

Expected harvest dates are explicitly user-entered plans. No projection engine is
implied in this milestone. Actual harvest date remains separate.

### 5.6 `plant_stage_transitions`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `plant_id` | UUID string | Required foreign key to `plants` |
| `from_stage_id` | UUID string or null | Null only for the initial event |
| `to_stage_id` | UUID string | Required foreign key to `lifecycle_stages` |
| `effective_at` | UTC datetime | User-selected effective time |
| `source` | string | `user_confirmed`, `user_adjusted`, `imported`, or `application_recalculation` |
| `notes` | text or null | Optional explanation |
| `created_at` | UTC datetime | Immutable server timestamp |

Creating a Plant inserts its initial transition in the same transaction. Normal
UI transitions use `user_confirmed`. A backward or skipped transition requires a
confirmation step and stores `user_adjusted` unless the caller explicitly uses
an import source.

Transition rows are append-only. They are never edited or deleted through the
public API. A correction is another transition with an explanatory note.

The authoritative current stage is the `to_stage_id` of the latest transition
ordered by `(effective_at, created_at, id)`. `plants.current_stage_id` is a
transactionally maintained projection for efficient lists. Inserting a backdated
transition recalculates this projection; it does not incorrectly replace a later
stage.

## 6. Lifecycle and Status Rules

### Grow status

- `planned` may omit dates.
- `active` requires `start_date`.
- `completed` requires `start_date`; `end_date` is strongly prompted but not
  required so incomplete imported records can be retained.
- `archived` is reversible and preserves all Plants and history.

### Plant status

- `planned` may omit `start_date`.
- `active`, `harvested`, `completed`, and `lost` require `start_date`.
- `actual_harvest_date` is accepted only for `harvested` or `completed`.
- A new Plant must choose an enabled initial stage; disabling that stage later
  does not alter the Plant or its history.
- `completed` does not require the current stage to be Completed; the UI warns
  and offers a final stage transition rather than silently inventing history.
- `archived` is reversible and preserves lifecycle history.

Status changes never create implicit stage transitions. Stage and status are
related but record different facts. The UI may offer combined actions, but the
backend performs the requested mutations explicitly in one transaction.

## 7. API Design

All routes use the existing `/api/v1` prefix and stable error envelope.

### Breeders and cultivars

- `GET /breeders?include_inactive=false`
- `POST /breeders`
- `PATCH /breeders/{breeder_id}`
- `GET /cultivars?include_inactive=false&breeder_id={id}&query={text}`
- `POST /cultivars`
- `PATCH /cultivars/{cultivar_id}`

The first UI primarily uses a searchable cultivar combobox with inline minimal
creation. A complete Library route remains deferred.

### Lifecycle stages

- `GET /lifecycle-stages?include_disabled=true`
- `POST /lifecycle-stages`
- `PATCH /lifecycle-stages/{stage_id}`
- `PUT /lifecycle-stages/order`
- `DELETE /lifecycle-stages/{stage_id}` for unreferenced custom stages only

### Grows

- `GET /grows`
  - filters: `grow_space_id`, repeated `status`, `include_archived`
  - returns Plant counts and compact status summaries
- `POST /grows`
- `GET /grows/{grow_id}`
  - returns Grow details and compact Plants
- `PATCH /grows/{grow_id}`
- `DELETE /grows/{grow_id}`
  - backward-compatible archive operation, never physical deletion

### Plants

- `GET /plants`
  - filters: `grow_id`, `grow_space_id`, repeated `status`, `stage_id`,
    `include_archived`, and text query
- `POST /plants`
- `GET /plants/{plant_id}`
  - returns Plant details and ordered transition history
- `PATCH /plants/{plant_id}`
- `DELETE /plants/{plant_id}`
  - backward-compatible archive operation
- `POST /plants/{plant_id}/stage-transitions`
  - accepts destination stage, effective time, source, notes, and explicit
    confirmation for backward or skipped transitions

Duplication is a frontend-assisted creation flow rather than a special mutation.
The client loads the source Plant, builds a safe draft, clears identity/history
fields, proposes a unique name, and submits the ordinary Plant create endpoint.
This avoids hidden copying rules and keeps creation validation authoritative.

## 8. Service and Transaction Behavior

Each behavior-bearing resource follows the existing schema → repository →
service → router layering.

- Services normalize text and enforce cross-record validation.
- Repositories perform focused SQLAlchemy queries and flushing.
- Create, patch, status change, stage transition, and audit rows share one
  database transaction.
- Foreign records are loaded and validated before mutation.
- Case-insensitive uniqueness checks exclude the current record during updates.
- Stage reordering locks the logical operation within one transaction and rejects
  missing, duplicate, unknown, or incomplete ID sets.
- Plant creation inserts the Plant, initial stage transition, and audit record
  atomically.
- A stage transition inserts the immutable transition, recalculates
  `current_stage_id`, updates the Plant timestamp, and writes the audit record
  atomically.

Audit actions include:

- `breeder.created`, `breeder.updated`, `breeder.deactivated`,
  `breeder.reactivated`
- `cultivar.created`, `cultivar.updated`, `cultivar.deactivated`,
  `cultivar.reactivated`
- `lifecycle_stage.created`, `lifecycle_stage.updated`,
  `lifecycle_stage.reordered`, `lifecycle_stage.disabled`
- `grow.created`, `grow.updated`, `grow.archived`, `grow.restored`
- `plant.created`, `plant.updated`, `plant.archived`, `plant.restored`
- `plant.stage_transitioned`

Audit details include changed fields and relevant parent IDs but no secrets or
unbounded notes.

## 9. Frontend Experience

The interface keeps the Ministry of Elsewhere structure, restrained Art Nouveau
details, Civic Chimera dark mode, accessible status text, and reduced-motion
behavior established by Grow Spaces.

### 9.1 Plants register

The existing `/plants` placeholder becomes the primary Grows and Plants
register. It provides:

- Page heading and New Grow action
- Filters for Grow Space, Grow status, Plant status, and archived records
- Grow cards grouped by Grow Space
- Plant counts, current-stage distribution, dates, and status
- Expandable compact Plant rows
- Empty, filtered-empty, loading, failure, and retry states

The page prioritizes active records while retaining explicit access to planned,
completed, lost, and archived history.

### 9.2 New Grow flow

A focused dialog or drawer collects:

- Grow Space
- Grow name
- Status
- Start date
- Optional end date and notes

After creation, the user lands on `/grows/{growId}` and is prompted to add the
first Plant.

### 9.3 Grow detail

`/grows/{growId}` displays:

- Grow identity, Grow Space link, status, and dates
- Edit action
- Plant register within the Grow
- Add Plant action
- Compact stage distribution
- Deferred capability panels for timeline, journal, feeding, and costs

### 9.4 Plant creation and editing

The Plant form collects:

- Plant name
- Cultivar search/select
- Inline Add cultivar flow with optional breeder
- Seed or clone
- Seed type when seed is selected
- Start date
- Initial/current stage
- Status
- Container, medium, and location
- Optional expected harvest window
- Notes

The same core form is reused for editing. An existing inactive cultivar or
disabled current stage remains visible during editing but is not offered for new
selections.

### 9.5 Plant detail and lifecycle

`/plants/{plantId}` displays:

- Identity, cultivar, breeder, Grow, and Grow Space
- Current status and current stage
- Plan-versus-actual date fields shown separately
- Cultivation details
- Ordered lifecycle transition history
- Edit, Duplicate, Change stage, and Archive/Restore actions

Change stage opens a confirmation dialog with destination stage, effective date
and time, and optional notes. Backward or skipped moves receive stronger text
explaining that the event changes the current lifecycle record but does not erase
history.

Duplicate opens the creation form with Grow, cultivar, propagation source,
container, medium, and location prefilled. It proposes a unique new name and
clears IDs, start and harvest dates, notes, status history, and all transition
history. The user reviews and submits a normal creation request.

### 9.6 Lifecycle stage settings

A Lifecycle stages panel under Settings allows users to:

- Rename stage labels
- Drag or keyboard-reorder stages
- Enable or disable stages
- Add custom stages
- Remove only unreferenced custom stages

The panel explains that disabling a stage preserves existing history.

## 10. Validation and Error Handling

- Missing parents return `404`.
- Duplicate breeder, cultivar, Grow, or Plant identity returns `409`.
- Invalid state-dependent dates or statuses return `422`.
- Selecting an inactive cultivar for a new Plant returns `422`.
- Transitioning to a disabled stage returns `422`.
- Backward or skipped transitions without explicit confirmation return `409`
  with a machine-readable confirmation requirement.
- Deleting a built-in or referenced custom stage returns `409`.
- An incomplete or duplicate stage order returns `422` and leaves ordering
  unchanged.
- Failed forms retain entered values and focus the error summary.
- Parent inactivity is shown as a warning, not silently treated as deletion.
- The feature remains available when Home Assistant is disconnected.

## 11. Data Flow

### Plant creation

1. The user opens Add Plant within a Grow.
2. The client loads active cultivars and enabled lifecycle stages.
3. The user selects or creates a minimal cultivar.
4. The typed client submits the Plant create contract.
5. The service validates Grow, cultivar, stage, dates, status, and name.
6. Plant, initial transition, and audit row commit atomically.
7. TanStack Query updates or invalidates Grow, Plant-list, and Plant-detail
   caches.
8. The UI navigates to the new Plant detail.

### Stage transition

1. The user chooses any enabled stage and an effective time.
2. The client identifies non-adjacent movement for explanatory confirmation;
   backend validation remains authoritative.
3. The service inserts an append-only transition.
4. The service recalculates the current stage from ordered transition history.
5. Plant projection and audit row commit atomically.
6. List, Grow detail, and Plant detail caches refresh.

## 12. Migration and Compatibility

Revision `0004` depends on `0003`. It creates new tables and deterministic
built-in lifecycle stages without altering Grow Space or mapping records.

Downgrade removes Plant transitions before Plants, then Grows, lifecycle stages,
cultivars, and breeders in foreign-key-safe order. Downgrade is tested on both an
empty database and a database containing representative records.

No existing API contract is removed. Grow Spaces remain universal physical
containers. New Grow and Plant capabilities attach by foreign key without
changing environmental mappings.

## 13. Testing Strategy

All behavior-bearing work follows red-green-refactor TDD.

### Backend

Tests cover:

- `0004` upgrade, deterministic stage seeding, and downgrade
- Breeder and cultivar uniqueness, including null breeder
- Cultivar inactive behavior
- Stage rename, disable, custom creation, deletion protection, and atomic order
- Grow CRUD, status/date rules, filters, archive/restore, and uniqueness
- Multiple active Grows in one Grow Space
- Plant CRUD, cultivar requirement, seed/clone rules, date rules, and uniqueness
- Initial transition creation
- Adjacent, skipped, backward, and backdated transitions
- Deterministic current-stage recalculation
- Append-only history
- Duplicate creation through the ordinary create contract
- Transactional audit rollback on failure
- Operation while Home Assistant is unavailable
- Stable OpenAPI contracts and error envelopes

### Frontend

Tests cover:

- Grow/Plant register loading, empty, filtered, error, and populated states
- New Grow creation
- Plant creation with existing cultivar
- Inline cultivar creation with no breeder
- Seed/clone conditional fields
- Grow and Plant editing
- Duplicate draft clearing and prefill rules
- Current-stage and status display
- Adjacent and non-adjacent transition confirmation
- Backdated transition submission
- Lifecycle stage keyboard reordering and disabled-history display
- Cache updates and Ingress-relative requests
- Responsive, keyboard, screen-reader, dark-mode, and reduced-motion behavior

### Final verification

- Proactive diagnostics on edited files
- `pnpm verify`
- Fresh `0001` → `0004` migration smoke
- `0003` → `0004` upgrade smoke with existing Grow Spaces
- API and frontend ASGI smoke
- Synchronized add-on context check
- Docker build from synchronized source
- Docker build from the committed Git archive
- Degraded and authenticated mock Home Assistant container smoke tests
- Live Home Assistant Supervisor installation remains explicitly unverified until
  performed

## 14. Release and Publication

This milestone is a minor feature release and targets version `0.3.0`.

Before publication, version metadata must be synchronized across:

- Root and add-on package metadata
- Backend package and `__version__`
- Frontend package metadata
- Home Assistant add-on `config.yaml`
- Companion integration manifest
- Python and pnpm lockfiles where applicable
- Changelog, OpenAPI export, and synchronized add-on context

The implementation is published from a Git-backed branch after the committed
archive passes its own Docker build. The pull request must report migration head
`0004`, exact test counts, container evidence, and the remaining live-Supervisor
verification limitation.

## 15. Acceptance Criteria

The milestone is complete when a user can:

1. Create a minimal cultivar with or without a breeder.
2. Customize installation-wide lifecycle stages without breaking historical
   references.
3. Create a Grow in a Grow Space.
4. Create an individually named Plant within that Grow.
5. Record seed/clone identity, cultivation details, dates, status, and cultivar.
6. Duplicate a Plant into a reviewed new-Plant draft without copying history.
7. Transition a Plant to any enabled stage with confirmation when needed.
8. Backdate or correct lifecycle history without deleting prior events.
9. View deterministic current stage and complete transition history.
10. Archive and restore Grow and Plant records without losing relationships or
    history.
11. Use the feature while Home Assistant is disconnected.
12. Upgrade an existing `0003` installation without changing Grow Spaces or
    environmental mappings.
