# Grow Spaces and Environmental Entity Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Grow Spaces fixtures with a tested vertical slice for universal grow-space CRUD, environmental Home Assistant entity discovery, optional semantic mappings, unit normalization, audit logging, and a guided Ingress UI.

**Architecture:** Add a focused `grow_spaces` backend package containing role definitions, unit conversion, schemas, repository, discovery, service, and router boundaries. SQLite remains authoritative for configuration; current readings come from `EntityStateCache`. The React frontend uses Zod contracts, TanStack Query, a three-step wizard, and a grow-space detail route.

**Tech Stack:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic, SQLite WAL, pytest, React 19, TypeScript 5.9, TanStack Query/Router, Zod, Vitest, Testing Library, pnpm 11, uv, Docker.

## Global Constraints

- Preserve Home Assistant as the authority for entity state and physical equipment safety.
- This slice is read-only toward Home Assistant equipment; do not add service-call controls.
- Keep all frontend requests Ingress-relative; never introduce a leading `/` in browser API paths.
- Store configuration locally in SQLite and write audit records in the same transaction as each consequential change.
- Store area in square metres and volume in cubic metres; normalize known environmental units before exposing derived readings.
- Semantic roles are registry-validated strings, not a SQLite enum, so equipment roles can be added without redesigning the mapping table.
- A valid grow space requires core details only; all entity mappings are optional.
- Multiple entities may map to one role; duplicate `(grow_space_id, entity_id, role)` tuples are forbidden.
- Known incompatible Home Assistant metadata must fail with `422`; an unknown but syntactically valid manual entity ID is permitted.
- Preserve Ministry of Elsewhere styling, Civic Chimera dark mode, keyboard navigation, visible focus, and text alternatives for status.
- Use TDD for every behavior-bearing change: failing test, observed failure, minimal implementation, observed pass.
- Use pnpm rather than npm.
- The current source workspace has no Git metadata. During execution, checkpoint each completed task locally; publish verified changes through a feature branch and PR in `Skipyzi/remindme-homeassistant-addons`.

---

## File Structure

### Backend files to create

- `backend/cultivation_assistant/grow_spaces/__init__.py` — package boundary and public exports.
- `backend/cultivation_assistant/grow_spaces/roles.py` — semantic-role registry and compatibility metadata.
- `backend/cultivation_assistant/grow_spaces/units.py` — dimension and environmental unit normalization.
- `backend/cultivation_assistant/grow_spaces/schemas.py` — Pydantic request/response contracts.
- `backend/cultivation_assistant/grow_spaces/repository.py` — SQLAlchemy persistence queries only.
- `backend/cultivation_assistant/grow_spaces/discovery.py` — rank cached HA entities for a role.
- `backend/cultivation_assistant/grow_spaces/service.py` — transactions, validation, audit records, and live summaries.
- `backend/cultivation_assistant/grow_spaces/router.py` — `/api/v1` HTTP route definitions.
- `backend/alembic/versions/0002_grow_spaces.py` — grow-space and mapping tables.

### Backend files to modify

- `backend/cultivation_assistant/db/models.py` — add `GrowSpace` and `EntityMapping` ORM models.
- `backend/cultivation_assistant/home_assistant/state_cache.py` — expose a non-mutating snapshot and lookup helper for discovery.
- `backend/cultivation_assistant/main.py` — register the grow-space router with database/cache dependencies.

### Backend tests to create

- `backend/tests/test_grow_space_roles.py`
- `backend/tests/test_grow_space_units.py`
- `backend/tests/test_grow_space_migration.py`
- `backend/tests/test_grow_space_repository.py`
- `backend/tests/test_grow_space_api.py`
- `backend/tests/test_entity_discovery.py`
- `backend/tests/test_entity_mapping_api.py`

### Frontend files to create

- `frontend/src/api/growSpaces.ts` — Zod schemas, fetch functions, and query/mutation hooks.
- `frontend/src/api/growSpaces.test.ts` — API-contract and Ingress-path tests.
- `frontend/src/features/grow-spaces/types.ts` — wizard-only form state and supported unit types.
- `frontend/src/features/grow-spaces/GrowSpaceWizard.tsx` — three-step creation flow.
- `frontend/src/features/grow-spaces/GrowSpaceWizard.test.tsx` — wizard behavior tests.
- `frontend/src/features/grow-spaces/EntityMappingFields.tsx` — repeatable role-filtered mapping controls.
- `frontend/src/features/grow-spaces/EntityMappingFields.test.tsx` — suggestions, manual IDs, and multiple mappings.
- `frontend/src/routes/GrowSpaceDetailPage.tsx` — overview/environment detail route.
- `frontend/src/routes/GrowSpaceDetailPage.test.tsx` — detail state and archive behavior.
- `frontend/src/routes/GrowSpacesPage.test.tsx` — list, empty, loading, and retry states.

### Frontend files to modify

- `frontend/src/routes/GrowSpacesPage.tsx` — remove fixtures and open the wizard.
- `frontend/src/app/App.tsx` — register `/grow-spaces/$growSpaceId`.
- `frontend/src/styles.css` — wizard, mapping picker, detail, responsive, dark-mode, and focus styles.

### Documentation and packaging files to modify

- `scripts/export_openapi.py` output at `docs/openapi.json`
- `README.md`
- `cultivation/CHANGELOG.md`
- `cultivation/app/**` via `pnpm sync:addon`

