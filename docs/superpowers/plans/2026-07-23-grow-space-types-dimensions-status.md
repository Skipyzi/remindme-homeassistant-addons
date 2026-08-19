# Grow Space Types, Dimensions, and Status Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace misleading Grow Space types and direct area/volume entry with four physical-space types, editable dimensions with calculated measurements, and reversible Active/Inactive status.

**Architecture:** Add a focused canonical-dimension module, migration `0003`, and dimension columns while retaining derived area and volume for queries and display. Reuse one typed details form for creation and editing, keep legacy type values readable until changed, and treat `active` as a reversible audited status rather than one-way archival.

**Tech Stack:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic, SQLite, React, TypeScript, Zod, TanStack Query, Vitest, Testing Library, pnpm, uv, Docker.

## Global Constraints

- Use test-driven development for every behavior-bearing change.
- Use `Decimal` for backend dimension conversion and derived measurements.
- New/edited types are exactly `tent`, `greenhouse`, `outdoor`, and `room`.
- User-facing labels are exactly Indoor Tent, Greenhouse, Outdoor, and Room.
- Length and width are required; height is required except for Outdoor.
- The shared display unit is exactly `cm` or `in`.
- Existing `cabinet`, `hydroponic_system`, and `other` values remain readable until changed.
- Home Assistant remains authoritative for physical equipment safety.
- Requests remain Home Assistant Ingress-relative.
- Use pnpm rather than npm.
- The source workspace has no Git metadata. Execute checkpoint commits only in a Git-backed clone; otherwise record the checkpoint and publish through the target add-on repository in Task 8.

---

### Task 1: Canonical Dimension Conversion and Calculation

**Files:**

- Create: `backend/cultivation_assistant/grow_spaces/dimensions.py`
- Create: `backend/tests/test_grow_space_dimensions.py`
- Modify: `backend/cultivation_assistant/grow_spaces/__init__.py`

**Interfaces:**

- Produces: `DimensionUnit`, `CanonicalDimensions`, `to_metres`, `from_metres`, and `derive_measurements`.
- Consumers: Tasks 3 and 4 use these functions for request validation, persistence, and response serialization.

- [ ] **Step 1: Write failing conversion and calculation tests**

```python
from decimal import Decimal

import pytest

from cultivation_assistant.grow_spaces.dimensions import (
    CanonicalDimensions,
    DimensionUnit,
    derive_measurements,
    from_metres,
    to_metres,
)


def test_centimetres_convert_to_canonical_metres() -> None:
    assert to_metres(Decimal("80"), DimensionUnit.CM) == Decimal("0.8000")


def test_inches_round_trip_without_changing_physical_size() -> None:
    metres = to_metres(Decimal("80"), DimensionUnit.IN)
    assert metres == Decimal("2.0320")
    assert from_metres(metres, DimensionUnit.IN) == Decimal("80")


def test_area_and_volume_are_derived_from_canonical_dimensions() -> None:
    dimensions = CanonicalDimensions(
        length_m=Decimal("0.8000"),
        width_m=Decimal("0.8000"),
        height_m=Decimal("1.8000"),
    )
    assert derive_measurements(dimensions) == (
        Decimal("0.6400"),
        Decimal("1.1520"),
    )


def test_outdoor_dimensions_without_height_have_no_volume() -> None:
    dimensions = CanonicalDimensions(
        length_m=Decimal("2.0000"),
        width_m=Decimal("3.0000"),
        height_m=None,
    )
    assert derive_measurements(dimensions) == (Decimal("6.0000"), None)


@pytest.mark.parametrize("value", [Decimal("0"), Decimal("-1")])
def test_non_positive_dimensions_are_rejected(value: Decimal) -> None:
    with pytest.raises(ValueError, match="positive"):
        to_metres(value, DimensionUnit.CM)
```

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run: `uv run pytest backend/tests/test_grow_space_dimensions.py -q`  
Expected: FAIL because `grow_spaces.dimensions` does not exist.

- [ ] **Step 3: Implement canonical conversions and derived measurements**

