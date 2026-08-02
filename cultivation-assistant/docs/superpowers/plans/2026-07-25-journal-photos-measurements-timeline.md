# Journal, Photos, Measurements, and Activity Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 by adding Plant/Grow journal entries, Plant measurements, Plant photos, and a merged per-Plant Activity Timeline.

**Architecture:** One new `journal` vertical slice (`schemas.py`, `repository.py`, `service.py`, `router.py`, `storage.py`, `rules.py`) owning `journal_entries`, `measurements`, and `photos`, backed by migration `0005`. The timeline is a read-only projection assembled from `journal`'s own tables plus a read query against `plant_stage_transitions`.

**Tech Stack:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic, SQLite WAL, React, TypeScript, Zod, TanStack Query, TanStack Router, Vitest, Testing Library, pnpm, uv, Docker.

## Global Constraints

- Use red-green-refactor TDD for every behavior-bearing change.
- Journal entries may target a Plant or a Grow; Measurements and Photos are Plant-only.
- Photos store the original upload only; no server-side thumbnail generation (see design doc §2).
- Photo content type is restricted to `image/jpeg`, `image/png`, `image/webp`; stored filenames derive from the Photo's own UUID, never from client input.
- All writes go through `Database.transaction()` and write an audit row in the same transaction, per existing convention.
- Requests remain Home Assistant Ingress-relative.
- Preserve the Ministry of Elsewhere UI, restrained Art Nouveau details, Civic Chimera dark mode, accessible text status, responsive behavior, and reduced motion.
- Use pnpm rather than npm.
- Migration head becomes exactly `0005`; release version becomes exactly `0.4.0`.
- Synchronize every release version location before publication.
- The source workspace has no Git metadata. Record checkpoints there and commit synchronized changes in the Git-backed publication clone (see the `0.3.0` publication flow for the exact clone/commit/PR sequence).

---

### Task 1: Journal Domain Rules

**Files:**

- Create: `backend/cultivation_assistant/journal/__init__.py`
- Create: `backend/cultivation_assistant/journal/rules.py`
- Create: `backend/tests/test_journal_rules.py`

**Interfaces:**

- Produces: `JournalSubjectType`, `JournalEntryType`, `MeasurementMetric`, `PHOTO_CONTENT_TYPES`, `requires_custom_metric_name(metric: MeasurementMetric, custom_name: str | None) -> bool`.
- Consumers: Tasks 2, 4–6 use these enums for check constraints and validation.

- [ ] **Step 1: Write failing pure-domain tests**

```python
from cultivation_assistant.journal.rules import (
    MeasurementMetric,
    requires_custom_metric_name,
)


def test_custom_metric_requires_a_name() -> None:
    assert requires_custom_metric_name(MeasurementMetric.CUSTOM, None)
    assert not requires_custom_metric_name(MeasurementMetric.CUSTOM, "Brix")
    assert not requires_custom_metric_name(MeasurementMetric.HEIGHT, None)
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_journal_rules.py -q`
Expected: FAIL because `cultivation_assistant.journal` does not exist.

- [ ] **Step 3: Implement the vocabulary**

Define `JournalSubjectType(StrEnum)` = `PLANT`, `GROW`.
Define `JournalEntryType(StrEnum)` = `WATERED`, `FED`, `TRANSPLANTED`, `TOPPED`, `TRAINED`, `DEFOLIATED`, `LIGHT_SCHEDULE_CHANGED`, `FLOWERING_INITIATED`, `FIRST_FLOWERS_OBSERVED`, `PROBLEM_OBSERVED`, `TREATMENT_APPLIED`, `HARVESTED`, `DRYING_STARTED`, `JARRED`, `CURE_MILESTONE`, `NOTE`.
Define `MeasurementMetric(StrEnum)` = `HEIGHT`, `WIDTH`, `CANOPY_DIAMETER`, `STEM_DIAMETER`, `NODE_COUNT`, `CONTAINER_WEIGHT`, `PLANT_WEIGHT`, `CUSTOM`.
Define `PHOTO_CONTENT_TYPES: frozenset[str] = frozenset({"image/jpeg", "image/png", "image/webp"})`.
`requires_custom_metric_name` returns `metric is MeasurementMetric.CUSTOM and not custom_name`.