---

### Task 1: Semantic Role Registry and Unit Normalization

**Files:**

- Create: `backend/cultivation_assistant/grow_spaces/__init__.py`
- Create: `backend/cultivation_assistant/grow_spaces/roles.py`
- Create: `backend/cultivation_assistant/grow_spaces/units.py`
- Test: `backend/tests/test_grow_space_roles.py`
- Test: `backend/tests/test_grow_space_units.py`

**Interfaces:**

- Produces: `EnvironmentalRole`, `RoleDefinition`, `ROLE_DEFINITIONS`, `get_role_definition(role: str) -> RoleDefinition`.
- Produces: `Compatibility`, `UnitCompatibility`, `classify_unit(role: str, source_unit: str | None) -> UnitCompatibility`.
- Produces: `normalize_environment_value(role: str, value: Decimal, source_unit: str) -> Decimal`.
- Produces: `normalize_area(value: Decimal, unit: str) -> Decimal` and `normalize_volume(value: Decimal, unit: str) -> Decimal`.

- [ ] **Step 1: Write failing role-registry tests**

```python
from cultivation_assistant.grow_spaces.roles import (
    EnvironmentalRole,
    get_role_definition,
)


def test_air_temperature_registry_accepts_celsius_and_fahrenheit() -> None:
    definition = get_role_definition(EnvironmentalRole.AIR_TEMPERATURE)

    assert definition.category == "environmental"
    assert definition.canonical_unit == "°C"
    assert definition.device_classes == frozenset({"temperature"})
    assert definition.source_units >= frozenset({"°C", "°F"})


def test_unknown_role_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unsupported semantic role"):
        get_role_definition("grow_light")
```

- [ ] **Step 2: Run the role tests and observe the expected import failure**

Run:

```bash
uv run pytest backend/tests/test_grow_space_roles.py -q
```

Expected: FAIL because `cultivation_assistant.grow_spaces.roles` does not exist.

- [ ] **Step 3: Implement the explicit environmental role registry**

Create string enum values for:

```python
class EnvironmentalRole(StrEnum):
    AIR_TEMPERATURE = "air_temperature"
    CANOPY_TEMPERATURE = "canopy_temperature"
    ROOT_ZONE_TEMPERATURE = "root_zone_temperature"
    RELATIVE_HUMIDITY = "relative_humidity"
    CO2 = "co2"
    ILLUMINANCE = "illuminance"
    PPFD = "ppfd"
    WATER_TEMPERATURE = "water_temperature"
    EXTERNAL_VPD = "external_vpd"
    POWER = "power"
    ENERGY = "energy"
    LEAK_DETECTION = "leak_detection"
```

Use an immutable role definition:

```python
@dataclass(frozen=True, slots=True)
class RoleDefinition:
    key: EnvironmentalRole
    category: Literal["environmental"]
    domains: frozenset[str]
    device_classes: frozenset[str]
    source_units: frozenset[str]
    canonical_unit: str | None
    default_stale_after_seconds: int
    name_hints: tuple[str, ...]
```

`get_role_definition` must coerce a string to `EnvironmentalRole` and raise `ValueError("Unsupported semantic role: ...")` on failure.

- [ ] **Step 4: Run role tests until green**

Run: `uv run pytest backend/tests/test_grow_space_roles.py -q`  
Expected: all tests pass.

- [ ] **Step 5: Write failing conversion tests**

```python
from decimal import Decimal

from cultivation_assistant.grow_spaces.units import (
    Compatibility,
    classify_unit,
    normalize_area,
    normalize_environment_value,
    normalize_volume,
)


def test_fahrenheit_is_convertible_and_normalized_to_celsius() -> None:
    result = classify_unit("air_temperature", "°F")

    assert result.compatibility is Compatibility.CONVERTIBLE
    assert result.normalized_unit == "°C"
    assert normalize_environment_value(
        "air_temperature", Decimal("77"), "°F"
    ) == Decimal("25")


def test_dimensions_are_normalized_to_si() -> None:
    assert normalize_area(Decimal("16"), "ft2").quantize(Decimal("0.0001")) == Decimal(
        "1.4864"
    )
    assert normalize_volume(Decimal("100"), "ft³").quantize(Decimal("0.0001")) == Decimal(
        "2.8317"
    )


def test_known_incompatible_unit_is_classified() -> None:
    result = classify_unit("relative_humidity", "ppm")

    assert result.compatibility is Compatibility.INCOMPATIBLE
```

- [ ] **Step 6: Run conversion tests and observe failure**

Run: `uv run pytest backend/tests/test_grow_space_units.py -q`  
Expected: FAIL because conversion functions do not exist.

- [ ] **Step 7: Implement Decimal-based conversion without a new dependency**

Use `Decimal` constants and quantize only at API serialization boundaries. Support:

```text
°F → °C
K → °C
kW → W
Wh → kWh
ft² → m²
ft³ → m³
```

Exact source units return `compatible`; known convertible units return `convertible`; missing units return `unknown`; known wrong units return `incompatible`.

- [ ] **Step 8: Verify Task 1**

Run:

```bash
uv run pytest backend/tests/test_grow_space_roles.py backend/tests/test_grow_space_units.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces backend/tests/test_grow_space_roles.py backend/tests/test_grow_space_units.py
uv run mypy backend/cultivation_assistant/grow_spaces
```

