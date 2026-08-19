# Reservoirs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Reservoir records, tank geometry/calibration, Home Assistant entity mapping, and a live dashboard showing current level and computed current volume — the first Phase 2 slice.

**Architecture:** One new `reservoirs` vertical slice (`schemas.py`, `repository.py`, `service.py`, `router.py`, `geometry.py`, `roles.py`, `units.py`, `discovery.py`), backed by migration `0006`. Mirrors the Grow Space entity-mapping pattern but is self-contained; reuses only the generic `to_metres`/`from_metres` helpers from `grow_spaces.dimensions`.

**Tech Stack:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic, SQLite WAL, React, TypeScript, Zod, TanStack Query, TanStack Router, Vitest, Testing Library, pnpm, uv, Docker.

## Global Constraints

- Use red-green-refactor TDD for every behavior-bearing change.
- Reservoirs are standalone records; `primary_grow_space_id` is a nullable display-grouping hint only, not a durable relationship (see design doc §2).
- Only `rectangular`, `vertical_cylinder`, `horizontal_cylinder`, and `custom_calibration_table` geometry ship in this slice.
- `current_volume_liters` is `null` (never fabricated) when geometry/calibration data or a level-oriented reading is missing.
- Archiving a reservoir is reversible and preserves its mappings, matching Grow Spaces.
- All writes go through `Database.transaction()` and write an audit row in the same transaction.
- Requests remain Home Assistant Ingress-relative.
- Preserve the Ministry of Elsewhere UI, restrained Art Nouveau details, Civic Chimera dark mode, accessible text status, responsive behavior, and reduced motion.
- Use pnpm rather than npm.
- Migration head becomes exactly `0006`; release version becomes exactly `0.5.0`.
- The source workspace has no Git metadata. Record checkpoints there and commit synchronized changes in the Git-backed publication clone (same clone/commit/PR sequence as `0.4.0`).

---

### Task 1: Reservoir Geometry Math

**Files:**

- Create: `backend/cultivation_assistant/reservoirs/__init__.py`
- Create: `backend/cultivation_assistant/reservoirs/geometry.py`
- Create: `backend/tests/test_reservoir_geometry.py`

**Interfaces:**

- Produces: `GeometryShape` (StrEnum), `volume_from_depth(shape, dimensions, depth_m) -> Decimal`, `volume_from_percentage(usable_capacity_liters, percentage) -> Decimal`, `interpolate_calibration(points, raw_value) -> Decimal`, `LEVEL_ROLE_PRIORITY` (ordered tuple).
- Consumers: Tasks 4 and 6 (service-layer volume computation).

- [ ] **Step 1: Write failing pure-math tests**

```python
from decimal import Decimal
from cultivation_assistant.reservoirs.geometry import (
    GeometryShape,
    interpolate_calibration,
    volume_from_depth,
    volume_from_percentage,
)


def test_rectangular_volume_from_depth() -> None:
    volume = volume_from_depth(
        GeometryShape.RECTANGULAR,
        {"length_m": Decimal("0.5"), "width_m": Decimal("0.4"), "height_m": Decimal("0.6")},
        depth_m=Decimal("0.3"),
    )
    assert volume == Decimal("60.0000")  # 0.5 * 0.4 * 0.3 m3 * 1000


def test_vertical_cylinder_volume_from_depth() -> None:
    volume = volume_from_depth(
        GeometryShape.VERTICAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "height_m": Decimal("1.0")},
        depth_m=Decimal("0.5"),
    )
    assert volume > Decimal("0")


def test_percentage_volume_uses_usable_capacity() -> None:
    assert volume_from_percentage(Decimal("100"), Decimal("0.5")) == Decimal("50")


def test_calibration_interpolates_between_points_and_clamps() -> None:
    points = [(Decimal("0"), Decimal("0")), (Decimal("50"), Decimal("100")), (Decimal("100"), Decimal("200"))]
    assert interpolate_calibration(points, Decimal("25")) == Decimal("50")
    assert interpolate_calibration(points, Decimal("150")) == Decimal("200")
    assert interpolate_calibration(points, Decimal("-10")) == Decimal("0")
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_geometry.py -q`
Expected: FAIL — `cultivation_assistant.reservoirs` does not exist.

- [ ] **Step 3: Implement the geometry module**

Use `Decimal` throughout (never `float`) for volume arithmetic, matching
`grow_spaces/dimensions.py`'s precision discipline. Horizontal-cylinder
partial-fill volume uses the standard circular-segment formula.

