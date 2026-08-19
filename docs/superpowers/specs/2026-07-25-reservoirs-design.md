# Reservoir Records, Tank Calibration, and Level Dashboard

Companion design document for the first Phase 2 slice, covering spec.md
section 15 (Reservoir and Tank Monitoring) minus consumption/forecast
history and guidance, which need their own follow-up slices.

## 1. Purpose

Phase 2 opens with reservoirs: physical tanks and buckets that hold
nutrient solution or water, optionally instrumented with Home
Assistant sensors for level, weight, temperature, and leak detection,
plus optional pump/valve/flow control-entity references for later
irrigation correlation. This slice gets a reservoir recorded, its tank
geometry or calibration curve entered, its sensors mapped, and its
current level and derived volume visible — the minimum useful surface
before consumption tracking or irrigation exists.

## 2. Product Decisions

* A Reservoir is a standalone record, not owned by a Grow Space. Spec
  15.3 lists "Grow-space relationships" (plural) as a reservoir field,
  which only makes full sense once Irrigation Zones (spec 16.1, a
  later slice) exist to carry the actual many-to-many wiring between
  reservoirs and the grow spaces they feed. For this slice, a
  Reservoir carries one optional `primary_grow_space_id` purely for
  default grouping in the register UI; it is not a durable relationship
  contract.
* Tank geometry supports `rectangular`, `vertical_cylinder`,
  `horizontal_cylinder`, and `custom_calibration_table` in this slice.
  `load_cell_conversion` and `flow_derived_estimate` (spec 15.4) are
  deferred — both need design decisions (a tare/density model for load
  cells; a running flow-integration ledger for flow-derived estimates)
  that are better made alongside the consumption-tracking slice where
  they'll actually be exercised, rather than half-built here.
* Sensor and control-entity mappings reuse the Grow Space entity-mapping
  *pattern* (role-based compatibility scoring against the Home Assistant
  state cache) but not its code: `grow_spaces/roles.py`,
  `grow_spaces/units.py`, and `grow_spaces/discovery.py` all import
  each other and are keyed to the environmental-role vocabulary. Forking
  a reservoir-scoped `roles.py`/`discovery.py` is less risk right now
  than extracting a shared generic framework under this slice's time
  budget; `grow_spaces/dimensions.py` is genuinely generic (no role
  coupling) and *is* reused directly for metric/imperial conversion.
* Consumption summaries, seven-day averages, refill forecasts, estimated
  cycles remaining, and "last refill" (spec 15.5) all need a history of
  readings over time, which needs a decision about how periodic
  aggregation runs (this app has no background-job runner yet). That
  decision, plus `reservoir_readings`/`reservoir_forecasts`, is the next
  slice. This slice's dashboard shows only the *current* snapshot.
* Reservoir Guidance (spec 15.6) belongs to the Phase 4 "Deterministic
  guidance engine" bullet in the delivery-phase breakdown, not Phase 2 —
  no scope decision needed here, just correct phase placement.
* Irrigation Zones and Events (spec section 16) depend on Reservoirs
  existing and are their own slice.

## 3. Scope

### Included

* `reservoirs`: CRUD with name, type, capacity, usable capacity, minimum
  safe volume, refill threshold, overflow threshold, optional primary
  Grow Space, active/inactive (reversible, same pattern as Grow Spaces
  and Grows).
* Tank geometry: rectangular (length × width × height), vertical
  cylinder (diameter × height), horizontal cylinder (diameter × length),
  or a custom calibration table.
* `reservoir_calibration_points`: ordered raw-reading → volume pairs for
  the custom-calibration-table shape, with linear interpolation between
  points and clamping at the table's extremes.
* `reservoir_entity_mappings`: role-based Home Assistant entity mappings
  covering the continuous and binary sensor types from spec 15.2, plus
  pump/fill-valve/flow control-entity references, and water temperature.
* Compatible-entity discovery per role, mirroring the Grow Space wizard's
  ranking (compatible → convertible → unknown → incompatible).
* A reservoir detail read model exposing live readings per mapping
  (current value, staleness, compatibility) and a computed current
  volume derived from whichever level-oriented role is mapped, using the
  reservoir's geometry or calibration table.
* Frontend: a Reservoirs register (list, create, edit, archive/restore)
  and a Reservoir detail page with a geometry/calibration editor, a
  mapping wizard matching the Grow Space one's shape, and a dashboard
  card showing current level, current volume, usable remaining volume,
  pump/valve/flow live state, water temperature, last sensor update, and
  data quality.

### Deferred

* `load_cell_conversion` and `flow_derived_estimate` geometry modes.
* `reservoir_readings` history, daily/seven-day consumption, refill
  forecasts, estimated cycles remaining, last refill (next slice).
* `reservoir_anomalies` and Reservoir Guidance (Phase 4).
* Irrigation Zones and Events (spec section 16, its own slice).

## 4. Domain Boundaries