Expected: all tests and checks pass.

- [ ] **Step 9: Checkpoint**

Record the completed Task 1 file set. When executing in a Git checkout:

```bash
git add backend/cultivation_assistant/grow_spaces backend/tests/test_grow_space_roles.py backend/tests/test_grow_space_units.py
git commit -m "feat: add environmental role and unit registry"
```

---

### Task 2: Grow-Space Database Schema and Migration

**Files:**

- Modify: `backend/cultivation_assistant/db/models.py`
- Create: `backend/alembic/versions/0002_grow_spaces.py`
- Test: `backend/tests/test_grow_space_migration.py`
- Modify: `backend/tests/test_migrations.py`

**Interfaces:**

- Consumes: role strings and normalized units from Task 1.
- Produces: ORM classes `GrowSpace` and `EntityMapping`.
- Produces: migration revision `0002` with down revision `0001`.

- [ ] **Step 1: Write the failing migration test**

```python
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_grow_space_migration_creates_constraints(tmp_path: Path) -> None:
    database_path = tmp_path / "cultivation.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        inspector = inspect(engine)
        constraints = inspector.get_unique_constraints("entity_mappings")
        assert {"grow_spaces", "entity_mappings"} <= set(inspector.get_table_names())
        assert any(
            constraint["column_names"] == ["grow_space_id", "entity_id", "role"]
            for constraint in constraints
        )
    finally:
        engine.dispose()
```

The test exercises Alembic directly and does not shell out.

- [ ] **Step 2: Run the migration test and observe failure**

Run: `uv run pytest backend/tests/test_grow_space_migration.py -q`  
Expected: FAIL because revision `0002` and the tables are absent.

- [ ] **Step 3: Add ORM models**

Add relationships and columns using SQLAlchemy 2 typed mappings:

```python
class GrowSpace(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "grow_spaces"

    name: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    description: orm.Mapped[str | None] = orm.mapped_column(sa.Text)
    location: orm.Mapped[str | None] = orm.mapped_column(sa.String(200))
    space_type: orm.Mapped[str] = orm.mapped_column(sa.String(40), nullable=False)
    active: orm.Mapped[bool] = orm.mapped_column(default=True, nullable=False)
    area_m2: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    volume_m3: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    mappings: orm.Mapped[list[EntityMapping]] = orm.relationship(
        back_populates="grow_space", cascade="all, delete-orphan"
    )
```

```python
class EntityMapping(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "entity_mappings"
    __table_args__ = (
        sa.UniqueConstraint("grow_space_id", "entity_id", "role", name="uq_mapping_role"),
        sa.CheckConstraint("priority >= 0", name="ck_mapping_priority"),
        sa.CheckConstraint("stale_after_seconds > 0", name="ck_mapping_stale"),
    )

    grow_space_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("grow_spaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entity_id: orm.Mapped[str] = orm.mapped_column(sa.String(255), nullable=False)
    role: orm.Mapped[str] = orm.mapped_column(sa.String(80), nullable=False)
    display_name: orm.Mapped[str | None] = orm.mapped_column(sa.String(160))
    priority: orm.Mapped[int] = orm.mapped_column(default=100, nullable=False)
    source_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(40))
    normalized_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(40))
    enabled: orm.Mapped[bool] = orm.mapped_column(default=True, nullable=False)
    calibration: orm.Mapped[dict[str, Any] | None] = orm.mapped_column(sa.JSON)
    stale_after_seconds: orm.Mapped[int] = orm.mapped_column(nullable=False)
    grow_space: orm.Mapped[GrowSpace] = orm.relationship(back_populates="mappings")
```

Use forward annotations or place `EntityMapping` before `GrowSpace` to avoid runtime name errors.

- [ ] **Step 4: Create migration `0002_grow_spaces.py`**

The migration must create both tables, foreign key, checks, unique constraint, active/name index, and mapping lookup indexes. `downgrade()` drops `entity_mappings` before `grow_spaces`.

- [ ] **Step 5: Verify migration upgrade and downgrade**

Run:

```bash
uv run pytest backend/tests/test_grow_space_migration.py backend/tests/test_migrations.py -q
```

Update `test_database_reports_current_schema_version` in `backend/tests/test_migrations.py` to expect `"0002"`.

Expected: all tests pass and schema head reports `0002`.

- [ ] **Step 6: Checkpoint**

```bash
git add backend/cultivation_assistant/db/models.py backend/alembic/versions/0002_grow_spaces.py backend/tests/test_grow_space_migration.py backend/tests/test_migrations.py
git commit -m "feat: add grow space persistence schema"
```

---

### Task 3: Pydantic Contracts and Repository

**Files:**

- Create: `backend/cultivation_assistant/grow_spaces/schemas.py`
- Create: `backend/cultivation_assistant/grow_spaces/repository.py`
- Test: `backend/tests/test_grow_space_repository.py`

**Interfaces:**

- Consumes: ORM models from Task 2 and normalization functions from Task 1.
- Produces: `GrowSpaceCreate`, `GrowSpaceUpdate`, `EntityMappingCreate`, `EntityMappingUpdate`, `GrowSpaceResponse`, `GrowSpaceSummary`, `EntityMappingResponse`.
- Produces: `GrowSpaceRepository(session: AsyncSession)` with `list`, `get`, `add`, `active_name_exists`, `add_mapping`, `get_mapping`, and `delete_mapping` methods.