- [ ] **Step 4: Verify GREEN, lint, type-check**

```bash
uv run pytest backend/tests/test_reservoir_geometry.py -q
uv run ruff check backend/cultivation_assistant/reservoirs
uv run mypy backend/cultivation_assistant/reservoirs
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/reservoirs/__init__.py backend/cultivation_assistant/reservoirs/geometry.py backend/tests/test_reservoir_geometry.py
git commit -m "feat: add reservoir geometry math"
```

---

### Task 2: Reservoir Roles, Units, and Discovery

**Files:**

- Create: `backend/cultivation_assistant/reservoirs/roles.py`
- Create: `backend/cultivation_assistant/reservoirs/units.py`
- Create: `backend/cultivation_assistant/reservoirs/discovery.py`
- Create: `backend/cultivation_assistant/reservoirs/schemas.py` (only `EntityCandidate` in this task; extended in Task 6)
- Create: `backend/tests/test_reservoir_discovery.py`

**Interfaces:**

- Produces `ReservoirRole` (StrEnum: `level_percentage`, `liquid_depth`, `distance_to_liquid`, `weight`, `water_temperature`, `low_level`, `empty`, `high_level`, `overflow`, `leak`, `pump`, `fill_valve`, `flow`), `get_role_definition(role) -> RoleDefinition`, `classify_unit(role, source_unit) -> UnitCompatibility`, `EntityDiscoveryService.suggest(role) -> list[EntityCandidate]`.
- Consumers: Task 6 (mapping validation and suggestion endpoint).

- [ ] **Step 1: Write failing discovery tests**

```python
def test_percentage_sensor_is_compatible_with_level_percentage() -> None:
    cache = EntityStateCache()
    cache.update({"entity_id": "sensor.tank_level", "state": "72",
                  "attributes": {"device_class": "moisture", "unit_of_measurement": "%",
                                 "friendly_name": "Tank level"}})
    service = EntityDiscoveryService(cache)
    candidates = service.suggest("level_percentage")
    assert candidates[0].entity_id == "sensor.tank_level"


def test_pump_role_matches_switch_domain() -> None:
    ...
```

Cover: continuous-role unit compatibility (percentage, cm/m depth,
kg weight, °C temperature), binary-role domain matching (`binary_sensor`),
control-role domain matching (`switch`/`valve` for pump/fill_valve,
`sensor` for flow).

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_discovery.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement roles, units, and discovery**

Follow `grow_spaces/roles.py`, `units.py`, and `discovery.py` structure
exactly, scoped to `ReservoirRole`.

- [ ] **Step 4: Verify GREEN, lint, type-check**

```bash
uv run pytest backend/tests/test_reservoir_discovery.py -q
uv run ruff check backend/cultivation_assistant/reservoirs
uv run mypy backend/cultivation_assistant/reservoirs
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/reservoirs/roles.py backend/cultivation_assistant/reservoirs/units.py backend/cultivation_assistant/reservoirs/discovery.py backend/cultivation_assistant/reservoirs/schemas.py backend/tests/test_reservoir_discovery.py
git commit -m "feat: add reservoir role vocabulary and entity discovery"
```

---

### Task 3: Migration `0006` and ORM Models

**Files:**

- Create: `backend/alembic/versions/0006_reservoirs.py`
- Create: `backend/tests/test_reservoir_migration.py`
- Modify: `backend/cultivation_assistant/db/models.py`
- Modify: `backend/tests/test_migrations.py` (schema_version `"0005"` → `"0006"`)

**Interfaces:**

- Produces ORM classes `Reservoir`, `ReservoirCalibrationPoint`, `ReservoirEntityMapping`.
- Consumers: Tasks 4–6 (repository/service).

- [ ] **Step 1: Write a failing migration test**