- [ ] **Step 4: Verify GREEN, then lint and type-check**

```bash
uv run pytest backend/tests/test_journal_rules.py -q
uv run ruff check backend/cultivation_assistant/journal
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal/__init__.py backend/cultivation_assistant/journal/rules.py backend/tests/test_journal_rules.py
git commit -m "feat: add journal domain vocabulary"
```

---

### Task 2: Migration `0005` and ORM Models

**Files:**

- Create: `backend/alembic/versions/0005_journal_photos_measurements.py`
- Create: `backend/tests/test_journal_migration.py`
- Modify: `backend/cultivation_assistant/db/models.py`
- Modify: `backend/tests/test_migrations.py` (schema_version `"0004"` → `"0005"`)

**Interfaces:**

- Produces ORM classes `JournalEntry`, `Measurement`, `Photo` on `Base`.
- Consumers: Task 3 (storage only touches `Photo.file_path`), Tasks 4–7 (repository/service).

- [ ] **Step 1: Write a failing migration test**

```python
async def test_upgrade_to_0005_adds_journal_tables(tmp_path: Path) -> None:
    config = alembic_config(tmp_path)
    command.upgrade(config, "0005")
    inspector = await inspect_async(tmp_path)
    assert {"journal_entries", "measurements", "photos"} <= set(inspector.get_table_names())


async def test_downgrade_from_0005_drops_journal_tables_after_seeding_a_full_record(
    tmp_path: Path,
) -> None:
    # seed one plant, one journal entry, one measurement, one photo referencing both
    ...
    command.downgrade(config, "0004")
    inspector = await inspect_async(tmp_path)
    assert not {"journal_entries", "measurements", "photos"} & set(inspector.get_table_names())
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_journal_migration.py -q`
Expected: FAIL — migration `0005` does not exist.

- [ ] **Step 3: Add ORM models**

Add `JournalEntry`, `Measurement`, `Photo` to `db/models.py` following the
`Plant`/`PlantStageTransition` pattern: `UUIDPrimaryKeyMixin`, `TimestampMixin`
where applicable, check constraints for enums, indexes per design doc §5.
`Photo.journal_entry_id` and `Photo.measurement_id` use `ondelete="SET NULL"`;
`Photo.plant_id`, `Measurement.plant_id` use `ondelete="CASCADE"`;
`JournalEntry.related_stage_id` and `Photo.stage_id` use `ondelete="RESTRICT"`.

- [ ] **Step 4: Write the migration**

Create tables in dependency order: `journal_entries`, `measurements`,
`photos`. Downgrade drops `photos` → `measurements` → `journal_entries`.

- [ ] **Step 5: Verify GREEN and update the schema-version test**

```bash
uv run pytest backend/tests/test_journal_migration.py backend/tests/test_migrations.py -q
```

Expected: pass; `test_migrations.py` now asserts `"0005"`.

- [ ] **Step 6: Checkpoint**

```bash
git add backend/alembic/versions/0005_journal_photos_measurements.py backend/cultivation_assistant/db/models.py backend/tests/test_journal_migration.py backend/tests/test_migrations.py
git commit -m "feat: add journal, measurement, and photo tables"
```

---

### Task 3: Photo Storage Module

**Files:**

- Create: `backend/cultivation_assistant/journal/storage.py`
- Create: `backend/tests/test_photo_storage.py`

**Interfaces:**

- Produces `PhotoStorage(data_dir: Path)` with `save(plant_id: str, photo_id: str, content_type: str, content: bytes) -> str` (returns the relative `file_path`) and `delete(file_path: str) -> None` (idempotent — missing file is not an error).
- Raises `UnsupportedPhotoContentType` for anything outside `PHOTO_CONTENT_TYPES`.
- Consumers: Task 6 (photo service).