```python
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from enum import StrEnum

FOUR_PLACES = Decimal("0.0001")
METRES_PER_INCH = Decimal("0.0254")


class DimensionUnit(StrEnum):
    CM = "cm"
    IN = "in"


@dataclass(frozen=True, slots=True)
class CanonicalDimensions:
    length_m: Decimal
    width_m: Decimal
    height_m: Decimal | None


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(FOUR_PLACES, rounding=ROUND_HALF_UP)


def to_metres(value: Decimal, unit: DimensionUnit) -> Decimal:
    if value <= 0:
        raise ValueError("Dimension values must be positive")
    factor = Decimal("0.01") if unit is DimensionUnit.CM else METRES_PER_INCH
    return _quantize(value * factor)


def from_metres(value: Decimal, unit: DimensionUnit) -> Decimal:
    divisor = Decimal("0.01") if unit is DimensionUnit.CM else METRES_PER_INCH
    converted = value / divisor
    return converted.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP).normalize()


def derive_measurements(
    dimensions: CanonicalDimensions,
) -> tuple[Decimal, Decimal | None]:
    area = _quantize(dimensions.length_m * dimensions.width_m)
    volume = (
        None
        if dimensions.height_m is None
        else _quantize(area * dimensions.height_m)
    )
    return area, volume
```

Export the new public symbols from `grow_spaces/__init__.py`.

- [ ] **Step 4: Run focused backend quality checks**

Run:

```bash
uv run pytest backend/tests/test_grow_space_dimensions.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces/dimensions.py backend/tests/test_grow_space_dimensions.py
uv run mypy backend/cultivation_assistant/grow_spaces/dimensions.py
```

Expected: tests pass and both analyzers report no errors.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces/dimensions.py backend/cultivation_assistant/grow_spaces/__init__.py backend/tests/test_grow_space_dimensions.py
git commit -m "feat: add canonical grow space dimensions"
```

---

### Task 2: Migration `0003` and Dimension Persistence

**Files:**

- Create: `backend/alembic/versions/0003_grow_space_dimensions.py`
- Modify: `backend/cultivation_assistant/db/models.py`
- Create: `backend/tests/test_grow_space_dimensions_migration.py`
- Modify: `backend/tests/test_grow_space_migration.py`

**Interfaces:**

- Consumes: Task 1 canonical metre representation.
- Produces: nullable `length_m`, `width_m`, `height_m`, and `dimension_unit` ORM fields.
- Consumers: Task 3 repository and service logic.

- [ ] **Step 1: Write a failing fresh-upgrade and preservation test**

Create a temporary SQLite database, upgrade to `0002`, insert one legacy row with
`space_type='cabinet'`, `area_m2=1.2`, and `volume_m3=2.4`, then upgrade to head.
Assert:

```python
assert current_revision == "0003"
assert columns >= {"length_m", "width_m", "height_m", "dimension_unit"}
assert preserved == {
    "space_type": "cabinet",
    "area_m2": 1.2,
    "volume_m3": 2.4,
    "length_m": None,
    "width_m": None,
    "height_m": None,
    "dimension_unit": None,
}
```

Add a downgrade assertion that revision `0002` no longer contains the four new columns.

- [ ] **Step 2: Run the migration test and observe revision `0003` missing**

Run: `uv run pytest backend/tests/test_grow_space_dimensions_migration.py -q`  
Expected: FAIL because migration `0003` does not exist.

- [ ] **Step 3: Add ORM fields and migration**

Add to `GrowSpace`:

```python
length_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
width_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
height_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
dimension_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(8))
```

Migration `0003` must add nullable columns and these constraints:

```python
sa.CheckConstraint("length_m IS NULL OR length_m > 0", name="ck_grow_space_length")
sa.CheckConstraint("width_m IS NULL OR width_m > 0", name="ck_grow_space_width")
sa.CheckConstraint("height_m IS NULL OR height_m > 0", name="ck_grow_space_height")
sa.CheckConstraint(
    "dimension_unit IS NULL OR dimension_unit IN ('cm', 'in')",
    name="ck_grow_space_dimension_unit",
)
```

Use Alembic batch operations so SQLite can add and remove named constraints safely. The downgrade removes constraints and columns in reverse order.

- [ ] **Step 4: Verify upgrade, downgrade, and model tests**

Run:

```bash
uv run pytest backend/tests/test_grow_space_dimensions_migration.py backend/tests/test_grow_space_migration.py backend/tests/test_database.py -q
uv run ruff check backend/alembic/versions/0003_grow_space_dimensions.py backend/cultivation_assistant/db/models.py
uv run mypy backend/cultivation_assistant/db/models.py
```

Expected: all tests pass; migration head is `0003`.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/alembic/versions/0003_grow_space_dimensions.py backend/cultivation_assistant/db/models.py backend/tests/test_grow_space_dimensions_migration.py backend/tests/test_grow_space_migration.py
git commit -m "feat: persist grow space dimensions"
```