Mirror `test_journal_migration.py`'s structure: upgrade-creates-tables,
downgrade-returns-to-`0005`, and a full-record downgrade test that seeds
a reservoir, a calibration point, and an entity mapping before
downgrading.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_migration.py -q`
Expected: FAIL — migration `0006` does not exist.

- [ ] **Step 3: Add ORM models**

Follow `GrowSpace`/`EntityMapping` conventions: `UUIDPrimaryKeyMixin`,
`TimestampMixin` where applicable, check constraints for enums, indexes
per design doc §5.

- [ ] **Step 4: Write the migration**

Create `reservoirs` → `reservoir_calibration_points` →
`reservoir_entity_mappings` in that order; downgrade drops the reverse
order.

- [ ] **Step 5: Verify GREEN and update the schema-version test**

```bash
uv run pytest backend/tests/test_reservoir_migration.py backend/tests/test_migrations.py -q
```

- [ ] **Step 6: Checkpoint**

```bash
git add backend/alembic/versions/0006_reservoirs.py backend/cultivation_assistant/db/models.py backend/tests/test_reservoir_migration.py backend/tests/test_migrations.py
git commit -m "feat: add reservoir, calibration point, and entity mapping tables"
```

---

### Task 4: Reservoirs CRUD API

**Files:**

- Modify: `backend/cultivation_assistant/reservoirs/schemas.py`
- Create: `backend/cultivation_assistant/reservoirs/repository.py`
- Create: `backend/cultivation_assistant/reservoirs/service.py`
- Create: `backend/cultivation_assistant/reservoirs/router.py`
- Create: `backend/tests/test_reservoir_api.py`
- Modify: `backend/cultivation_assistant/main.py` (mount the reservoirs router)

**Interfaces:**

- `ReservoirCreate`, `ReservoirUpdate`, `ReservoirResponse`, `ReservoirListResponse`.
- `ReservoirService.create`, `list`, `get`, `update`, `archive`.
- `ReservoirNotFound`, `ReservoirValidationError`.
- Consumers: Tasks 5–6 extend the same service/router; Task 7 (frontend client).

- [ ] **Step 1: Write failing API tests**

```python
async def test_creates_a_rectangular_reservoir(api_client: httpx.AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json={
            "name": "Mixing tank",
            "reservoir_type": "mixing_tank",
            "capacity_liters": "100",
            "geometry_shape": "rectangular",
            "geometry": {"length_m": "0.5", "width_m": "0.4", "height_m": "0.6"},
        },
    )
    assert response.status_code == 201, response.text


async def test_rejects_incomplete_geometry_for_its_shape(...) -> None: ...
async def test_rejects_usable_capacity_above_capacity(...) -> None: ...
async def test_archive_and_restore_preserve_the_record(...) -> None: ...
```

Cover create/list/get/update/archive/restore, geometry validation per
shape, and `usable_capacity_liters > capacity_liters` rejection.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement schemas, repository, service, router**

Follow the `grow_spaces` slice's create/list/get/update/archive
conventions exactly.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/reservoirs
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/reservoirs backend/tests/test_reservoir_api.py backend/cultivation_assistant/main.py
git commit -m "feat: add reservoirs CRUD API"
```

---

### Task 5: Calibration Points API

**Files:**

- Modify: `backend/cultivation_assistant/reservoirs/schemas.py`
- Modify: `backend/cultivation_assistant/reservoirs/repository.py`
- Modify: `backend/cultivation_assistant/reservoirs/service.py`
- Modify: `backend/cultivation_assistant/reservoirs/router.py`
- Create: `backend/tests/test_reservoir_calibration_api.py`

**Interfaces:**

- `CalibrationPointInput`, `CalibrationPointResponse`, `CalibrationPointListResponse`.
- `ReservoirService.replace_calibration_points(reservoir_id, points, correlation_id)`, `list_calibration_points`.

- [ ] **Step 1: Write failing API tests**

```python
async def test_replaces_the_full_calibration_table(api_client, seeded_reservoir) -> None:
    response = await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={"points": [{"raw_value": 0, "volume_liters": 0}, {"raw_value": 100, "volume_liters": 200}]},
    )
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2


async def test_requires_at_least_two_points(...) -> None: ...
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_calibration_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

`PUT` deletes all existing points for the reservoir and bulk-inserts the
new set inside one transaction, sorted by `raw_value`.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/reservoirs
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/reservoirs backend/tests/test_reservoir_calibration_api.py
git commit -m "feat: add reservoir calibration point replacement API"
```

---

### Task 6: Entity Mappings, Suggestions, and the Live Dashboard Read Model

**Files:**

- Modify: `backend/cultivation_assistant/reservoirs/schemas.py`
- Modify: `backend/cultivation_assistant/reservoirs/repository.py`
- Modify: `backend/cultivation_assistant/reservoirs/service.py`
- Modify: `backend/cultivation_assistant/reservoirs/router.py`
- Create: `backend/tests/test_reservoir_mapping_api.py`
- Create: `backend/tests/test_reservoir_dashboard_api.py`

