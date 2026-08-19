# Grows, Plants, and Lifecycle Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class Grows, minimal structured cultivars, customizable lifecycle stages, individually tracked Plants, and append-only audited stage transitions.

**Architecture:** Extend the modular monolith with focused `library`, `lifecycle`, `grows`, and `plants` vertical slices, backed by migration `0004`. Keep mutable current state on Grow and Plant records while preserving immutable Plant stage-transition history; expose typed FastAPI contracts and build React register, detail, editing, duplication, and stage-management workflows over Ingress-relative APIs.

**Tech Stack:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic, SQLite WAL, React, TypeScript, Zod, TanStack Query, TanStack Router, Vitest, Testing Library, pnpm, uv, Docker.

## Global Constraints

- Use red-green-refactor TDD for every behavior-bearing change.
- Use first-class Grow records between Grow Spaces and Plants.
- Cultivars are structured records; breeder is optional and cultivar is required by Plant.
- Lifecycle stages are installation-wide stable records that users can rename, disable, reorder, or extend.
- Plant stage transitions are append-only and may move to any enabled stage after confirmation when non-adjacent.
- Current stage is derived deterministically by `(effective_at, created_at, id)` and transactionally projected onto the Plant.
- Plan dates and actual dates remain separate.
- Grow Spaces and environmental mappings remain unchanged and Home Assistant-independent records remain usable while Home Assistant is offline.
- Requests remain Home Assistant Ingress-relative.
- Preserve the Ministry of Elsewhere UI, restrained Art Nouveau details, Civic Chimera dark mode, accessible text status, responsive behavior, and reduced motion.
- Use pnpm rather than npm.
- Migration head becomes exactly `0004`; release version becomes exactly `0.3.0`.
- Synchronize every release version location before publication; do not repeat the `0.2.1` follow-up correction.
- The source workspace has no Git metadata. Record checkpoints there and commit synchronized changes in the Git-backed publication clone.

---

### Task 1: Lifecycle Vocabulary and Transition Rules

**Files:**

- Create: `backend/cultivation_assistant/lifecycle/__init__.py`
- Create: `backend/cultivation_assistant/lifecycle/rules.py`
- Create: `backend/tests/test_lifecycle_rules.py`

**Interfaces:**

- Produces: `GrowStatus`, `PlantStatus`, `PropagationSource`, `SeedType`, `TransitionSource`, `ordered_current_stage`, and `requires_transition_confirmation`.
- `ordered_current_stage(transitions: Iterable[TransitionOrder]) -> str` returns the stage ID of the latest transition ordered by effective time, creation time, and ID.
- `requires_transition_confirmation(stage_ids: Sequence[str], current_id: str, target_id: str) -> bool` returns true for backward or skipped movement.
- Consumers: Tasks 4–6 use these stable enums and pure rules.

- [ ] **Step 1: Write failing pure-domain tests**

```python
from datetime import UTC, datetime

from cultivation_assistant.lifecycle.rules import (
    TransitionOrder,
    ordered_current_stage,
    requires_transition_confirmation,
)


def test_backdated_transition_does_not_replace_later_current_stage() -> None:
    transitions = [
        TransitionOrder("t2", "flowering", datetime(2026, 7, 10, tzinfo=UTC), datetime(2026, 7, 10, tzinfo=UTC)),
        TransitionOrder("t1", "vegetative", datetime(2026, 7, 1, tzinfo=UTC), datetime(2026, 7, 12, tzinfo=UTC)),
    ]
    assert ordered_current_stage(transitions) == "flowering"


def test_backward_and_skipped_moves_require_confirmation() -> None:
    stages = ["seed", "seedling", "vegetative", "flowering"]
    assert not requires_transition_confirmation(stages, "seedling", "vegetative")
    assert requires_transition_confirmation(stages, "vegetative", "seedling")
    assert requires_transition_confirmation(stages, "seed", "flowering")
```

- [ ] **Step 2: Run the test and verify RED**

Run: `uv run pytest backend/tests/test_lifecycle_rules.py -q`
Expected: FAIL because `cultivation_assistant.lifecycle` does not exist.

- [ ] **Step 3: Implement the minimal vocabulary and ordering functions**

```python
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class GrowStatus(StrEnum):
    PLANNED = "planned"
    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class PlantStatus(StrEnum):
    PLANNED = "planned"
    ACTIVE = "active"
    HARVESTED = "harvested"
    COMPLETED = "completed"
    LOST = "lost"
    ARCHIVED = "archived"


class PropagationSource(StrEnum):
    SEED = "seed"
    CLONE = "clone"


class SeedType(StrEnum):
    REGULAR = "regular"
    FEMINIZED = "feminized"
    AUTOFLOWER = "autoflower"
    UNKNOWN = "unknown"


class TransitionSource(StrEnum):
    USER_CONFIRMED = "user_confirmed"
    USER_ADJUSTED = "user_adjusted"
    IMPORTED = "imported"
    APPLICATION_RECALCULATION = "application_recalculation"


@dataclass(frozen=True, slots=True)
class TransitionOrder:
    id: str
    to_stage_id: str
    effective_at: datetime
    created_at: datetime


def ordered_current_stage(transitions: Iterable[TransitionOrder]) -> str:
    ordered = max(transitions, key=lambda item: (item.effective_at, item.created_at, item.id))
    return ordered.to_stage_id


def requires_transition_confirmation(
    stage_ids: Sequence[str], current_id: str, target_id: str
) -> bool:
    return stage_ids.index(target_id) != stage_ids.index(current_id) + 1
```