---

### Task 3: Dimension-Aware Contracts, Repository, and Service

**Files:**

- Modify: `backend/cultivation_assistant/grow_spaces/schemas.py`
- Modify: `backend/cultivation_assistant/grow_spaces/repository.py`
- Modify: `backend/cultivation_assistant/grow_spaces/service.py`
- Modify: `backend/tests/test_grow_space_units.py`
- Modify: `backend/tests/test_grow_space_repository.py`
- Modify: `backend/tests/test_grow_space_api.py`

**Interfaces:**

- Consumes: Task 1 conversion functions and Task 2 ORM fields.
- Produces: `DimensionsInput`, `DimensionsResponse`, dimension-aware create/update responses, and derived area/volume persistence.
- Consumers: Tasks 5–7 frontend contracts and UI.

- [ ] **Step 1: Replace direct area/volume API tests with dimensions**

Add create tests for:

```python
payload = {
    "name": "Flower tent",
    "space_type": "tent",
    "dimensions": {
        "length": "80",
        "width": "80",
        "height": "180",
        "unit": "cm",
    },
    "mappings": [],
}
```

Assert the `201` response contains:

```python
assert body["dimensions"] == {
    "length": "80",
    "width": "80",
    "height": "180",
    "unit": "cm",
}
assert body["area_m2"] == "0.6400"
assert body["volume_m3"] == "1.1520"
```

Add tests that:

- `outdoor` accepts `height: null` and returns `volume_m3: null`.
- `tent`, `greenhouse`, and `room` reject `height: null` with `422`.
- missing length or width returns `422`.
- `cabinet`, `hydroponic_system`, and `other` return `422` on create.
- an existing legacy record serializes with `dimensions: null` and retained area/volume.

- [ ] **Step 2: Run the API tests and observe old contract behavior**

Run: `uv run pytest backend/tests/test_grow_space_api.py -q`  
Expected: FAIL because create still expects `area` and `volume` and responses omit dimensions.

- [ ] **Step 3: Define exact Pydantic contracts**

Replace the type enum with:

```python
class GrowSpaceType(StrEnum):
    TENT = "tent"
    GREENHOUSE = "greenhouse"
    OUTDOOR = "outdoor"
    ROOM = "room"
```

Define:

```python
class DimensionsInput(BaseModel):
    length: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    width: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    height: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    unit: DimensionUnit


class DimensionsResponse(BaseModel):
    length: Decimal
    width: Decimal
    height: Decimal | None
    unit: DimensionUnit
```

`GrowSpaceCreate` requires `dimensions`. Its model validator rejects missing height unless `space_type is GrowSpaceType.OUTDOOR`. `GrowSpaceUpdate` accepts optional `dimensions` and optional `active`; it does not force dimensions for unrelated patches.

Add `dimensions: DimensionsResponse | None` to summaries and detailed responses while retaining `area_m2` and `volume_m3`.

- [ ] **Step 4: Persist canonical dimensions and derive measurements atomically**

Update repository creation to accept canonical values:

```python
async def add(
    self,
    request: GrowSpaceCreate,
    dimensions: CanonicalDimensions,
    area_m2: Decimal,
    volume_m3: Decimal | None,
) -> GrowSpace:
```

Set all canonical fields, `dimension_unit`, `area_m2`, and `volume_m3` before flush.