**Interfaces:**

- `EntityMappingCreate`, `EntityMappingUpdate`, `EntityMappingResponse`, `LiveReading`.
- `ReservoirDetailResponse` extends the base response with `live_readings: list[LiveReading]` and `current_volume_liters: Decimal | None`.
- `ReservoirService.create_mapping`, `update_mapping`, `delete_mapping`, `suggest_entities`, and a `_dashboard(reservoir, mappings)` builder used by `get`.

- [ ] **Step 1: Write failing mapping and dashboard tests**

```python
async def test_maps_a_level_sensor_and_computes_volume(
    api_client, seeded_rectangular_reservoir, state_cache
) -> None:
    state_cache.update({"entity_id": "sensor.tank_level", "state": "50",
                         "attributes": {"unit_of_measurement": "%"}})
    await api_client.post(
        f"/api/v1/reservoirs/{seeded_rectangular_reservoir}/entity-mappings",
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )
    response = await api_client.get(f"/api/v1/reservoirs/{seeded_rectangular_reservoir}")
    assert response.json()["current_volume_liters"] is not None


async def test_missing_geometry_yields_null_volume(...) -> None: ...
async def test_suggestion_endpoint_ranks_compatible_entities_first(...) -> None: ...
```

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_reservoir_mapping_api.py backend/tests/test_reservoir_dashboard_api.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ReservoirService` takes `EntityStateCache` in its constructor (same as
`GrowSpaceService`). The dashboard builder picks the first present role
in `LEVEL_ROLE_PRIORITY`, resolves its live state, and calls into
`geometry.py` per the reservoir's shape; any missing piece (no mapping,
stale/unavailable state, incomplete geometry) yields `None` rather than
raising.

- [ ] **Step 4: Verify GREEN, full backend suite, lint, type-check**

```bash
uv run pytest backend/tests -q
uv run ruff check backend
uv run mypy backend/cultivation_assistant/reservoirs
```

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/reservoirs backend/tests/test_reservoir_mapping_api.py backend/tests/test_reservoir_dashboard_api.py
git commit -m "feat: add reservoir entity mappings and live dashboard"
```

---

### Task 7: Typed Frontend Client

**Files:**

- Create: `frontend/src/api/reservoirs.ts`
- Create: `frontend/src/api/reservoirs.test.ts`

**Interfaces:**

- Zod-validated types and TanStack Query hooks for reservoirs, calibration points, entity mappings, and suggestions.
- Consumers: Task 8.

- [ ] **Step 1: Write failing Ingress-relative client tests**

```typescript
it("creates a reservoir through an Ingress-relative URL", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(reservoirFixture, 201));
  await createReservoir(reservoirInputFixture, fetcher);
  expect(fetcher).toHaveBeenCalledWith("api/v1/reservoirs", expect.objectContaining({ method: "POST" }));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/api/reservoirs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Zod contracts, functions, keys, and hooks**

Follow the `grows.ts`/`journal.ts` pattern exactly, including a
`reservoirKeys` query-key root.

- [ ] **Step 4: Verify GREEN, lint**

```bash
pnpm --filter cultivation-assistant-frontend test -- src/api/reservoirs.test.ts
pnpm --filter cultivation-assistant-frontend lint
```

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/src/api/reservoirs.ts frontend/src/api/reservoirs.test.ts
git commit -m "feat: add typed reservoir client"
```

---

### Task 8: Reservoirs Register and Detail Page

**Files:**

- Create: `frontend/src/routes/ReservoirsPage.tsx`
- Create: `frontend/src/routes/ReservoirsPage.test.tsx`
- Create: `frontend/src/routes/ReservoirDetailPage.tsx`
- Create: `frontend/src/routes/ReservoirDetailPage.test.tsx`
- Create: `frontend/src/features/reservoirs/GeometryEditor.tsx`
- Create: `frontend/src/features/reservoirs/CalibrationTableEditor.tsx`
- Create: `frontend/src/features/reservoirs/ReservoirMappingWizard.tsx`
- Create: `frontend/src/features/reservoirs/ReservoirDashboard.tsx`
- Modify: `frontend/src/app/App.tsx` (replace the `/reservoirs` placeholder)
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Replaces the `/reservoirs` `ComingSoonPage` placeholder with `ReservoirsPage`.
- Adds `/reservoirs/{id}` routed to `ReservoirDetailPage`.

- [ ] **Step 1: Write failing register and detail tests**