- [ ] **Step 1: Write failing schema tests**

```python
def test_create_schema_normalizes_imperial_dimensions() -> None:
    request = GrowSpaceCreate.model_validate(
        {
            "name": " North tent ",
            "space_type": "tent",
            "area": {"value": "16", "unit": "ft²"},
            "volume": {"value": "100", "unit": "ft³"},
            "mappings": [],
        }
    )

    assert request.name == "North tent"
    assert request.area_m2.quantize(Decimal("0.0001")) == Decimal("1.4864")
    assert request.volume_m3.quantize(Decimal("0.0001")) == Decimal("2.8317")


def test_mapping_schema_rejects_invalid_entity_id() -> None:
    with pytest.raises(ValidationError):
        EntityMappingCreate(entity_id="not an entity", role="air_temperature")
```

- [ ] **Step 2: Run tests and observe missing contracts**

Run: `uv run pytest backend/tests/test_grow_space_repository.py -q`  
Expected: FAIL on missing schemas/repository.

- [ ] **Step 3: Implement strict request contracts**

Use constrained strings, `Decimal`, and validators. Dimension input is:

```python
class DimensionInput(BaseModel):
    value: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    unit: Literal["m²", "ft²", "m³", "ft³"]
```

Expose computed `area_m2` and `volume_m3` on `GrowSpaceCreate`; reject a volume unit in `area` and an area unit in `volume`. `EntityMappingCreate.stale_after_seconds` defaults from its role definition when omitted and is constrained to `30..86400`.

- [ ] **Step 4: Implement repository queries without HTTP concerns**

Repository methods return ORM records or `None`. `list` accepts `include_archived: bool`; default ordering is active first, then case-insensitive name. `get` uses `selectinload(GrowSpace.mappings)`.

- [ ] **Step 5: Write repository transaction tests**

Cover persistence, mapping cascade, list filtering, eager mappings, and case-insensitive active-name detection using a temporary migrated SQLite database.

- [ ] **Step 6: Verify Task 3**

Run:

```bash
uv run pytest backend/tests/test_grow_space_repository.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces/schemas.py backend/cultivation_assistant/grow_spaces/repository.py backend/tests/test_grow_space_repository.py
uv run mypy backend/cultivation_assistant/grow_spaces
```

Expected: all pass.

- [ ] **Step 7: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces/schemas.py backend/cultivation_assistant/grow_spaces/repository.py backend/tests/test_grow_space_repository.py
git commit -m "feat: add grow space contracts and repository"
```

---

### Task 4: Grow-Space Service, Audit, and CRUD API

**Files:**

- Create: `backend/cultivation_assistant/grow_spaces/service.py`
- Create: `backend/cultivation_assistant/grow_spaces/router.py`
- Modify: `backend/cultivation_assistant/main.py`
- Test: `backend/tests/test_grow_space_api.py`

**Interfaces:**

- Consumes: Task 3 repository/contracts and existing `Database.transaction()`.
- Produces: `GrowSpaceService(database: Database, state_cache: EntityStateCache)`.
- Produces: `create_router(database: Database, state_cache: EntityStateCache) -> APIRouter`.
- Produces `GET /api/v1/grow-spaces`, `POST /api/v1/grow-spaces`, `GET /api/v1/grow-spaces/{id}`, `PATCH /api/v1/grow-spaces/{id}`, and archival `DELETE /api/v1/grow-spaces/{id}`.

- [ ] **Step 1: Write failing API tests for details-only creation**

```python
async def test_create_and_list_details_only_grow_space(client: AsyncClient) -> None:
    created = await client.post(
        "/api/v1/grow-spaces",
        json={"name": "North tent", "space_type": "tent", "mappings": []},
    )

    assert created.status_code == 201
    grow_space = created.json()
    assert grow_space["name"] == "North tent"
    assert grow_space["active"] is True
    assert grow_space["mappings"] == []

    listed = await client.get("/api/v1/grow-spaces")
    assert [item["id"] for item in listed.json()["items"]] == [grow_space["id"]]
```

Add tests for retrieve, patch, archive, archived filter, duplicate active name (`409`), missing resource (`404`), and archived mutation (`409`).

- [ ] **Step 2: Run API tests and observe 404 failures**

Run: `uv run pytest backend/tests/test_grow_space_api.py -q`  
Expected: FAIL because routes are not registered.

- [ ] **Step 3: Implement application service transactions**

Use one `Database.transaction()` per command. Example shape:

```python
async def create(self, request: GrowSpaceCreate, correlation_id: str) -> GrowSpaceResponse:
    async with self._database.transaction() as session:
        repository = GrowSpaceRepository(session)
        if await repository.active_name_exists(request.name):
            raise GrowSpaceConflict("An active grow space with this name already exists")
        grow_space = await repository.add(request)
        mappings = [await self._add_validated_mapping(repository, grow_space, item) for item in request.mappings]
        session.add(
            AuditLog(
                actor="local_user",
                action="grow_space.created",
                resource_type="grow_space",
                resource_id=grow_space.id,
                correlation_id=correlation_id,
                details={"name": grow_space.name, "mapping_count": len(mappings)},
            )
        )
    return self._to_response(grow_space)