- [ ] **Step 4: Run focused tests and analyzers**

Run:

```bash
uv run pytest backend/tests/test_lifecycle_rules.py -q
uv run ruff check backend/cultivation_assistant/lifecycle backend/tests/test_lifecycle_rules.py
uv run mypy backend/cultivation_assistant/lifecycle
```

Expected: tests pass and analyzers report no issues.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/lifecycle backend/tests/test_lifecycle_rules.py
git commit -m "feat: define cultivation lifecycle rules"
```

---

### Task 2: Migration `0004` and Persistence Models

**Files:**

- Create: `backend/alembic/versions/0004_grows_plants_lifecycle.py`
- Modify: `backend/cultivation_assistant/db/models.py`
- Create: `backend/tests/test_grows_plants_migration.py`
- Modify: `backend/tests/test_migrations.py`

**Interfaces:**

- Produces ORM models `Breeder`, `Cultivar`, `LifecycleStage`, `Grow`, `Plant`, and `PlantStageTransition`.
- Produces deterministic built-in lifecycle stage IDs and keys in `0004_grows_plants_lifecycle.py`.
- Consumers: repositories in Tasks 3–6.

- [ ] **Step 1: Write failing migration tests**

```python
async def test_0004_creates_tables_and_seeded_stages(migrated_database: Path) -> None:
    async with aiosqlite.connect(migrated_database) as connection:
        tables = {row[0] for row in await connection.execute_fetchall("SELECT name FROM sqlite_master WHERE type='table'")}
        stages = await connection.execute_fetchall(
            "SELECT key, label, position, enabled, built_in FROM lifecycle_stages ORDER BY position"
        )
    assert {"breeders", "cultivars", "lifecycle_stages", "grows", "plants", "plant_stage_transitions"} <= tables
    assert [row[0] for row in stages] == [
        "seed", "germination", "seedling", "vegetative", "transition",
        "flowering", "finishing", "harvest", "drying", "curing", "completed",
    ]