* New `reservoirs` vertical slice: `schemas.py`, `repository.py`,
  `service.py`, `router.py`, plus `geometry.py` (shape-specific volume
  math and calibration-table interpolation), `roles.py` (role
  vocabulary and compatibility metadata), `units.py` (unit
  classification, same shape as `grow_spaces/units.py`), and
  `discovery.py` (entity suggestion).
* `geometry.py` imports `to_metres`/`from_metres` from
  `grow_spaces.dimensions` directly — those two functions have no
  grow-space policy in them, just unit arithmetic.
* Live entity access goes through the same `EntityStateCache` the app
  already threads into `grow_spaces` and `home_assistant`; `reservoirs`
  takes it as a constructor dependency the same way `GrowSpaceService`
  does.

## 5. Data Model

### 5.1 `reservoirs`

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | text | |
| reservoir_type | text | check-constrained: `autopot_reservoir`, `dwc_bucket`, `rdwc_control_reservoir`, `irrigation_supply_tank`, `mixing_tank`, `top_off_tank`, `ro_source_water_tank`, `runoff_waste_tank`, `custom_reservoir` |
| primary_grow_space_id | UUID, nullable | FK `grow_spaces.id`, RESTRICT |
| capacity_liters | numeric | positive |
| usable_capacity_liters | numeric, nullable | must be ≤ `capacity_liters` when set |
| minimum_safe_volume_liters | numeric, nullable | |
| refill_threshold_liters | numeric, nullable | |
| overflow_threshold_liters | numeric, nullable | |
| geometry_shape | text | check-constrained: `rectangular`, `vertical_cylinder`, `horizontal_cylinder`, `custom_calibration_table` |
| geometry_length_m / geometry_width_m / geometry_height_m / geometry_diameter_m | numeric, nullable | populated per shape; unused dimensions stay null |
| active | boolean | default true |
| created_at / updated_at | datetime (UTC) | |

Validation (service layer, mirroring Grow Space dimension rules):
`rectangular` requires length/width/height; `vertical_cylinder` requires
diameter/height; `horizontal_cylinder` requires diameter/length;
`custom_calibration_table` requires none of the geometry columns but at
least two calibration points before it can compute volume.

### 5.2 `reservoir_calibration_points`

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| reservoir_id | UUID | FK `reservoirs.id`, CASCADE |
| raw_value | numeric | the sensor's raw reading at this point |
| volume_liters | numeric | |

Unique on `(reservoir_id, raw_value)`; the service sorts by `raw_value`
before interpolating.

### 5.3 `reservoir_entity_mappings`

Same shape as `entity_mappings`, scoped to `reservoir_id` instead of
`grow_space_id`:

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| reservoir_id | UUID | FK `reservoirs.id`, CASCADE |
| entity_id | text | |
| role | text | see §6 |
| display_name | text, nullable | |
| priority | integer | default 100 |
| source_unit / normalized_unit | text, nullable | |
| enabled | boolean | default true |
| calibration | JSON, nullable | reserved, unused in this slice |
| created_at / updated_at | datetime (UTC) | |

Unique on `(reservoir_id, entity_id, role)`.

## 6. Roles

Continuous: `level_percentage`, `liquid_depth`, `distance_to_liquid`,
`weight`, `water_temperature`.

Binary: `low_level`, `empty`, `high_level`, `overflow`, `leak`.

Control (not sensors — referenced for future irrigation correlation,
read-only passthrough of current state in this slice): `pump`,
`fill_valve`, `flow`.

`pressure`, `capacitance`, `ultrasonic`, and `radar` from spec 15.2 are
sensor *technologies*, not distinct semantic roles — a capacitance or
ultrasonic sensor reporting a percentage or depth maps to
`level_percentage` or `liquid_depth` the same as any other sensor of
that device class; no separate role is needed for them.

## 7. Volume Computation

Given a reservoir's geometry/calibration and its live level-oriented
readings (in priority order: `level_percentage`, then `liquid_depth`,
then `distance_to_liquid`), compute `current_volume_liters`:

* `level_percentage` → `usable_capacity_liters (or capacity_liters) ×
  percentage`, regardless of geometry shape.
* `liquid_depth` with `rectangular` → `length_m × width_m × depth_m ×
  1000`.
* `liquid_depth` with `vertical_cylinder` → `π × (diameter_m/2)² ×
  depth_m × 1000`.
* `liquid_depth` with `horizontal_cylinder` → circular-segment area
  formula for a partially filled horizontal cylinder × length × 1000.
* `distance_to_liquid` → convert to depth as `geometry_height_m -
  distance_m` (rectangular/vertical cylinder) or the cylinder's
  diameter minus distance (horizontal), then apply the depth formulas
  above.
* `custom_calibration_table` → linear interpolation of whichever raw
  reading is mapped (percentage, depth, or distance — the table is
  keyed to whatever the user calibrated against) between the two
  nearest calibration points, clamped at the table's ends.

If no level-oriented role is mapped, or geometry data is incomplete,
`current_volume_liters` is `null` and the dashboard shows "Not
available" rather than a stale or fabricated figure.

## 8. API Design