```

Define focused domain exceptions in `service.py`: `GrowSpaceNotFound`, `GrowSpaceConflict`, and `GrowSpaceValidationError`.

- [ ] **Step 4: Implement router exception mapping**

Map domain exceptions to the existing HTTP envelope via `HTTPException` status codes `404`, `409`, and `422`. Read the request correlation ID from `middleware.correlation_id` for audit records.

- [ ] **Step 5: Register router before the static frontend mount**

In `create_app`, call:

```python
app.include_router(
    create_grow_spaces_router(runtime_database, state_cache),
    prefix="/api/v1",
)
```

Place it before `app.mount("/", ...)` so the static mount cannot shadow API routes.

- [ ] **Step 6: Verify audit atomicity**

Add tests that query `audit_log` after create/update/archive and a rollback test proving an invalid nested mapping creates neither a grow space nor an audit record.

- [ ] **Step 7: Verify Task 4**

Run:

```bash
uv run pytest backend/tests/test_grow_space_api.py backend/tests/test_http_foundation.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces backend/cultivation_assistant/main.py backend/tests/test_grow_space_api.py
uv run mypy backend/cultivation_assistant
```

Expected: all pass.

- [ ] **Step 8: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces/service.py backend/cultivation_assistant/grow_spaces/router.py backend/cultivation_assistant/main.py backend/tests/test_grow_space_api.py
git commit -m "feat: expose audited grow space CRUD API"
```

---

### Task 5: Home Assistant Entity Discovery

**Files:**

- Modify: `backend/cultivation_assistant/home_assistant/state_cache.py`
- Create: `backend/cultivation_assistant/grow_spaces/discovery.py`
- Modify: `backend/cultivation_assistant/grow_spaces/schemas.py`
- Modify: `backend/cultivation_assistant/grow_spaces/router.py`
- Test: `backend/tests/test_entity_discovery.py`

**Interfaces:**

- Consumes: `ROLE_DEFINITIONS`, `classify_unit`, `EntityStateCache`, and `RuntimeStatus`.
- Produces: `EntityCandidate`, `EntityDiscoveryResponse`.
- Produces: `EntityDiscoveryService.suggest(role: str) -> list[EntityCandidate]`.
- Produces: `GET /api/v1/home-assistant/entities?role=...`.

- [ ] **Step 1: Write failing ranking tests**

```python
from typing import Any

from cultivation_assistant.grow_spaces.discovery import EntityDiscoveryService
from cultivation_assistant.home_assistant.state_cache import EntityStateCache


def state(
    entity_id: str,
    value: str,
    unit: str | None,
    device_class: str | None,
    friendly_name: str,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": "2026-07-22T12:00:00Z",
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": device_class,
            "friendly_name": friendly_name,
        },
    }


def test_discovery_ranks_exact_then_convertible_then_hint() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.room_temp", "24", "°C", "temperature", "Room temperature"))
    cache.update(state("sensor.tent_temp_f", "77", "°F", "temperature", "Tent temperature"))
    cache.update(state("sensor.air_probe", "24", None, None, "Air probe"))

    candidates = EntityDiscoveryService(cache).suggest("air_temperature")

    assert [item.entity_id for item in candidates] == [
        "sensor.room_temp",
        "sensor.tent_temp_f",
        "sensor.air_probe",
    ]
    assert [item.compatibility for item in candidates] == [
        "compatible",
        "convertible",
        "unknown",
    ]
```

Add tests excluding known-incompatible units, retaining unavailable states, invalid role rejection, and empty cache behavior.

- [ ] **Step 2: Run discovery tests and observe failure**

Run: `uv run pytest backend/tests/test_entity_discovery.py -q`  
Expected: FAIL because discovery service and cache snapshot are absent.

- [ ] **Step 3: Add a read-only cache snapshot**

Add:

```python
def snapshot(self) -> tuple[EntityState, ...]:
    return tuple(self._states.values())


def find(self, entity_id: str) -> EntityState | None:
    return self._states.get(entity_id)
```

Keep existing `get` behavior for callers that require `KeyError`.

- [ ] **Step 4: Implement deterministic candidate scoring**

Sort by a tuple of compatibility rank, device-class match, negative name-hint count, friendly name, and entity ID. Do not mutate or persist cache data.

- [ ] **Step 5: Implement discovery endpoint**

Return `503` only when runtime status reports Home Assistant unavailable. Return `200` with an empty list when HA is connected but no compatible entities exist. Include current state, source unit, last update, availability, compatibility, and explanation.

- [ ] **Step 6: Verify Task 5**

Run:

```bash
uv run pytest backend/tests/test_entity_discovery.py backend/tests/test_home_assistant_state_cache.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces/discovery.py backend/cultivation_assistant/home_assistant/state_cache.py backend/tests/test_entity_discovery.py
uv run mypy backend/cultivation_assistant
```

Expected: all pass.

- [ ] **Step 7: Checkpoint**

```bash
git add backend/cultivation_assistant/home_assistant/state_cache.py backend/cultivation_assistant/grow_spaces/discovery.py backend/cultivation_assistant/grow_spaces/schemas.py backend/cultivation_assistant/grow_spaces/router.py backend/tests/test_entity_discovery.py
git commit -m "feat: add role-filtered Home Assistant discovery"
```

---

### Task 6: Entity-Mapping Lifecycle and Live Summaries

**Files:**