def test_0004_downgrade_returns_to_0003(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0004")
    command.downgrade(alembic_config, "0003")
    assert current_revision(alembic_config) == "0003"
```

Include a second downgrade test that inserts one complete Grow/Plant/transition graph before downgrading.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `uv run pytest backend/tests/test_grows_plants_migration.py -q`
Expected: FAIL because revision `0004` does not exist.

- [ ] **Step 3: Add the migration and ORM models**

Implement foreign keys and constraints exactly as the design specifies. Use deterministic UUID strings for the eleven built-in stages, for example:

```python
DEFAULT_STAGES = (
    ("10000000-0000-4000-8000-000000000001", "seed", "Seed", 0),
    ("10000000-0000-4000-8000-000000000002", "germination", "Germination", 1),
    # Continue contiguously through Completed at position 10.
)
```

Add case-folded query indexes, date checks, status checks, transition ordering index
`(plant_id, effective_at, created_at)`, and `ondelete="RESTRICT"` for historical
parents. Do not rely on a nullable SQLite unique constraint for breeder-less
cultivars; Task 3 enforces that identity in the service.

- [ ] **Step 4: Run migration, model, and baseline tests**

Run:

```bash
uv run pytest backend/tests/test_grows_plants_migration.py backend/tests/test_migrations.py backend/tests/test_database.py -q
uv run ruff check backend/alembic/versions/0004_grows_plants_lifecycle.py backend/cultivation_assistant/db/models.py
uv run mypy backend/cultivation_assistant/db/models.py
```

Expected: all focused tests and analyzers pass.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/alembic/versions/0004_grows_plants_lifecycle.py backend/cultivation_assistant/db/models.py backend/tests/test_grows_plants_migration.py backend/tests/test_migrations.py
git commit -m "feat: add grows and plants schema"
```

---

### Task 3: Minimal Breeder and Cultivar API

**Files:**

- Create: `backend/cultivation_assistant/library/__init__.py`
- Create: `backend/cultivation_assistant/library/schemas.py`
- Create: `backend/cultivation_assistant/library/repository.py`
- Create: `backend/cultivation_assistant/library/service.py`
- Create: `backend/cultivation_assistant/library/router.py`
- Modify: `backend/cultivation_assistant/main.py`
- Create: `backend/tests/test_cultivar_api.py`

**Interfaces:**

- Produces `BreederCreate`, `BreederUpdate`, `BreederResponse`, `CultivarCreate`, `CultivarUpdate`, `CultivarResponse`, and list envelopes.
- Produces REST routes `/api/v1/breeders` and `/api/v1/cultivars`.
- Produces `LibraryRepository.get_active_cultivar(cultivar_id: str) -> Cultivar | None` for Task 6.

- [ ] **Step 1: Write failing API tests**

```python
async def test_create_cultivar_without_breeder(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Mystery Cut", "breeder_id": None, "seed_type": "unknown"},
    )
    assert response.status_code == 201
    assert response.json()["breeder"] is None


async def test_duplicate_breederless_cultivar_is_conflict(api_client: AsyncClient) -> None:
    payload = {"name": "Mystery Cut", "breeder_id": None, "seed_type": "unknown"}
    assert (await api_client.post("/api/v1/cultivars", json=payload)).status_code == 201
    assert (await api_client.post("/api/v1/cultivars", json=payload)).status_code == 409
```

Also test optional breeder creation, case-insensitive uniqueness, inactive filtering,
reactivation conflict, trimmed values, `404`, audit rows, and rollback.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `uv run pytest backend/tests/test_cultivar_api.py -q`
Expected: FAIL with `404` for the new routes.

- [ ] **Step 3: Implement contracts, repository, service, and router**

Use Pydantic `StrEnum` values from Task 1. Keep transaction policy in the service:

```python
class CultivarCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    breeder_id: str | None = None
    seed_type: SeedType = SeedType.UNKNOWN


async def create_cultivar(self, request: CultivarCreate, correlation_id: str) -> CultivarResponse:
    async with self._database.transaction() as session:
        repository = LibraryRepository(session)
        if request.breeder_id is not None and await repository.get_breeder(request.breeder_id) is None:
            raise LibraryNotFound("Breeder was not found")
        if await repository.cultivar_identity_exists(request.breeder_id, request.name, request.seed_type):
            raise LibraryConflict("This cultivar identity already exists")
        record = await repository.add_cultivar(request)
        session.add(audit_record("cultivar.created", record.id, correlation_id))
        await session.flush()
        return cultivar_response(record)
```

Return nested compact breeder identity in cultivar responses. Map domain failures to
existing stable HTTP errors and mount the router from `create_app`.

- [ ] **Step 4: Run focused and foundation tests**

Run:

```bash
uv run pytest backend/tests/test_cultivar_api.py backend/tests/test_http_foundation.py backend/tests/test_diagnostics.py -q
uv run ruff check backend/cultivation_assistant/library backend/tests/test_cultivar_api.py
uv run mypy backend/cultivation_assistant/library
```

Expected: all checks pass.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/library backend/cultivation_assistant/main.py backend/tests/test_cultivar_api.py
git commit -m "feat: add minimal cultivar library"
```

---

### Task 4: Customizable Lifecycle Stage API

**Files:**

- Create: `backend/cultivation_assistant/lifecycle/schemas.py`
- Create: `backend/cultivation_assistant/lifecycle/repository.py`
- Create: `backend/cultivation_assistant/lifecycle/service.py`
- Create: `backend/cultivation_assistant/lifecycle/router.py`
- Modify: `backend/cultivation_assistant/main.py`
- Create: `backend/tests/test_lifecycle_stage_api.py`

**Interfaces:**

- Produces `LifecycleStageResponse`, `LifecycleStageCreate`, `LifecycleStageUpdate`, and `LifecycleStageOrderUpdate`.
- Produces `/api/v1/lifecycle-stages` CRUD and `/api/v1/lifecycle-stages/order`.
- Produces `LifecycleRepository.enabled_order() -> list[LifecycleStage]` for Task 6.

- [ ] **Step 1: Write failing stage customization tests**

```python
async def test_reorder_requires_complete_unique_stage_list(api_client: AsyncClient) -> None:
    stages = (await api_client.get("/api/v1/lifecycle-stages?include_disabled=true")).json()["items"]
    response = await api_client.put(
        "/api/v1/lifecycle-stages/order",
        json={"stage_ids": [stages[1]["id"], stages[0]["id"], *[item["id"] for item in stages[2:]]]},
    )
    assert response.status_code == 200
    assert [item["position"] for item in response.json()["items"]] == list(range(len(stages)))


async def test_referenced_custom_stage_can_only_be_disabled(api_client_with_plant: AsyncClient) -> None:
    stage_id = await create_referenced_custom_stage(api_client_with_plant)
    response = await api_client_with_plant.delete(f"/api/v1/lifecycle-stages/{stage_id}")
    assert response.status_code == 409
```

Also test rename, duplicate key/label policy, disabling built-ins, deleting unreferenced
custom stages, disabled-history readability, incomplete order rollback, and audits.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_lifecycle_stage_api.py -q`
Expected: FAIL because lifecycle stage routes are not mounted.

- [ ] **Step 3: Implement stage contracts and atomic service operations**

`LifecycleStageCreate` accepts a stable lowercase `key`, a user-facing `label`,
and `enabled`; it rejects keys used by built-in or custom stages. Use a complete
order contract:

```python
class LifecycleStageOrderUpdate(BaseModel):
    stage_ids: list[str] = Field(min_length=1)

    @field_validator("stage_ids")
    @classmethod
    def unique_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Lifecycle stage order contains duplicate IDs")
        return value
```

The service compares the submitted set with all persisted stage IDs, updates every
position in one transaction, and writes one bounded `lifecycle_stage.reordered`
audit row. Reject deletion when `built_in` is true or a Plant/transition references
the stage.

- [ ] **Step 4: Run focused checks**

Run:

```bash
uv run pytest backend/tests/test_lifecycle_stage_api.py backend/tests/test_cultivar_api.py -q
uv run ruff check backend/cultivation_assistant/lifecycle backend/tests/test_lifecycle_stage_api.py
uv run mypy backend/cultivation_assistant/lifecycle
```

Expected: all pass.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/lifecycle backend/cultivation_assistant/main.py backend/tests/test_lifecycle_stage_api.py
git commit -m "feat: add customizable lifecycle stages"
```

---

### Task 5: Grow Records and API

**Files:**

- Create: `backend/cultivation_assistant/grows/__init__.py`
- Create: `backend/cultivation_assistant/grows/schemas.py`
- Create: `backend/cultivation_assistant/grows/repository.py`
- Create: `backend/cultivation_assistant/grows/service.py`
- Create: `backend/cultivation_assistant/grows/router.py`
- Modify: `backend/cultivation_assistant/main.py`
- Create: `backend/tests/test_grow_api.py`

**Interfaces:**

- Produces Grow list/create/get/patch/archive endpoints and `GrowRepository.get(grow_id)`.
- `GrowSummary` includes `plant_count` and compact status counts.
- Consumers: Plant service and frontend Tasks 6–9.

- [ ] **Step 1: Write failing Grow behavior tests**

```python
async def test_multiple_active_grows_can_share_one_space(api_client: AsyncClient, grow_space_id: str) -> None:
    for name in ("Summer run", "Mother stock"):
        response = await api_client.post(
            "/api/v1/grows",
            json={"grow_space_id": grow_space_id, "name": name, "status": "active", "start_date": "2026-07-23"},
        )
        assert response.status_code == 201


async def test_restore_rechecks_name_uniqueness(api_client: AsyncClient, grow_space_id: str) -> None:
    archived_id = await create_archived_grow(api_client, grow_space_id, "Summer run")
    await create_active_grow(api_client, grow_space_id, "Summer run")
    response = await api_client.patch(f"/api/v1/grows/{archived_id}", json={"status": "active", "start_date": "2026-07-23"})
    assert response.status_code == 409
```

Also test date rules, inactive Grow Space warning metadata, filters, status counts,
archive idempotence, restore, `404`, audit rollback, and HA-disconnected operation.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest backend/tests/test_grow_api.py -q`
Expected: FAIL with `404` for `/api/v1/grows`.

- [ ] **Step 3: Implement Grow vertical slice**

Define contracts using `date` and `GrowStatus`:

```python
class GrowCreate(BaseModel):
    grow_space_id: str
    name: str = Field(min_length=1, max_length=120)
    status: GrowStatus = GrowStatus.PLANNED
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def validate_dates(self) -> Self:
        if self.status in {GrowStatus.ACTIVE, GrowStatus.COMPLETED} and self.start_date is None:
            raise ValueError("Start date is required for active or completed Grows")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date cannot precede start date")
        return self
```

Implement case-insensitive non-archived uniqueness within one Grow Space. Preserve
archived records and use DELETE only as an archive compatibility operation.

- [ ] **Step 4: Run focused checks**

Run:

```bash
uv run pytest backend/tests/test_grow_api.py backend/tests/test_grow_space_api.py -q
uv run ruff check backend/cultivation_assistant/grows backend/tests/test_grow_api.py
uv run mypy backend/cultivation_assistant/grows
```

Expected: all pass.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/grows backend/cultivation_assistant/main.py backend/tests/test_grow_api.py
git commit -m "feat: add first-class grow records"
```

---

### Task 6: Plant Records and Append-Only Stage Transitions

**Files:**

- Create: `backend/cultivation_assistant/plants/__init__.py`
- Create: `backend/cultivation_assistant/plants/schemas.py`
- Create: `backend/cultivation_assistant/plants/repository.py`
- Create: `backend/cultivation_assistant/plants/service.py`
- Create: `backend/cultivation_assistant/plants/router.py`
- Modify: `backend/cultivation_assistant/main.py`
- Create: `backend/tests/test_plant_api.py`
- Create: `backend/tests/test_plant_stage_transition_api.py`

**Interfaces:**

- Produces Plant list/create/get/patch/archive endpoints.
- Produces `POST /api/v1/plants/{plant_id}/stage-transitions`.
- `PlantResponse` contains nested compact Grow, Grow Space, cultivar/breeder, current stage, and ordered transitions.
- `PlantStageTransitionResult` contains the created `transition` and refreshed `plant` projection.
- Consumers: frontend Tasks 7–9.

- [ ] **Step 1: Write failing Plant creation tests**

```python
async def test_create_plant_atomically_adds_initial_transition(api_client: AsyncClient, plant_payload: dict[str, object]) -> None:
    response = await api_client.post("/api/v1/plants", json=plant_payload)
    assert response.status_code == 201
    plant = response.json()
    assert plant["current_stage"]["key"] == "seedling"
    assert len(plant["stage_transitions"]) == 1
    assert plant["stage_transitions"][0]["from_stage_id"] is None


async def test_clone_rejects_seed_type(api_client: AsyncClient, plant_payload: dict[str, object]) -> None:
    plant_payload.update({"propagation_source": "clone", "seed_type": "feminized"})
    response = await api_client.post("/api/v1/plants", json=plant_payload)
    assert response.status_code == 422
```

Also test required active cultivar, inactive cultivar rejection, name uniqueness,
status/date/harvest rules, filters, archive/restore, and transaction rollback.

- [ ] **Step 2: Run Plant tests and verify RED**

Run: `uv run pytest backend/tests/test_plant_api.py -q`
Expected: FAIL because Plant routes do not exist.

- [ ] **Step 3: Implement Plant contracts and CRUD**

Use explicit initial transition fields:

```python
class PlantCreate(BaseModel):
    grow_id: str
    cultivar_id: str
    name: str = Field(min_length=1, max_length=120)
    propagation_source: PropagationSource
    seed_type: SeedType | None = None
    start_date: date | None = None
    current_stage_id: str
    status: PlantStatus = PlantStatus.PLANNED
    container: str | None = None
    medium: str | None = None
    location: str | None = None
    expected_harvest_start: date | None = None
    expected_harvest_end: date | None = None
    actual_harvest_date: date | None = None
    notes: str | None = None
```

Plant creation must insert Plant, initial `user_confirmed` transition, and audit row
inside one `Database.transaction()`.

- [ ] **Step 4: Write failing transition tests**

```python
async def test_skipped_transition_requires_confirmation(api_client: AsyncClient, plant_id: str, flowering_id: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{plant_id}/stage-transitions",
        json={"to_stage_id": flowering_id, "effective_at": "2026-07-23T10:00:00Z", "confirmed": False},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "transition_confirmation_required"


async def test_backdated_transition_preserves_later_current_stage(api_client: AsyncClient, flowering_plant_id: str, vegetative_id: str) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{flowering_plant_id}/stage-transitions",
        json={"to_stage_id": vegetative_id, "effective_at": "2026-06-01T10:00:00Z", "confirmed": True, "notes": "Imported earlier record"},
    )
    assert response.status_code == 201
    assert response.json()["plant"]["current_stage"]["key"] == "flowering"
```

Also assert disabled-stage rejection, adjacent movement without confirmation,
backward source `user_adjusted`, append-only history, deterministic tie-breaking,
and audit rollback.

- [ ] **Step 5: Implement transition service and run all Plant tests**

Construct `TransitionOrder` values from every persisted transition, call
`ordered_current_stage`, update the projection, and never expose patch/delete
routes for transition rows.

Run:

```bash
uv run pytest backend/tests/test_plant_api.py backend/tests/test_plant_stage_transition_api.py -q
uv run ruff check backend/cultivation_assistant/plants backend/tests/test_plant_api.py backend/tests/test_plant_stage_transition_api.py
uv run mypy backend/cultivation_assistant/plants
```

Expected: all pass.

- [ ] **Step 6: Run the complete backend suite and checkpoint**

Run: `uv run pytest backend/tests -q`
Expected: complete backend suite passes.

```bash
git add backend/cultivation_assistant/plants backend/cultivation_assistant/main.py backend/tests/test_plant_api.py backend/tests/test_plant_stage_transition_api.py
git commit -m "feat: add plants and lifecycle transitions"
```

---

### Task 7: Typed Frontend Clients and Draft Rules

**Files:**

- Create: `frontend/src/api/library.ts`
- Create: `frontend/src/api/lifecycle.ts`
- Create: `frontend/src/api/grows.ts`
- Create: `frontend/src/api/plants.ts`
- Create: `frontend/src/api/library.test.ts`
- Create: `frontend/src/api/lifecycle.test.ts`
- Create: `frontend/src/api/grows.test.ts`
- Create: `frontend/src/api/plants.test.ts`
- Create: `frontend/src/features/plants/types.ts`
- Create: `frontend/src/features/plants/drafts.ts`
- Create: `frontend/src/features/plants/drafts.test.ts`

**Interfaces:**

- Produces Zod-validated API types and TanStack Query hooks for all new routes.
- Produces `plantToDuplicateDraft(plant: Plant): PlantDraft` that carries safe defaults and no history.
- Consumers: Tasks 8–9.

- [ ] **Step 1: Write failing Ingress-relative client tests**

```typescript
it("creates a Plant through an Ingress-relative URL", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(plantFixture));
  await createPlant(plantInputFixture, fetcher);
  expect(fetcher).toHaveBeenCalledWith(
    "api/v1/plants",
    expect.objectContaining({ method: "POST" }),
  );
});