```text
GET    /api/v1/reservoirs
POST   /api/v1/reservoirs
GET    /api/v1/reservoirs/{id}
PATCH  /api/v1/reservoirs/{id}
DELETE /api/v1/reservoirs/{id}                 (archive; reversible)

GET    /api/v1/reservoirs/{id}/calibration-points
PUT    /api/v1/reservoirs/{id}/calibration-points   (replace the full ordered set)

GET    /api/v1/reservoirs/{id}/entity-mappings
POST   /api/v1/reservoirs/{id}/entity-mappings
PATCH  /api/v1/reservoirs/{id}/entity-mappings/{mapping_id}
DELETE /api/v1/reservoirs/{id}/entity-mappings/{mapping_id}
GET    /api/v1/reservoirs/{id}/entity-suggestions?role=...
```

`DELETE /reservoirs/{id}` follows the Grow Space convention: sets
`active = false` rather than deleting, preserving mappings and audit
history; `PATCH` with `active: true` restores it.

## 9. Service and Transaction Behavior

Same conventions as every prior slice: `Database.transaction()` wraps
every mutation plus its `audit_record()` call; the router maps domain
errors (`ReservoirNotFound`, `ReservoirValidationError`) to HTTP status
codes through a local `_map_domain_errors` helper.

`PUT .../calibration-points` replaces the whole set atomically (delete
then bulk-insert inside one transaction) rather than supporting partial
patches — a calibration table only makes sense as a complete, internally
consistent curve.

## 10. Frontend Experience

### 10.1 Reservoirs register

A list grouped loosely by type (mirroring the Grow Spaces register's
card layout), each row showing name, type, current volume (if
available), and an active/inactive badge. "Include inactive" toggle,
same as Grow Spaces.

### 10.2 Reservoir detail

Sections: core details (editable), geometry/calibration editor (shape
picker that reveals the matching fields, or a calibration-point table
editor), entity mappings (reusing the Grow Space wizard's suggestion
list and manual-entity-ID fallback), and a dashboard card presenting
current level, current volume, usable remaining volume, pump/valve/flow
state, water temperature, last sensor update, and data quality —
exactly the subset of spec 15.5 this slice supports.

## 11. Validation and Error Handling

* `ReservoirNotFound` → 404.
* `ReservoirValidationError` (missing required geometry fields for the
  selected shape, `usable_capacity_liters > capacity_liters`, fewer than
  two calibration points for `custom_calibration_table`, unknown role,
  incompatible entity) → 422.
* Archiving a reservoir does not require it to be unmapped — mappings
  persist and continue to appear (read-only) until restored, consistent
  with Grow Spaces.

## 12. Migration and Compatibility

New Alembic migration `0006_reservoirs.py` adds `reservoirs`,
`reservoir_calibration_points`, and `reservoir_entity_mappings`. No
existing table changes. Downgrade drops all three in FK-safe order.

## 13. Testing Strategy

### Backend

* `geometry.py` unit tests: each shape's volume formula, calibration
  interpolation (including clamping outside the table's range), and the
  level-role priority order.
* Migration upgrade/downgrade tests, including a full-record downgrade
  check.
* API tests: CRUD, archive/restore, calibration replacement, entity
  mapping CRUD and suggestion ranking, and the computed
  `current_volume_liters` across each geometry shape and the
  no-mapping/no-geometry null case.

### Frontend

* Typed API client tests (Ingress-relative URLs).
* Reservoir register and detail page tests: geometry shape switching,
  calibration table editing, mapping wizard, dashboard rendering
  (including the "Not available" volume state).

### Final verification

Same gate as every prior slice: `pnpm verify`, OpenAPI export, add-on
context sync, fresh + upgrade migration smoke test, and container smoke
tests in both degraded and authenticated modes.

## 14. Release and Publication

Same flow as `0.4.0`: version bump (this ships as `0.5.0`, migration
head `0006`), changelog entry, OpenAPI regeneration, `pnpm sync:addon`,
Docker build + both container smoke modes, publication-clone commit,
committed-archive build check, push, and a PR against `main`.

## 15. Acceptance Criteria

1. A user can record a reservoir with its type, capacities, and
   thresholds.
2. A user can enter rectangular, vertical-cylinder, horizontal-cylinder,
   or custom-calibration-table geometry.
3. A user can map Home Assistant entities to level, binary-state, water
   temperature, and pump/valve/flow roles with ranked suggestions and a
   manual-entity fallback.
4. The reservoir dashboard shows a computed current volume whenever a
   level-oriented role and sufficient geometry/calibration data are
   present, and "Not available" otherwise — never a fabricated figure.
5. Archiving a reservoir is reversible and preserves its mappings.
6. All new endpoints follow the existing error envelope, audit logging,
   and transaction-boundary conventions.
7. `pnpm verify` passes with zero new lint/type warnings.
8. Fresh (`0001→0006`) and upgrade (`0005→0006`) migrations both succeed
   and are covered by tests.
9. Both container smoke-test modes show no tracebacks and a `0006`
   schema revision.