- Modify: `backend/cultivation_assistant/grow_spaces/service.py`
- Modify: `backend/cultivation_assistant/grow_spaces/router.py`
- Modify: `backend/cultivation_assistant/grow_spaces/schemas.py`
- Test: `backend/tests/test_entity_mapping_api.py`

**Interfaces:**

- Consumes: repository, role registry, discovery compatibility, and cache lookup.
- Produces mapping create/update/delete endpoints.
- Produces `LiveReading` and summary fields on grow-space responses.

- [ ] **Step 1: Write failing mapping tests**

```python
async def test_multiple_entities_can_map_to_same_role(client: AsyncClient, grow_space_id: str) -> None:
    first = await client.post(
        f"/api/v1/grow-spaces/{grow_space_id}/entity-mappings",
        json={"entity_id": "sensor.canopy_left", "role": "air_temperature", "priority": 10},
    )
    second = await client.post(
        f"/api/v1/grow-spaces/{grow_space_id}/entity-mappings",
        json={"entity_id": "sensor.canopy_right", "role": "air_temperature", "priority": 20},
    )

    assert first.status_code == second.status_code == 201


async def test_duplicate_entity_role_is_conflict(client: AsyncClient, grow_space_id: str) -> None:
    payload = {"entity_id": "sensor.canopy_left", "role": "air_temperature"}
    assert (await client.post(mapping_url(grow_space_id), json=payload)).status_code == 201
    assert (await client.post(mapping_url(grow_space_id), json=payload)).status_code == 409
```

Add tests for unknown manual IDs, known incompatible units (`422`), defaults from the role registry, patch, enable/disable, delete, audit records, and archived-space rejection.

- [ ] **Step 2: Run mapping tests and observe route failures**

Run: `uv run pytest backend/tests/test_entity_mapping_api.py -q`  
Expected: FAIL because mapping routes do not exist.

- [ ] **Step 3: Validate mapping metadata at command time**

When the entity exists in cache:

- Capture `unit_of_measurement` as `source_unit`.
- Classify against the role.
- Reject `incompatible` with a role-specific message.
- Store the role canonical unit as `normalized_unit`.

When absent:

- Accept valid syntax.
- Store `source_unit=None`.
- Store the role canonical unit.
- Report compatibility `unknown` in responses until the entity appears.

- [ ] **Step 4: Add live summary serialization**

For each enabled mapping with a cached state, expose:

```python
class LiveReading(BaseModel):
    entity_id: str
    role: str
    raw_value: str
    normalized_value: Decimal | bool | None
    normalized_unit: str | None
    last_updated: datetime
    stale: bool
    available: bool
```

Do not write these readings to SQLite. A conversion failure returns `normalized_value=None` and a compatibility warning; it must not crash the list endpoint.

- [ ] **Step 5: Verify Task 6**

Run:

```bash
uv run pytest backend/tests/test_entity_mapping_api.py backend/tests/test_grow_space_api.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces backend/tests/test_entity_mapping_api.py
uv run mypy backend/cultivation_assistant
```

Expected: all pass.

- [ ] **Step 6: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces backend/tests/test_entity_mapping_api.py
git commit -m "feat: manage environmental entity mappings"
```

---

### Task 7: Typed Frontend API Client

**Files:**

- Create: `frontend/src/api/growSpaces.ts`
- Create: `frontend/src/api/growSpaces.test.ts`
- Create: `frontend/src/features/grow-spaces/types.ts`

**Interfaces:**

- Consumes: backend JSON contracts from Tasks 4–6.
- Produces: `growSpaceSchema`, `entityCandidateSchema`, `listGrowSpaces`, `createGrowSpace`, `getGrowSpace`, `archiveGrowSpace`, `discoverEntities`.
- Produces hooks: `useGrowSpaces`, `useGrowSpace`, `useCreateGrowSpace`, `useArchiveGrowSpace`, `useEntityCandidates`.

- [ ] **Step 1: Write failing Ingress-relative API tests**

```typescript
it("creates a grow space through an Ingress-relative URL", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(growSpaceFixture), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );

  await createGrowSpace(
    { name: "North tent", spaceType: "tent", mappings: [] },
    fetcher,
  );

  expect(fetcher).toHaveBeenCalledWith(
    "api/v1/grow-spaces",
    expect.objectContaining({ method: "POST" }),
  );
});

it("rejects a malformed grow-space response", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

  await expect(listGrowSpaces(false, fetcher)).rejects.toThrow(
    "Invalid grow-space response",
  );
});
```

- [ ] **Step 2: Run the frontend API test and observe import failure**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/api/growSpaces.test.ts`  
Expected: FAIL because `growSpaces.ts` does not exist.

- [ ] **Step 3: Implement Zod schemas matching backend camel/snake policy**

Use the backend's JSON field names consistently. Keep API payload adaptation in this module, not in UI components. Define `ApiError` that parses the existing `{error:{code,message,details}}` envelope.

- [ ] **Step 4: Implement query and mutation hooks**

Use query keys:

```typescript
const growSpaceKeys = {
  all: ["grow-spaces"] as const,
  list: (includeArchived: boolean) => ["grow-spaces", { includeArchived }] as const,
  detail: (id: string) => ["grow-spaces", id] as const,
  candidates: (role: string) => ["home-assistant", "entities", role] as const,
};
```

On create, invalidate list queries and seed the detail query. On archive, invalidate list/detail queries. Discovery should not retry `422` and should display `503` as an offline state.