In the service, convert request dimensions with `to_metres`, call `derive_measurements`, and serialize preferred-unit values with `from_metres`. For updates:

- If dimensions change, replace all canonical dimension and derived fields together.
- If type changes, validate the resulting current dimensions against the new type.
- If neither type nor dimensions changes, permit legacy records with null dimensions.
- If a legacy record changes to a current type, require a dimensions object in the same patch.

- [ ] **Step 5: Remove direct area/volume request conversion**

Delete `AreaInput`, `VolumeInput`, `normalize_area`, and `normalize_volume` from request paths and public imports. Keep environmental normalization unchanged.

- [ ] **Step 6: Verify contracts, repository behavior, and focused typing**

Run:

```bash
uv run pytest backend/tests/test_grow_space_dimensions.py backend/tests/test_grow_space_units.py backend/tests/test_grow_space_repository.py backend/tests/test_grow_space_api.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces backend/tests/test_grow_space_api.py
uv run mypy backend/cultivation_assistant/grow_spaces
```

Expected: all focused tests pass and analyzers report no errors.

- [ ] **Step 7: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces backend/tests/test_grow_space_units.py backend/tests/test_grow_space_repository.py backend/tests/test_grow_space_api.py
git commit -m "feat: derive grow space measurements from dimensions"
```

---

### Task 4: Reversible Active/Inactive Lifecycle

**Files:**

- Modify: `backend/cultivation_assistant/grow_spaces/service.py`
- Modify: `backend/cultivation_assistant/grow_spaces/router.py`
- Modify: `backend/tests/test_grow_space_api.py`
- Modify: `backend/tests/test_entity_mapping_api.py`

**Interfaces:**

- Consumes: Task 3 `GrowSpaceUpdate(active: bool | None)`.
- Produces: audited deactivation/reactivation, editable inactive records, and backward-compatible DELETE deactivation.
- Consumers: Tasks 5 and 7 update mutation and status UI.

- [ ] **Step 1: Write failing lifecycle tests**

Cover these exact transitions:

```python
inactive = await client.patch(
    f"/api/v1/grow-spaces/{space_id}", json={"active": False}
)
assert inactive.status_code == 200
assert inactive.json()["active"] is False

reactivated = await client.patch(
    f"/api/v1/grow-spaces/{space_id}", json={"active": True}
)
assert reactivated.status_code == 200
assert reactivated.json()["active"] is True
```

Assert audit actions are `grow_space.deactivated` and `grow_space.reactivated`. Add tests that:

- Inactive core details can be patched.
- Inactive mappings can be created, updated, and deleted.
- Reactivation conflicts with a duplicate active name and returns `409` without changing status.
- DELETE sets active false and writes `grow_space.deactivated`.

- [ ] **Step 2: Run lifecycle tests and observe current one-way archive failures**

Run:

```bash
uv run pytest backend/tests/test_grow_space_api.py backend/tests/test_entity_mapping_api.py -q
```

Expected: FAIL because updates and mapping changes reject inactive records and PATCH ignores `active`.

- [ ] **Step 3: Implement status transitions in the update transaction**

Remove `_require_active` from ordinary core and mapping edits. In `_apply_update`, handle `active` separately so the service can enforce name uniqueness before reactivation.

Use exact actions:

```python
if old_active and not record.active:
    action = "grow_space.deactivated"
elif not old_active and record.active:
    action = "grow_space.reactivated"
else:
    action = "grow_space.updated"