- [ ] **Step 1: Write failing storage tests**

```python
def test_save_derives_filename_from_id_and_content_type(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    relative_path = storage.save("plant-1", "photo-1", "image/png", b"...")
    assert relative_path == "plant-1/photo-1.png"
    assert (tmp_path / "photos" / relative_path).read_bytes() == b"..."


def test_save_rejects_unsupported_content_type(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    with pytest.raises(UnsupportedPhotoContentType):
        storage.save("plant-1", "photo-1", "application/pdf", b"...")


def test_delete_is_idempotent(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    storage.delete("plant-1/missing.png")
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_photo_storage.py -q`
Expected: FAIL — `journal.storage` does not exist.

- [ ] **Step 3: Implement `PhotoStorage`**

Map content type to extension (`image/jpeg` → `jpg`, `image/png` → `png`,
`image/webp` → `webp`). Create `{data_dir}/photos/{plant_id}/` with
`mkdir(parents=True, exist_ok=True)` before writing. Use synchronous file
I/O wrapped through `anyio.to_thread.run_sync` when called from async
service code (matches project's async-first convention without adding a new
dependency).

- [ ] **Step 4: Verify GREEN, lint, type-check**

```bash
uv run pytest backend/tests/test_photo_storage.py -q
uv run ruff check backend/cultivation_assistant/journal
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal/storage.py backend/tests/test_photo_storage.py
git commit -m "feat: add photo file storage"
```

---

### Task 4: Journal Entries API

**Files:**

- Create: `backend/cultivation_assistant/journal/schemas.py`
- Create: `backend/cultivation_assistant/journal/repository.py`
- Create: `backend/cultivation_assistant/journal/service.py`
- Create: `backend/cultivation_assistant/journal/router.py`
- Create: `backend/tests/test_journal_entry_api.py`
- Modify: `backend/cultivation_assistant/main.py` (mount the journal router)

**Interfaces:**

- `JournalEntryCreate`, `JournalEntryUpdate`, `JournalEntryResponse`, `JournalEntryListResponse` (Pydantic).
- `JournalService.create_for_plant`, `create_for_grow`, `list_for_plant`, `list_for_grow`, `update`, `delete`.
- `JournalNotFound`, `JournalValidationError` domain errors.
- Consumers: Task 7 (timeline reads `JournalRepository.list_for_plant`), Task 8 (frontend client).

- [ ] **Step 1: Write failing API tests**

```python
async def test_creates_a_plant_journal_entry(api_client: httpx.AsyncClient, seeded_plant: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{seeded_plant}/journal-entries",
        json={"entry_type": "note", "title": "Topped today", "tags": ["training"]},
    )
    assert response.status_code == 201
    assert response.json()["subject_type"] == "plant"


async def test_creates_a_grow_journal_entry(api_client: httpx.AsyncClient, seeded_grow: str) -> None:
    response = await api_client.post(
        f"/api/v1/grows/{seeded_grow}/journal-entries",
        json={"entry_type": "note", "notes": "Reservoir topped off"},
    )
    assert response.status_code == 201
    assert response.json()["subject_type"] == "grow"


async def test_rejects_related_stage_from_a_different_lifecycle(...) -> None: ...
async def test_updates_and_deletes_an_entry(...) -> None: ...
async def test_lists_entries_for_a_plant_ordered_by_occurred_at(...) -> None: ...
```

Cover: required-field validation, unknown subject 404, invalid `entry_type`
422, unknown `related_stage_id` 422, delete removes attached-photo linkage
(photos become unattached rather than deleted — verified once Task 6 lands;
stub the assertion as a follow-up note here and complete it in Task 6).

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_journal_entry_api.py -q`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement schemas, repository, service, router**

Follow the `library`/`grows` slice conventions exactly: repository does
SQLAlchemy only, service wraps `Database.transaction()` and calls
`audit_record()`, router maps domain errors via a local
`_map_domain_errors` helper. Mount two creation routes
(`/plants/{plant_id}/journal-entries`, `/grows/{grow_id}/journal-entries`)
and three subject-agnostic ones (`GET/PATCH/DELETE
/journal-entries/{id}` plus the two list routes) on the same router.

- [ ] **Step 4: Verify GREEN, then full backend suite**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal/schemas.py backend/cultivation_assistant/journal/repository.py backend/cultivation_assistant/journal/service.py backend/cultivation_assistant/journal/router.py backend/tests/test_journal_entry_api.py backend/cultivation_assistant/main.py
git commit -m "feat: add journal entries API"
```