- [ ] **Step 5: Verify Task 7**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/api/growSpaces.test.ts
pnpm --filter cultivation-assistant-frontend lint
```

Expected: all pass.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/src/api/growSpaces.ts frontend/src/api/growSpaces.test.ts frontend/src/features/grow-spaces/types.ts
git commit -m "feat: add typed grow spaces frontend client"
```

---

### Task 8: Guided Wizard and Entity Mapping Controls

**Files:**

- Create: `frontend/src/features/grow-spaces/GrowSpaceWizard.tsx`
- Create: `frontend/src/features/grow-spaces/GrowSpaceWizard.test.tsx`
- Create: `frontend/src/features/grow-spaces/EntityMappingFields.tsx`
- Create: `frontend/src/features/grow-spaces/EntityMappingFields.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 7 hooks and wizard form types.
- Produces: `GrowSpaceWizard({ open, onClose, onCreated })`.
- Produces: `EntityMappingFields({ mappings, onChange })`.

- [ ] **Step 1: Write failing details-only wizard test**

```tsx
it("creates a grow space without requiring mappings", async () => {
  const user = userEvent.setup();
  renderWizard();

  await user.type(screen.getByLabelText(/name/i), "North tent");
  await user.selectOptions(screen.getByLabelText(/space type/i), "tent");
  await user.click(screen.getByRole("button", { name: /continue/i }));
  await user.click(screen.getByRole("button", { name: /review/i }));
  await user.click(screen.getByRole("button", { name: /create grow space/i }));

  expect(createGrowSpace).toHaveBeenCalledWith(
    expect.objectContaining({ name: "North tent", mappings: [] }),
  );
});
```

Add tests that blank names cannot advance, back navigation retains values, failed save retains values and focuses the error summary, and successful save calls `onCreated`.

- [ ] **Step 2: Run wizard tests and observe missing component failure**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces/GrowSpaceWizard.test.tsx`  
Expected: FAIL because the wizard does not exist.

- [ ] **Step 3: Implement the three-step state machine**

Use a local discriminated step type:

```typescript
type WizardStep = "details" | "mappings" | "review";
```

Do not persist drafts to the backend before the final create mutation. Keep form values in React state. Convert area/volume inputs into the backend `DimensionInput` payload without pre-normalizing them in the browser.

- [ ] **Step 4: Write failing mapping-field tests**

Cover role-filtered queries, suggestions, manual IDs, adding a second mapping for the same role, removing a draft row, advanced priority/stale fields, and offline discovery explanation.

- [ ] **Step 5: Implement accessible mapping controls**

Use real labels, a listbox/combobox pattern supported by keyboard input, and an ordinary text input for manual IDs. Never rely on compatibility color alone; render explicit `Compatible`, `Convertible`, or `Unknown` text.

- [ ] **Step 6: Add responsive and theme styles**

Add focused `.grow-space-wizard`, `.wizard-steps`, `.mapping-role-group`, `.entity-suggestion`, `.compatibility-label`, and `.error-summary` rules. Include existing dark-theme selectors and mobile behavior below the project's current responsive breakpoint. Preserve visible `:focus-visible` outlines.

- [ ] **Step 7: Verify Task 8**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces
pnpm --filter cultivation-assistant-frontend lint
pnpm --filter cultivation-assistant-frontend build
```

Expected: all pass.

- [ ] **Step 8: Checkpoint**

```bash
git add frontend/src/features/grow-spaces frontend/src/styles.css
git commit -m "feat: add grow space setup wizard"
```

---

### Task 9: Real Grow-Space List and Detail Route

**Files:**

- Modify: `frontend/src/routes/GrowSpacesPage.tsx`
- Create: `frontend/src/routes/GrowSpacesPage.test.tsx`
- Create: `frontend/src/routes/GrowSpaceDetailPage.tsx`
- Create: `frontend/src/routes/GrowSpaceDetailPage.test.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 7 query hooks and Task 8 wizard.
- Produces: fixture-free grow-space list and `/grow-spaces/$growSpaceId` detail route.

- [ ] **Step 1: Write failing list-state tests**

```tsx
it("shows onboarding when no grow spaces exist", () => {
  mockUseGrowSpaces.mockReturnValue({ data: { items: [] }, isLoading: false });
  renderPage();

  expect(screen.getByText(/create your first grow space/i)).toBeInTheDocument();
  expect(screen.queryByText("North tent")).not.toBeInTheDocument();
});

it("renders API grow spaces instead of fixtures", () => {
  mockUseGrowSpaces.mockReturnValue({ data: { items: [growSpaceFixture] }, isLoading: false });
  renderPage();

  expect(screen.getByText(growSpaceFixture.name)).toBeInTheDocument();
  expect(screen.getByText(/2 mapped entities/i)).toBeInTheDocument();
});
```

Add loading skeleton, retry, archived toggle, and wizard-open tests.