it("submits explicit transition confirmation", async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse(transitionFixture, 201));
  await transitionPlantStage("plant-1", { to_stage_id: "stage-2", effective_at: "2026-07-23T10:00:00Z", confirmed: true }, fetcher);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ confirmed: true });
});
```

- [ ] **Step 2: Run client tests and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/api/library.test.ts src/api/lifecycle.test.ts src/api/grows.test.ts src/api/plants.test.ts`
Expected: FAIL because the client modules do not exist.

- [ ] **Step 3: Implement Zod contracts, functions, keys, and hooks**

Use separate query-key roots:

```typescript
export const plantKeys = {
  all: ["plants"] as const,
  list: (filters: PlantFilters) => ["plants", "list", filters] as const,
  detail: (id: string) => ["plants", "detail", id] as const,
};
```

Every mutation updates or invalidates the Plant detail, Plant lists, parent Grow
detail, and Grow lists as appropriate. Reuse one exported `ApiError` and response
parser rather than cloning inconsistent error handling from `growSpaces.ts`;
move those shared utilities to `frontend/src/api/client.ts` with existing tests
kept green.

- [ ] **Step 4: Write the failing duplicate-draft test**

```typescript
it("prefills cultivation identity but clears lifecycle history", () => {
  const draft = plantToDuplicateDraft(plantFixture);
  expect(draft.growId).toBe("grow-1");
  expect(draft.cultivarId).toBe("cultivar-1");
  expect(draft.name).toBe("North 1 copy");
  expect(draft.startDate).toBe("");
  expect(draft.status).toBe("planned");
  expect(draft.currentStageId).toBe("stage-current");
  expect(draft.actualHarvestDate).toBe("");
  expect(draft.notes).toBe("");
  expect("stageTransitions" in draft).toBe(false);
});
```