```

When reactivating, call `active_name_exists(record.name, exclude_id=record.id)` after applying a requested name and before commit. Raise `GrowSpaceConflict` on conflict.

Make DELETE idempotently set `active=False` and emit the deactivation action only when a transition occurs. Preserve the existing `204` response.

- [ ] **Step 4: Verify lifecycle and audit behavior**

Run:

```bash
uv run pytest backend/tests/test_grow_space_api.py backend/tests/test_entity_mapping_api.py -q
uv run ruff check backend/cultivation_assistant/grow_spaces
uv run mypy backend/cultivation_assistant/grow_spaces
```

Expected: all lifecycle, mapping, and audit tests pass.

- [ ] **Step 5: Checkpoint**

```bash
git add backend/cultivation_assistant/grow_spaces backend/tests/test_grow_space_api.py backend/tests/test_entity_mapping_api.py
git commit -m "feat: make grow space status reversible"
```

---

### Task 5: Typed Frontend Dimension and Update Client

**Files:**

- Create: `frontend/src/features/grow-spaces/dimensions.ts`
- Create: `frontend/src/features/grow-spaces/dimensions.test.ts`
- Modify: `frontend/src/api/growSpaces.ts`
- Modify: `frontend/src/api/growSpaces.test.ts`
- Modify: `frontend/src/features/grow-spaces/types.ts`

**Interfaces:**

- Consumes: Task 3 response and request JSON fields.
- Produces: `DimensionUnit`, `DimensionsInput`, `GrowSpaceUpdateInput`, `convertDimensionValue`, `calculateDimensionPreview`, and `useUpdateGrowSpace`.
- Consumers: Tasks 6 and 7 forms and detail page.

- [ ] **Step 1: Write failing dimension-helper tests**

```typescript
expect(convertDimensionValue("80", "cm", "in")).toBe("31.5");
expect(convertDimensionValue("31.5", "in", "cm")).toBe("80.01");
expect(
  calculateDimensionPreview({
    length: "80",
    width: "80",
    height: "180",
    unit: "cm",
  }),
).toEqual({ areaM2: "0.64", volumeM3: "1.152" });
expect(
  calculateDimensionPreview({
    length: "200",
    width: "300",
    height: "",
    unit: "cm",
  }),
).toEqual({ areaM2: "6", volumeM3: null });
```

Use deterministic trimming of trailing zeroes. Browser calculations are previews only.

- [ ] **Step 2: Write failing Zod and update-mutation tests**

Update fixtures to include:

```typescript
dimensions: {
  length: "80",
  width: "80",
  height: "180",
  unit: "cm",
},
```

Test that `updateGrowSpace("space-1", { active: false }, fetcher)` calls:

```typescript
expect(fetcher).toHaveBeenCalledWith(
  "api/v1/grow-spaces/space-1",
  expect.objectContaining({ method: "PATCH" }),
);
```

Test malformed dimensions responses are rejected.

- [ ] **Step 3: Run focused tests and observe missing helpers/contracts**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces/dimensions.test.ts src/api/growSpaces.test.ts
```

Expected: FAIL because dimension helpers and update API do not exist.

- [ ] **Step 4: Implement frontend contracts and helpers**

Use:

```typescript
export type GrowSpaceType = "tent" | "greenhouse" | "outdoor" | "room";
export type DimensionUnit = "cm" | "in";

export interface DimensionsInput {
  length: string;
  width: string;
  height: string | null;
  unit: DimensionUnit;
}

export interface GrowSpaceUpdateInput {
  name?: string;
  description?: string | null;
  location?: string | null;
  space_type?: GrowSpaceType;
  dimensions?: DimensionsInput;
  active?: boolean;
}
```

Extend Zod summaries with nullable `dimensions`. Implement `updateGrowSpace` with an Ingress-relative URL and a `useUpdateGrowSpace` mutation that invalidates list/detail keys and seeds the returned detail.

Implement preview conversion with `2.54 cm` per inch and value formatting capped at two decimal places for converted input and four decimal places for previews.

- [ ] **Step 5: Verify frontend client and helper tests**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces/dimensions.test.ts src/api/growSpaces.test.ts
pnpm --filter cultivation-assistant-frontend lint
```

Expected: tests and ESLint pass.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/src/api/growSpaces.ts frontend/src/api/growSpaces.test.ts frontend/src/features/grow-spaces/dimensions.ts frontend/src/features/grow-spaces/dimensions.test.ts frontend/src/features/grow-spaces/types.ts
git commit -m "feat: add typed grow space dimensions client"
```

---

### Task 6: Shared Details Form and Corrected Creation Wizard

**Files:**