- [ ] **Step 2: Run list tests and observe fixture behavior failure**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/routes/GrowSpacesPage.test.tsx`  
Expected: FAIL because the page still renders hard-coded spaces.

- [ ] **Step 3: Replace fixture list with query states**

Cards show type, location/dimensions, active state, mapping count, highest-priority non-stale air temperature when available, and a Manage link. No placeholder live value is displayed when no valid mapping exists.

- [ ] **Step 4: Write failing detail tests**

Cover overview metadata, environmental role groups, stale/unavailable text, archive confirmation, and explicit disabled/coming-soon presentation for Equipment, Targets, and Reservoirs without clickable fake controls.

- [ ] **Step 5: Implement detail route and register it**

Add:

```typescript
const growSpaceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grow-spaces/$growSpaceId",
  component: GrowSpaceDetailPage,
});
```

Include it in the route tree. The detail page retrieves `growSpaceId` through TanStack Router params.

- [ ] **Step 6: Verify Task 9**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/routes/GrowSpacesPage.test.tsx src/routes/GrowSpaceDetailPage.test.tsx
pnpm --filter cultivation-assistant-frontend lint
pnpm --filter cultivation-assistant-frontend build
```

Expected: all pass.

- [ ] **Step 7: Checkpoint**

```bash
git add frontend/src/routes/GrowSpacesPage.tsx frontend/src/routes/GrowSpacesPage.test.tsx frontend/src/routes/GrowSpaceDetailPage.tsx frontend/src/routes/GrowSpaceDetailPage.test.tsx frontend/src/app/App.tsx frontend/src/styles.css
git commit -m "feat: connect grow spaces UI to live data"
```

---

### Task 10: Contract, Packaging, Container, and Publication Verification

**Files:**

- Modify: `README.md`
- Modify: `cultivation/CHANGELOG.md`
- Regenerate: `docs/openapi.json`
- Regenerate: `cultivation/app/**`
- Verify: all backend, frontend, Docker, and target-repository files

**Interfaces:**

- Consumes: all previous tasks.
- Produces: retained OpenAPI contract, current self-contained add-on context, tested Docker image, and a feature PR against `Skipyzi/remindme-homeassistant-addons`.

- [ ] **Step 1: Add documentation assertions where packaging behavior is testable**

Extend `backend/tests/test_app_packaging.py` to assert that synchronized context contains revision `0002`, grow-space backend modules, and the real Grow Spaces frontend API module.

- [ ] **Step 2: Update user documentation**

Document:

- Creating a universal grow space
- Optional environmental mapping
- Supported first-slice roles and canonical units
- Manual ID behavior when Home Assistant discovery is offline
- Archival semantics
- Equipment as a deferred attachable capability with no direct controls

Add a `0.2.0` section to `cultivation/CHANGELOG.md` and update app/backend/frontend versions together only if this release is intended for installation immediately.

- [ ] **Step 3: Export the OpenAPI contract**

Run:

```bash
pnpm openapi:export
```

Expected: `docs/openapi.json` includes `/api/v1/grow-spaces` and `/api/v1/home-assistant/entities`.

- [ ] **Step 4: Run proactive diagnostics before the full build**

Run LSP diagnostics over:

```text
backend/cultivation_assistant/grow_spaces
backend/cultivation_assistant/db/models.py
backend/cultivation_assistant/main.py
frontend/src/api/growSpaces.ts
frontend/src/features/grow-spaces
frontend/src/routes/GrowSpacesPage.tsx
frontend/src/routes/GrowSpaceDetailPage.tsx
```

Expected: zero errors.

- [ ] **Step 5: Run the complete repository verification**

Run:

```bash
pnpm verify
```

Expected:

- ESLint passes
- Ruff passes
- mypy passes
- all Vitest tests pass
- all pytest tests pass
- TypeScript/Vite production build passes

- [ ] **Step 6: Verify fresh migration and app smoke**

Run Alembic against an empty temporary data directory, start the ASGI app with the built frontend, and assert:

```text
GET /api/v1/health -> 200
GET /api/v1/readiness -> 503 without Home Assistant
GET /api/v1/grow-spaces -> 200 with an empty items list
GET / -> 200 with Cultivation Assistant title
schema_version -> 0002
```

- [ ] **Step 7: Synchronize and build the add-on**

Run:

```bash
pnpm sync:addon
pnpm docker:build
```

Expected: image `cultivation-assistant:dev` builds successfully and the generated context matches canonical backend/frontend source excluding intentional test/build exclusions.

- [ ] **Step 8: Run degraded and connected container smoke tests**

Repeat the established container checks:

- No Supervisor: health `200`, readiness `503`, schema `0002`, frontend `200`, restart count `0`.
- Mock authenticated Home Assistant REST/WebSocket: readiness `200`, Home Assistant `ready`, schema `0002`, restart count `0`.
- Container logs contain no Python traceback, `ValueError`, or critical error.

- [ ] **Step 9: Publish through a verified feature branch**

Clone `https://github.com/Skipyzi/remindme-homeassistant-addons`, create `feat/grow-spaces-entity-mapping`, replace `cultivation-assistant/` with the synchronized verified context, and run:

```bash
git add cultivation-assistant
git diff --cached --check
git commit -m "feat: add grow spaces and environmental mapping"
git archive HEAD cultivation-assistant | tar -x -C ../committed-build-check
docker build -t cultivation-assistant:repo-check ../committed-build-check/cultivation-assistant
git push -u origin feat/grow-spaces-entity-mapping
```

Create a PR that lists test counts, migration head, Docker build evidence, and both smoke-test modes. Do not merge until the committed-archive Docker build succeeds and the PR is mergeable.

- [ ] **Step 10: Final evidence check**

Verify the remote PR commit SHA, changed file list, and target `main` base. Report any live-Home-Assistant installation step that remains unverified rather than implying it passed.