- [ ] **Step 5: Implement draft conversion and run frontend unit tests**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/api src/features/plants/drafts.test.ts
pnpm --filter cultivation-assistant-frontend lint
```

Expected: tests and lint pass.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/src/api frontend/src/features/plants/types.ts frontend/src/features/plants/drafts.ts frontend/src/features/plants/drafts.test.ts
git commit -m "feat: add typed grow and plant clients"
```

---

### Task 8: Grows and Plants Register

**Files:**

- Create: `frontend/src/routes/PlantsPage.tsx`
- Create: `frontend/src/routes/PlantsPage.test.tsx`
- Create: `frontend/src/features/grows/GrowForm.tsx`
- Create: `frontend/src/features/grows/GrowForm.test.tsx`
- Create: `frontend/src/routes/GrowDetailPage.tsx`
- Create: `frontend/src/routes/GrowDetailPage.test.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Replaces the `/plants` placeholder with `PlantsPage`.
- Adds `/grows/$growId` routed to `GrowDetailPage`.
- Produces reusable `GrowForm` for creation and editing.
- Consumer: Task 9 links Plant creation and details into these routes.

- [ ] **Step 1: Write failing register state tests**

```tsx
it("groups active Grows by Grow Space and exposes Plant counts", async () => {
  renderRoute(<PlantsPage />, queryClientWith(growListFixture));
  expect(await screen.findByRole("heading", { name: "North tent" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Summer run" })).toBeVisible();
  expect(screen.getByText("3 active plants")).toBeVisible();
});

it("offers a recovery action when Grows fail to load", async () => {
  renderRoute(<PlantsPage />, queryClientWithError("Register unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Register unavailable");
  expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();
});
```

Cover loading, empty, filtered-empty, archived inclusion, status filters, and
keyboard navigation.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/routes/PlantsPage.test.tsx`
Expected: FAIL because `PlantsPage` does not exist.

- [ ] **Step 3: Implement the register and routes**

Build Grow cards grouped by Grow Space with status text, dates, Plant counts, and
stage distribution. Do not encode status by color alone. Keep all list controls
usable at narrow widths.

- [ ] **Step 4: Write failing Grow form/detail tests**

```tsx
it("requires a start date for an active Grow", async () => {
  const user = userEvent.setup();
  render(<GrowForm mode="create" value={activeDraftWithoutDate} onChange={vi.fn()} onSubmit={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /create grow/i }));
  expect(screen.getByRole("alert")).toHaveTextContent(/start date is required/i);
});
```

Also test creation, editing, inactive-space warning, archived restoration, and the
Grow detail Plant empty state.

- [ ] **Step 5: Implement Grow form/detail and run route tests**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grows src/routes/PlantsPage.test.tsx src/routes/GrowDetailPage.test.tsx
pnpm --filter cultivation-assistant-frontend lint
```

Expected: tests and lint pass.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/src/routes/PlantsPage.tsx frontend/src/routes/PlantsPage.test.tsx frontend/src/routes/GrowDetailPage.tsx frontend/src/routes/GrowDetailPage.test.tsx frontend/src/features/grows frontend/src/app/App.tsx frontend/src/styles.css
git commit -m "feat: add grows and plants register"
```

---

### Task 9: Plant Form, Detail, Duplication, Transitions, and Stage Settings

**Files:**

- Create: `frontend/src/features/plants/PlantForm.tsx`
- Create: `frontend/src/features/plants/PlantForm.test.tsx`
- Create: `frontend/src/features/plants/CultivarCombobox.tsx`
- Create: `frontend/src/features/plants/CultivarCombobox.test.tsx`
- Create: `frontend/src/features/plants/StageTransitionDialog.tsx`
- Create: `frontend/src/features/plants/StageTransitionDialog.test.tsx`
- Create: `frontend/src/routes/PlantDetailPage.tsx`
- Create: `frontend/src/routes/PlantDetailPage.test.tsx`
- Create: `frontend/src/features/lifecycle/LifecycleStageSettings.tsx`
- Create: `frontend/src/features/lifecycle/LifecycleStageSettings.test.tsx`
- Modify: `frontend/src/routes/SettingsPage.tsx`
- Modify: `frontend/src/routes/GrowDetailPage.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Adds `/plants/$plantId` and the complete Plant workflow.
- Reuses ordinary `createPlant` for duplicate submission.
- Adds accessible keyboard stage ordering under Settings.

- [ ] **Step 1: Write failing Plant form tests**

```tsx
it("creates a minimal cultivar without requiring a breeder", async () => {
  const user = userEvent.setup();
  renderPlantForm();
  await user.click(screen.getByRole("button", { name: /add cultivar/i }));
  await user.type(screen.getByLabelText(/cultivar name/i), "Mystery Cut");
  await user.click(screen.getByRole("button", { name: /save cultivar/i }));
  expect(createCultivar).toHaveBeenCalledWith(expect.objectContaining({ name: "Mystery Cut", breeder_id: null }));
});

it("hides seed type for clones", async () => {
  const user = userEvent.setup();
  renderPlantForm();
  await user.selectOptions(screen.getByLabelText(/source/i), "clone");
  expect(screen.queryByLabelText(/seed type/i)).not.toBeInTheDocument();
});
```

Also test required cultivar, enabled initial stages, date/status rules, retained
values after API failure, edit behavior, and inactive existing selections.

- [ ] **Step 2: Run form tests and verify RED**

Run: `pnpm --filter cultivation-assistant-frontend test -- src/features/plants/PlantForm.test.tsx src/features/plants/CultivarCombobox.test.tsx`
Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement Plant form and cultivar quick-create**

Use an accessible combobox/listbox pattern, not a non-semantic custom div menu.
Submit cultivar creation first, set the returned ID, then submit Plant creation.

- [ ] **Step 4: Write failing detail, duplicate, and transition tests**

```tsx
it("requires confirmation for a backward stage change", async () => {
  const user = userEvent.setup();
  renderTransitionDialog({ current: "flowering", target: "vegetative" });
  expect(screen.getByText(/does not erase history/i)).toBeVisible();
  await user.click(screen.getByRole("button", { name: /confirm stage change/i }));
  expect(transitionPlantStage).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
});

it("opens Duplicate as a reviewed new-Plant form", async () => {
  const user = userEvent.setup();
  renderPlantDetail();
  await user.click(screen.getByRole("button", { name: /duplicate/i }));
  expect(screen.getByLabelText(/plant name/i)).toHaveValue("North 1 copy");
  expect(screen.getByLabelText(/start date/i)).toHaveValue("");
});
```

Also test append-only history rendering, planned versus actual labels, backdated
time submission, archive/restore, and failed transition retention.

- [ ] **Step 5: Implement Plant detail, transition dialog, and duplicate flow**

Display transition history ordered newest first visually while retaining semantic
list markup and explicit effective/recorded timestamps. Keep backend confirmation
errors recoverable even if stage ordering changed after the dialog opened.

- [ ] **Step 6: Write failing lifecycle settings tests**

```tsx
it("keyboard-reorders stages and submits the complete order", async () => {
  const user = userEvent.setup();
  renderLifecycleSettings();
  screen.getByRole("button", { name: /move seedling up/i }).focus();
  await user.keyboard("{Enter}");
  expect(updateLifecycleStageOrder).toHaveBeenCalledWith(expect.arrayContaining(allStageIds));
});

it("explains that disabling preserves history", () => {
  renderLifecycleSettings();
  expect(screen.getByText(/existing history is preserved/i)).toBeVisible();
});
```

- [ ] **Step 7: Implement settings, routes, styles, and run frontend suite**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test
pnpm --filter cultivation-assistant-frontend lint
pnpm --filter cultivation-assistant-frontend build
```

Expected: complete frontend suite, lint, and production build pass.

- [ ] **Step 8: Checkpoint**

```bash
git add frontend/src/features/plants frontend/src/features/lifecycle frontend/src/routes/PlantDetailPage.tsx frontend/src/routes/PlantDetailPage.test.tsx frontend/src/routes/GrowDetailPage.tsx frontend/src/routes/SettingsPage.tsx frontend/src/app/App.tsx frontend/src/styles.css
git commit -m "feat: add plant lifecycle interface"
```

---

### Task 10: OpenAPI, Version `0.3.0`, Packaging, Verification, and Publication

**Files:**

- Modify: `backend/tests/test_health.py`
- Modify: `backend/tests/test_diagnostics.py`
- Modify: `custom_components/tests/test_manifest.py`
- Modify: `backend/cultivation_assistant/__init__.py`
- Modify: `custom_components/cultivation_assistant/manifest.json`
- Modify: `package.json`
- Modify: `frontend/package.json`
- Modify: `pyproject.toml`
- Modify: `uv.lock`
- Modify: `cultivation/config.yaml`
- Modify: `cultivation/CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/openapi.json`
- Modify: synchronized files under `cultivation/app/`
- Test: `backend/tests/test_app_packaging.py`

**Interfaces:**

- Produces migration head `0004`, release `0.3.0`, synchronized source/add-on context, and publication evidence.

- [ ] **Step 1: Change version expectations first and verify RED**

Update health, diagnostics, manifest, and packaging tests to expect `0.3.0`.

Run:

```bash
uv run pytest backend/tests/test_health.py backend/tests/test_diagnostics.py custom_components/tests/test_manifest.py backend/tests/test_app_packaging.py -q
```

Expected: FAIL showing actual `0.2.1` versus expected `0.3.0`.

- [ ] **Step 2: Synchronize all version metadata and release notes**

Change every active `0.2.1` release location to `0.3.0`, regenerate `uv.lock`, and add
a `0.3.0` changelog section describing Grows, cultivars, Plants, lifecycle stages,
and append-only transitions. Preserve the historical `0.2.1` section.

Run:

```bash
uv lock
pnpm install --lockfile-only
uv run pytest backend/tests/test_health.py backend/tests/test_diagnostics.py custom_components/tests/test_manifest.py backend/tests/test_app_packaging.py -q
```

Expected: targeted tests pass.

- [ ] **Step 3: Export OpenAPI and synchronize add-on context**

Run:

```bash
pnpm openapi:export
pnpm sync:addon
```

Confirm the exported schema includes Grow, Plant, cultivar, lifecycle-stage, and
stage-transition routes and reports application version `0.3.0`.

- [ ] **Step 4: Run proactive diagnostics and full verification**

Run LSP diagnostics on edited Python and TypeScript directories, then:

```bash
pnpm verify
```

Expected: ESLint, Ruff, mypy, all Vitest tests, all pytest tests, TypeScript, and
Vite production build pass with no warnings promoted to errors. Record exact test
counts for the PR.

- [ ] **Step 5: Run migration and ASGI smoke tests**

Create two temporary databases:

1. Fresh `0001` → `0004` migration.
2. Existing `0003` database with Grow Spaces and mappings → `0004`.

For each, start the ASGI app and verify:

```text
GET /api/v1/health                         200, version 0.3.0
GET /api/v1/readiness                      503 without Home Assistant
GET /api/v1/lifecycle-stages               200, eleven defaults
POST /api/v1/cultivars                     201 with null breeder
POST /api/v1/grows                         201
POST /api/v1/plants                        201 with one initial transition
POST /api/v1/plants/{id}/stage-transitions 201
GET /                                      200 frontend
schema revision                            0004
```

Confirm pre-existing Grow Spaces and mappings remain unchanged.

- [ ] **Step 6: Build and smoke-test containers**

Run:

```bash
pnpm docker:build
```

Smoke-test degraded mode and authenticated mock Home Assistant REST/WebSocket mode.
In both modes verify schema `0004`, frontend `200`, process restart count `0`, and
no traceback, `ValueError`, or critical log entry. In authenticated mode verify
readiness `200`; in degraded mode expect readiness `503` while local Grow/Plant
APIs remain usable.

- [ ] **Step 7: Synchronize to the Git-backed branch and build the committed archive**

Copy only reviewed source and packaging files into the publication clone. Inspect
`git diff --check`, `git status --short`, and the complete diff before committing.
Do not overwrite the clone wholesale without checking for source drift.

```bash
git add cultivation-assistant
git commit -m "feat: add grows and plant lifecycle tracking"
git archive HEAD cultivation-assistant | tar -x -C ../committed-build-check
docker build -t cultivation-assistant:0.3.0-repo-check ../committed-build-check/cultivation-assistant
```

Expected: archive build succeeds from the exact committed tree. Create or empty
`../committed-build-check` before extracting so stale files cannot influence the
build.

- [ ] **Step 8: Push and publish**

Push the feature branch and open a pull request against `main`. The PR body must
include version `0.3.0`, migration `0004`, exact test counts, fresh/upgrade smoke
evidence, both container modes, committed-archive image evidence, and the explicit
statement that live Home Assistant Supervisor installation remains unverified.

- [ ] **Step 9: Final checkpoint**

```bash
git status --short
git log -1 --oneline
```

Expected: clean branch at the published commit.