- Create: `frontend/src/features/grow-spaces/GrowSpaceDetailsForm.tsx`
- Create: `frontend/src/features/grow-spaces/GrowSpaceDetailsForm.test.tsx`
- Modify: `frontend/src/features/grow-spaces/GrowSpaceWizard.tsx`
- Modify: `frontend/src/features/grow-spaces/GrowSpaceWizard.test.tsx`
- Modify: `frontend/src/features/grow-spaces/types.ts`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 5 dimension helpers and request types.
- Produces: reusable `GrowSpaceDetailsForm({ value, mode, onChange, errors })` used for creation and editing.
- Consumers: Task 7 detail editor.

- [ ] **Step 1: Write failing shared-form tests**

Test that the type selector exposes only:

```text
Indoor Tent
Greenhouse
Outdoor
Room
```

Assert Cabinet, Greenhouse zone, Hydroponic system, and Other are absent.

Add tests that:

- Entering `80`, `80`, `180`, `cm` displays `0.64 m²` and `1.152 m³`.
- Switching to inches converts values and retains the same preview within display precision.
- Enclosed types show Height · required.
- Outdoor shows Height · optional and permits a blank height.
- The fields use real labels and the shared unit selector has an accessible name.

- [ ] **Step 2: Run form tests and observe the missing component failure**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces/GrowSpaceDetailsForm.test.tsx
```

Expected: FAIL because `GrowSpaceDetailsForm` does not exist.

- [ ] **Step 3: Implement a controlled shared details form**

Define a draft with:

```typescript
type LegacyGrowSpaceType = "cabinet" | "hydroponic_system" | "other";

interface GrowSpaceDetailsDraft {
  name: string;
  description: string;
  location: string;
  spaceType: GrowSpaceType | LegacyGrowSpaceType;
  length: string;
  width: string;
  height: string;
  dimensionUnit: DimensionUnit;
  active: boolean;
}
```

The form renders Active/Inactive only in `mode="edit"`. On unit change, convert each non-empty dimension before updating `dimensionUnit`. Render calculated values as read-only presentation, not inputs.

- [ ] **Step 4: Write failing wizard payload and validation tests**

Update the existing creation test to parse and assert the recorded request:

```typescript
const [, request] = fetcher.mock.calls.find(
  ([url]) => url === "api/v1/grow-spaces",
) as [string, RequestInit];
expect(request.method).toBe("POST");
expect(JSON.parse(String(request.body))).toEqual(
  expect.objectContaining({
    space_type: "tent",
    dimensions: {
      length: "80",
      width: "80",
      height: "180",
      unit: "cm",
    },
  }),
);
```

Add blocked-advance tests for missing length, width, and enclosed height, plus Outdoor with blank height.

- [ ] **Step 5: Replace wizard detail fields with the shared form**

Use the form in Step 1. Change the review page to display:

```text
Indoor Tent
80 × 80 × 180 cm
Floor area 0.64 m²
Volume 1.152 m³
```

For Outdoor without height, display `200 × 300 cm` and `Volume not available`. Keep mappings optional and preserve back-navigation values.

- [ ] **Step 6: Add responsive and dark-theme styles**

Add focused rules for:

- `.dimension-input-grid`
- `.dimension-unit-field`
- `.calculated-measurements`
- `.status-segmented-control`
- `.legacy-type-notice`

At the mobile breakpoint, use two columns for dimensions and place the shared unit selector on its own row. Preserve existing focus-visible styling and reduced-motion behavior.

- [ ] **Step 7: Verify shared form and wizard**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/features/grow-spaces/GrowSpaceDetailsForm.test.tsx src/features/grow-spaces/GrowSpaceWizard.test.tsx
pnpm --filter cultivation-assistant-frontend lint
pnpm --filter cultivation-assistant-frontend build
```

Expected: focused tests, lint, type checking, and Vite build pass.

- [ ] **Step 8: Checkpoint**

```bash
git add frontend/src/features/grow-spaces frontend/src/styles.css
git commit -m "feat: collect grow space dimensions"
```

---

### Task 7: Existing-Space Editing, Legacy Types, and Inactive Register

**Files:**