---

### Task 5: Measurements API

**Files:**

- Modify: `backend/cultivation_assistant/journal/schemas.py`
- Modify: `backend/cultivation_assistant/journal/repository.py`
- Modify: `backend/cultivation_assistant/journal/service.py`
- Modify: `backend/cultivation_assistant/journal/router.py`
- Create: `backend/tests/test_measurement_api.py`

**Interfaces:**

- `MeasurementCreate`, `MeasurementUpdate`, `MeasurementResponse`, `MeasurementListResponse`.
- `JournalService.create_measurement`, `list_measurements`, `update_measurement`, `delete_measurement`.
- Consumers: Task 6 (Photo's optional `measurement_id`), Task 7 (timeline).

- [ ] **Step 1: Write failing API tests**

```python
async def test_creates_a_height_measurement(api_client: httpx.AsyncClient, seeded_plant: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{seeded_plant}/measurements",
        json={"metric_type": "height", "value": 32.5, "unit": "cm"},
    )
    assert response.status_code == 201


async def test_custom_metric_requires_a_name(api_client: httpx.AsyncClient, seeded_plant: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{seeded_plant}/measurements",
        json={"metric_type": "custom", "value": 6.2, "unit": "brix"},
    )
    assert response.status_code == 422
```

Cover: list ordering, update, delete, unknown plant 404.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_measurement_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

Reuse `JournalValidationError` for the custom-metric-name check via
`requires_custom_metric_name` from Task 1.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal/schemas.py backend/cultivation_assistant/journal/repository.py backend/cultivation_assistant/journal/service.py backend/cultivation_assistant/journal/router.py backend/tests/test_measurement_api.py
git commit -m "feat: add measurements API"
```

---

### Task 6: Photos API

**Files:**

- Modify: `backend/cultivation_assistant/journal/schemas.py`
- Modify: `backend/cultivation_assistant/journal/repository.py`
- Modify: `backend/cultivation_assistant/journal/service.py`
- Modify: `backend/cultivation_assistant/journal/router.py`
- Modify: `backend/cultivation_assistant/config.py` (nothing new — reuse `data_dir`)
- Create: `backend/tests/test_photo_api.py`
- Modify: `pyproject.toml` (add `python-multipart`)

**Interfaces:**

- `PhotoResponse`, `PhotoListResponse`.
- `JournalService.create_photo(plant_id, upload: UploadFile, caption, tags, journal_entry_id, measurement_id, stage_id, occurred_at, correlation_id)`, `list_photos`, `update_photo`, `delete_photo`, `get_photo_file(photo_id) -> tuple[Path, str]`.
- Consumers: Task 7 (timeline), Task 9 (frontend photo grid).

- [ ] **Step 1: Write failing API tests**

```python
async def test_uploads_a_photo(api_client: httpx.AsyncClient, seeded_plant: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{seeded_plant}/photos",
        files={"file": ("leaf.png", PNG_1X1_BYTES, "image/png")},
        data={"caption": "Week 3"},
    )
    assert response.status_code == 201
    photo_id = response.json()["id"]

    file_response = await api_client.get(f"/api/v1/photos/{photo_id}/file")
    assert file_response.status_code == 200
    assert file_response.headers["content-type"] == "image/png"


async def test_rejects_oversized_upload(...) -> None: ...
async def test_rejects_disallowed_content_type(...) -> None: ...


async def test_delete_removes_row_and_file(api_client, seeded_plant) -> None:
    ...
    await api_client.delete(f"/api/v1/photos/{photo_id}")
    assert not stored_path.exists()
```

Add the deferred assertion from Task 4: deleting a journal entry with an
attached photo leaves the photo intact with `journal_entry_id = null`.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_photo_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

Use FastAPI `UploadFile` + `Form(...)` parameters. Enforce the 15 MB limit
by reading in chunks and aborting early rather than buffering the whole
file first. Follow the commit-then-write ordering from design doc §8.
`GET /photos/{id}/file` returns a `FileResponse` built from
`get_photo_file`.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv sync
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal backend/tests/test_photo_api.py pyproject.toml uv.lock
git commit -m "feat: add photos API"
```

---

### Task 7: Activity Timeline API

**Files:**

- Modify: `backend/cultivation_assistant/journal/schemas.py`
- Modify: `backend/cultivation_assistant/journal/service.py`
- Modify: `backend/cultivation_assistant/journal/router.py`
- Create: `backend/tests/test_plant_timeline_api.py`

**Interfaces:**

- `TimelineEntryResponse`, `TimelineListResponse`.
- `JournalService.get_plant_timeline(plant_id, limit, offset) -> TimelineListResponse` merging stage transitions, journal entries, measurements, photos per design doc §6.
- Consumers: Task 9 (frontend Activity tab).

- [ ] **Step 1: Write failing timeline tests**

```python
async def test_timeline_merges_all_sources_in_order(api_client: httpx.AsyncClient, seeded_plant: str) -> None:
    # seed one journal entry, one measurement, one photo, and let plant creation's
    # initial stage transition stand as the fourth entry
    response = await api_client.get(f"/api/v1/plants/{seeded_plant}/timeline")
    body = response.json()
    assert [item["event_type"] for item in body["items"]] == [
        "photo_added", "measurement_recorded", "note", "stage_changed",
    ]


async def test_each_entry_populates_exactly_one_detail_field(...) -> None: ...
async def test_timeline_paginates(...) -> None: ...
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_plant_timeline_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement the merge projection**

Fetch all four sources for the plant (bounded by a reasonable window/limit
before merging — fetch `limit + offset` from each source, merge, then slice,
since SQLite has no native `UNION` across heterogeneous shapes worth
fighting for at this scale), sort by `occurred_at` descending with a stable
tiebreaker (`created_at`, `id`), and project into `TimelineEntryResponse`.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/journal
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/journal/schemas.py backend/cultivation_assistant/journal/service.py backend/cultivation_assistant/journal/router.py backend/tests/test_plant_timeline_api.py
git commit -m "feat: add plant activity timeline"
```

---

### Task 8: Typed Frontend Clients

**Files:**

- Create: `frontend/src/api/journal.ts`
- Create: `frontend/src/api/journal.test.ts`

**Interfaces:**

- Zod-validated types and TanStack Query hooks for journal entries, measurements, photos (including multipart upload), and the timeline.
- Consumers: Task 9.

- [ ] **Step 1: Write failing Ingress-relative client tests**

```typescript
it("creates a plant journal entry through an Ingress-relative URL", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(entryFixture, 201));
  await createPlantJournalEntry("plant-1", entryInputFixture, fetcher);
  expect(fetcher).toHaveBeenCalledWith(
    "api/v1/plants/plant-1/journal-entries",
    expect.objectContaining({ method: "POST" }),
  );
});

it("uploads a photo as multipart form data", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(photoFixture, 201));
  await uploadPhoto("plant-1", { file: new File(["x"], "leaf.png", { type: "image/png" }) }, fetcher);
  const [, init] = fetcher.mock.calls[0];
  expect(init.body).toBeInstanceOf(FormData);
});

it("fetches the merged plant timeline", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(timelineFixture));
  await fetchPlantTimeline("plant-1", fetcher);
  expect(fetcher).toHaveBeenCalledWith("api/v1/plants/plant-1/timeline", expect.anything());
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/api/journal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Zod contracts, functions, keys, and hooks**

Import shared `ApiError`/`parseResponse`/`expectOk` from `./client`. Use
separate query-key roots (`journalKeys`, `measurementKeys`, `photoKeys`,
`timelineKeys`) matching the `grows.ts`/`plants.ts` pattern.

- [ ] **Step 4: Verify GREEN, lint**

```bash
pnpm --filter cultivation-assistant-frontend test -- src/api/journal.test.ts
pnpm --filter cultivation-assistant-frontend lint
```

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/src/api/journal.ts frontend/src/api/journal.test.ts
git commit -m "feat: add typed journal, measurement, and photo clients"
```

---

### Task 9: Plant Activity Tab, Photo Grid, and Grow Journal Section

**Files:**

- Create: `frontend/src/features/journal/ActivityTimeline.tsx`
- Create: `frontend/src/features/journal/ActivityTimeline.test.tsx`
- Create: `frontend/src/features/journal/JournalEntryComposer.tsx`
- Create: `frontend/src/features/journal/JournalEntryComposer.test.tsx`
- Create: `frontend/src/features/journal/MeasurementComposer.tsx`
- Create: `frontend/src/features/journal/PhotoUploadComposer.tsx`
- Create: `frontend/src/features/journal/PhotoGrid.tsx`
- Create: `frontend/src/features/journal/PhotoGrid.test.tsx`
- Create: `frontend/src/features/journal/GrowJournalSection.tsx`
- Modify: `frontend/src/routes/PlantDetailPage.tsx`
- Modify: `frontend/src/routes/PlantDetailPage.test.tsx`
- Modify: `frontend/src/routes/GrowDetailPage.tsx`
- Modify: `frontend/src/routes/GrowDetailPage.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Replaces the plain lifecycle-history list on `PlantDetailPage` with tabbed **Activity** / **Photos** views per design doc §9.
- Adds a Journal section to `GrowDetailPage`.

- [ ] **Step 1: Write failing tab and composer tests**

```tsx
it("renders the merged timeline in order", async () => {
  renderDetail(timelineFixtureWithFourEntryTypes);
  const items = await screen.findAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toMatchObject([
    expect.stringContaining("Photo"), expect.stringContaining("32"),
    expect.stringContaining("Topped"), expect.stringContaining("Seedling"),
  ]);
});

it("adds a note through the composer", async () => {
  const user = userEvent.setup();
  renderDetail(emptyTimelineFixture);
  await user.click(screen.getByRole("button", { name: /add note/i }));
  await user.type(screen.getByLabelText(/notes/i), "Topped today");
  await user.click(screen.getByRole("button", { name: /save/i }));
  expect(await screen.findByText("Topped today")).toBeVisible();
});

it("uploads a photo and shows it in the grid", async () => { ... });
```

Cover loading, empty, and error states for the timeline query, matching the
existing `StatePanel` conventions.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/features/journal src/routes/PlantDetailPage.test.tsx src/routes/GrowDetailPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the tab, composers, grid, and Grow section**

Keep the existing lifecycle-history rendering logic inside
`ActivityTimeline` as the `stage_changed` branch so no visual regression
occurs for Plants with no journal activity yet.

- [ ] **Step 4: Verify GREEN, lint, full frontend suite**

```bash
pnpm --filter cultivation-assistant-frontend test
pnpm --filter cultivation-assistant-frontend lint
```

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/src/features/journal frontend/src/routes/PlantDetailPage.tsx frontend/src/routes/PlantDetailPage.test.tsx frontend/src/routes/GrowDetailPage.tsx frontend/src/routes/GrowDetailPage.test.tsx frontend/src/styles.css
git commit -m "feat: add activity timeline, photo grid, and grow journal section"
```

---

### Task 10: OpenAPI, Version `0.4.0`, Packaging, Verification, and Publication

**Files:**

- Modify: `backend/tests/test_health.py`, `backend/tests/test_diagnostics.py`, `custom_components/tests/test_manifest.py`, `backend/tests/test_app_packaging.py`
- Modify: `backend/cultivation_assistant/__init__.py`, `custom_components/cultivation_assistant/manifest.json`, `package.json`, `frontend/package.json`, `pyproject.toml`, `uv.lock`
- Modify: `cultivation/config.yaml`, `cultivation/CHANGELOG.md`, `README.md`, `docs/openapi.json`
- Modify: synchronized files under `cultivation/app/`

**Interfaces:**

- Produces migration head `0005`, release `0.4.0`, synchronized source/add-on context, and publication evidence.

- [ ] **Step 1: Change version expectations first and verify RED**

Run: `uv run pytest backend/tests/test_health.py backend/tests/test_diagnostics.py custom_components/tests/test_manifest.py backend/tests/test_app_packaging.py -q`
Expected: FAIL showing `0.3.0` versus expected `0.4.0`. Also add
`backend/alembic/versions/0005_journal_photos_measurements.py` and
`backend/cultivation_assistant/journal/router.py` to
`test_app_build_context_contains_runtime_sources`'s required set.

- [ ] **Step 2: Synchronize all version metadata and release notes**

Change every active `0.3.0` release location to `0.4.0`, regenerate
`uv.lock`, and add a `0.4.0` changelog section describing Journal entries,
Photos, Measurements, and the Activity Timeline. Preserve every historical
section.

```bash
uv lock
pnpm install --lockfile-only
uv run pytest backend/tests/test_health.py backend/tests/test_diagnostics.py custom_components/tests/test_manifest.py backend/tests/test_app_packaging.py -q
```

- [ ] **Step 3: Export OpenAPI and synchronize add-on context**

```bash
pnpm openapi:export
pnpm sync:addon
```

Confirm the exported schema includes journal-entry, measurement, photo, and
timeline routes and reports application version `0.4.0`.

- [ ] **Step 4: Run proactive diagnostics and full verification**

```bash
pnpm verify
```

Expected: ESLint, Ruff, mypy, all Vitest tests, all pytest tests,
TypeScript, and Vite production build pass with no warnings promoted to
errors. Record exact test counts for the PR.

- [ ] **Step 5: Run migration and ASGI smoke tests**

Fresh `0001 → 0005` and existing `0004` database → `0005`. For each, verify:

```text
GET  /api/v1/health                          200, version 0.4.0
POST /api/v1/plants/{id}/journal-entries     201
POST /api/v1/plants/{id}/measurements        201
POST /api/v1/plants/{id}/photos              201
GET  /api/v1/plants/{id}/timeline            200, four entries in order
schema revision                              0005
```

- [ ] **Step 6: Build and smoke-test containers**

```bash
pnpm docker:build
```

Smoke-test degraded mode and authenticated mock Home Assistant REST/WebSocket
mode exactly as for `0.3.0`: schema `0005`, frontend `200`, restart count
`0`, no traceback/`ValueError`/critical log entry; readiness `503` degraded,
`200` authenticated.

- [ ] **Step 7: Synchronize to the Git-backed branch and build the committed archive**

Clone `https://github.com/Skipyzi/remindme-homeassistant-addons`, create
`feat/journal-photos-measurements-timeline` from current `main`, replace
`cultivation-assistant/` with the synchronized verified context, inspect
`git status --short` and the full diff before committing.

```bash
git add cultivation-assistant
git commit -m "feat: add journal, photos, measurements, and activity timeline"
git archive HEAD cultivation-assistant | tar -x -C ../committed-build-check
docker build -t cultivation-assistant:0.4.0-repo-check ../committed-build-check/cultivation-assistant
```

- [ ] **Step 8: Push and publish**

Push the feature branch and open a pull request against `main`. The PR body
must include version `0.4.0`, migration `0005`, exact test counts,
fresh/upgrade smoke evidence, both container modes, committed-archive image
evidence, and the explicit statement that live Home Assistant Supervisor
installation remains unverified.

- [ ] **Step 9: Final checkpoint**

```bash
git status --short
git log -1 --oneline
```

Expected: clean branch at the published commit.