```tsx
it("shows current volume when a level sensor and geometry are present", async () => {
  renderDetail(reservoirWithLevelFixture);
  expect(await screen.findByText(/current volume/i)).toBeVisible();
  expect(screen.getByText(/60/)).toBeVisible();
});

it("shows Not available when volume cannot be computed", async () => {
  renderDetail(reservoirWithoutMappingFixture);
  expect(await screen.findByText(/not available/i)).toBeVisible();
});
```

Cover geometry shape switching (fields change per shape), calibration
table add/remove rows, mapping wizard suggestion selection and manual
entity fallback (reusing the same accessible-listbox pattern as
`CultivarCombobox`), and register loading/empty/error states.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/routes/ReservoirsPage.test.tsx src/routes/ReservoirDetailPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the register, detail page, and feature components**

- [ ] **Step 4: Verify GREEN, lint, full frontend suite**

```bash
pnpm --filter cultivation-assistant-frontend test
pnpm --filter cultivation-assistant-frontend lint
```

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/src/routes/ReservoirsPage.tsx frontend/src/routes/ReservoirsPage.test.tsx frontend/src/routes/ReservoirDetailPage.tsx frontend/src/routes/ReservoirDetailPage.test.tsx frontend/src/features/reservoirs frontend/src/app/App.tsx frontend/src/styles.css
git commit -m "feat: add reservoirs register and detail page"
```

---

### Task 9: OpenAPI, Version `0.5.0`, Packaging, Verification, and Publication

**Files:**

- Modify: `backend/tests/test_health.py`, `backend/tests/test_diagnostics.py`, `custom_components/tests/test_manifest.py`, `backend/tests/test_app_packaging.py`
- Modify: `backend/cultivation_assistant/__init__.py`, `custom_components/cultivation_assistant/manifest.json`, `package.json`, `frontend/package.json`, `pyproject.toml`, `uv.lock`
- Modify: `cultivation/config.yaml`, `cultivation/CHANGELOG.md`, `README.md`, `docs/openapi.json`
- Modify: synchronized files under `cultivation/app/`

**Interfaces:**

- Produces migration head `0006`, release `0.5.0`, synchronized source/add-on context, and publication evidence.

- [ ] **Step 1: Change version expectations first and verify RED**

Run: `uv run pytest backend/tests/test_health.py backend/tests/test_diagnostics.py custom_components/tests/test_manifest.py backend/tests/test_app_packaging.py -q`
Expected: FAIL showing `0.4.0` versus expected `0.5.0`. Add
`backend/alembic/versions/0006_reservoirs.py` and
`backend/cultivation_assistant/reservoirs/router.py` to
`test_app_build_context_contains_runtime_sources`'s required set.

- [ ] **Step 2: Synchronize all version metadata and release notes**

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

- [ ] **Step 4: Run proactive diagnostics and full verification**

```bash
pnpm verify
```

- [ ] **Step 5: Run migration and ASGI smoke tests**

Fresh `0001 → 0006` and existing `0005` database → `0006`. Verify health
`200` v0.5.0, readiness `503` degraded, reservoir create `201`,
calibration replace `200`, entity mapping create `201`, dashboard
`current_volume_liters` populated, schema revision `0006`.

- [ ] **Step 6: Build and smoke-test containers**

```bash
pnpm docker:build
```

Degraded and authenticated modes, same acceptance bar as `0.4.0`.

- [ ] **Step 7: Synchronize to the Git-backed branch and build the committed archive**

Clone `https://github.com/Skipyzi/remindme-homeassistant-addons`, create
`feat/reservoirs` from current `main`, replace `cultivation-assistant/`
with the synchronized verified context.

```bash
git add cultivation-assistant
git commit -m "feat: add reservoirs, tank calibration, and level dashboard"
git archive HEAD cultivation-assistant | tar -x -C ../committed-build-check
docker build -t cultivation-assistant:0.5.0-repo-check ../committed-build-check/cultivation-assistant
```

- [ ] **Step 8: Push and publish**

Push the feature branch and open a pull request against `main` with
version `0.5.0`, migration `0006`, exact test counts, fresh/upgrade smoke
evidence, both container modes, committed-archive image evidence, and
the explicit statement that live Home Assistant Supervisor installation
remains unverified.

- [ ] **Step 9: Final checkpoint**

```bash
git status --short
git log -1 --oneline
```

Expected: clean branch at the published commit.