- Modify: `frontend/src/routes/GrowSpaceDetailPage.tsx`
- Modify: `frontend/src/routes/GrowSpaceDetailPage.test.tsx`
- Modify: `frontend/src/routes/GrowSpacesPage.tsx`
- Modify: `frontend/src/routes/GrowSpacesPage.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 5 update hook and Task 6 shared form.
- Produces: full core-detail editing, status transitions, familiar dimension display, legacy badges, and Include inactive filtering.

- [ ] **Step 1: Write failing register tests**

Update list fixtures with dimensions. Assert cards show:

```text
80 × 80 × 180 cm
0.64 m²
1.152 m³
```

Add tests that the filter label is Include inactive, passes `include_archived=true` to the unchanged backend query parameter for compatibility, and renders Inactive rather than Archived.

Add a legacy fixture with `space_type: "cabinet"` and `dimensions: null`; assert a visible Legacy type badge and retained area/volume.

- [ ] **Step 2: Write failing detail editing tests**

Cover:

- Edit details opens the shared form prefilled from API dimensions.
- Saving name, type, location, description, dimensions, and inactive status sends a PATCH.
- A status-only patch for a legacy record omits `space_type` and `dimensions`.
- Failed update retains values and focuses the error summary.
- Outdoor without height displays Volume not available.
- Inactive mappings remain visible and editable.
- The old Archive space confirmation is absent.

- [ ] **Step 3: Run route tests and observe current read-only/archive behavior**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/routes/GrowSpacesPage.test.tsx src/routes/GrowSpaceDetailPage.test.tsx
```

Expected: FAIL because cards omit dimensions, the detail page has no editor, and inactive is still called archived.

- [ ] **Step 4: Implement dirty-field PATCH construction**

Build a helper that compares the original API record and edited draft. Send only changed fields. Rules:

- Always permit `active` alone.
- Omit legacy `space_type` when unchanged.
- Omit `dimensions` when unchanged or null legacy dimensions were not edited.
- When dimensions change, send a complete dimensions object.
- When a legacy type changes, require a current type and complete valid dimensions.

On success, close edit mode and display the updated detail. On error, keep edit mode and values.

- [ ] **Step 5: Replace archive presentation with reversible status editing**

Remove the destructive archive panel. Render Active/Inactive in the edit form and use neutral lifecycle copy:

```text
Inactive spaces remain in history, retain mappings, and can be reactivated.
```

Change list filter and badges to inactive terminology while retaining the backend query parameter until a separate API cleanup is warranted.

- [ ] **Step 6: Render dimensions and derived measurements**

Prefer dimensions when present. Legacy records with null dimensions continue to show retained area and volume and a Legacy type badge. Never infer a rectangular shape from area/volume.

- [ ] **Step 7: Verify route behavior and production build**

Run:

```bash
pnpm --filter cultivation-assistant-frontend test -- src/routes/GrowSpacesPage.test.tsx src/routes/GrowSpaceDetailPage.test.tsx
pnpm --filter cultivation-assistant-frontend lint
pnpm --filter cultivation-assistant-frontend build
```

Expected: all route tests, lint, and build pass.

- [ ] **Step 8: Checkpoint**

```bash
git add frontend/src/routes/GrowSpacesPage.tsx frontend/src/routes/GrowSpacesPage.test.tsx frontend/src/routes/GrowSpaceDetailPage.tsx frontend/src/routes/GrowSpaceDetailPage.test.tsx frontend/src/styles.css
git commit -m "feat: edit grow space details and status"
```

---

### Task 8: Contract, Documentation, Packaging, and PR Update

**Files:**

- Modify: `README.md`
- Modify: `cultivation/CHANGELOG.md`
- Modify: `backend/tests/test_app_packaging.py`
- Regenerate: `docs/openapi.json`
- Regenerate: `cultivation/app/**`
- Update remote PR: `Skipyzi/remindme-homeassistant-addons#7`

**Interfaces:**

- Consumes: Tasks 1–7.
- Produces: retained OpenAPI contract, synchronized add-on context, verified Docker images, and an updated mergeable publication PR at migration head `0003`.

- [ ] **Step 1: Extend packaging assertions before synchronization**

Add required paths and content assertions:

```python
assert Path(
    "cultivation/app/backend/alembic/versions/0003_grow_space_dimensions.py"
).is_file()
assert Path(
    "cultivation/app/backend/cultivation_assistant/grow_spaces/dimensions.py"
).is_file()
assert Path(
    "cultivation/app/frontend/src/features/grow-spaces/GrowSpaceDetailsForm.tsx"
).is_file()
```

Run `uv run pytest backend/tests/test_app_packaging.py -q` and observe failure before synchronization.

- [ ] **Step 2: Update documentation and changelog**

Document:

- Indoor Tent, Greenhouse, Outdoor, and Room
- Length × width × height with cm/in
- Outdoor optional height
- Calculated area and volume
- Full core-detail editing
- Reversible Active/Inactive status
- Legacy type preservation

Amend the existing `0.2.0` changelog because PR #7 is still unmerged; do not create a second release section.

- [ ] **Step 3: Export and inspect OpenAPI**

Run:

```bash
pnpm openapi:export
python -c "import json; d=json.load(open('docs/openapi.json')); s=d['components']['schemas']; assert 'DimensionsInput' in s; assert 'active' in s['GrowSpaceUpdate']['properties']"
```

Expected: command exits zero and retained contract includes dimensions and reversible status.

- [ ] **Step 4: Run proactive diagnostics**

Run LSP diagnostics over:

```text
backend/cultivation_assistant/grow_spaces
backend/cultivation_assistant/db/models.py
frontend/src/api/growSpaces.ts
frontend/src/features/grow-spaces
frontend/src/routes/GrowSpacesPage.tsx
frontend/src/routes/GrowSpaceDetailPage.tsx
```

Expected: zero blocking errors.

- [ ] **Step 5: Run complete repository verification**

Run: `pnpm verify`  
Expected: ESLint, Ruff, mypy, all Vitest tests, all pytest tests, TypeScript, and Vite build pass.

- [ ] **Step 6: Run a fresh migration and ASGI smoke**

Migrate an empty temporary database to head, start the ASGI app with built frontend, and assert:

```text
GET /api/v1/health -> 200
GET /api/v1/readiness -> 503 without Home Assistant
POST /api/v1/grow-spaces with 80×80×180 cm -> 201
returned area_m2 -> 0.6400
returned volume_m3 -> 1.1520
PATCH active false -> 200
PATCH active true -> 200
GET / -> 200
schema_version -> 0003
```

- [ ] **Step 7: Synchronize and build the add-on**

Run:

```bash
pnpm sync:addon
uv run pytest backend/tests/test_app_packaging.py -q
pnpm docker:build
```

Expected: packaging test and image `cultivation-assistant:dev` build pass.

- [ ] **Step 8: Repeat degraded and authenticated container smokes**

Assert:

- Degraded: health `200`, readiness `503`, schema `0003`, frontend `200`, restart count `0`.
- Authenticated mock Home Assistant: readiness `200`, discovery works, schema `0003`, restart count `0`.
- Logs contain no traceback, `ValueError`, or critical error.

- [ ] **Step 9: Update the existing publication branch and rebuild its committed archive**

In the Git-backed clone:

```bash
cd ../remindme-homeassistant-addons-grow-spaces
git checkout feat/grow-spaces-entity-mapping
git pull --ff-only
rm -rf cultivation-assistant
cp -a ../grow-addon/cultivation cultivation-assistant
git add cultivation-assistant
git diff --cached --check
git commit -m "fix: correct grow space types and dimensions"
rm -rf ../committed-build-check-grow-spaces
mkdir -p ../committed-build-check-grow-spaces
git archive HEAD cultivation-assistant | tar -x -C ../committed-build-check-grow-spaces
docker build -t cultivation-assistant:repo-check ../committed-build-check-grow-spaces/cultivation-assistant
git push
```

Expected: committed-archive build and push succeed.

- [ ] **Step 10: Update and verify PR #7**

Update the PR description with fresh test counts, migration head `0003`, both Docker builds, both container smoke modes, and the new head SHA. Verify:

```text
base = main
head = feat/grow-spaces-entity-mapping
mergeable_state = clean
changed files include migration 0003 and shared details form
```

Do not claim live Home Assistant Supervisor installation passed unless it was actually performed.
