# Grow Spaces and Environmental Entity Mapping Design

**Date:** 2026-07-22  
**Status:** Approved design  
**Scope:** First post-foundation vertical slice

## 1. Objective

Replace the Grow Spaces frontend fixtures with a production-shaped vertical slice that lets users create universal grow spaces and optionally map Home Assistant environmental entities to semantic roles.

The slice must remain local-first, Ingress-safe, and read-only toward Home Assistant equipment. Home Assistant remains authoritative for entity state and physical safety.

## 2. Scope

### Included

- Grow-space list, creation, retrieval, editing, and archival
- A guided setup wizard
- Core grow-space metadata
- Environmental entity discovery and role-filtered suggestions
- Manual Home Assistant entity IDs
- Multiple mappings for the same semantic role
- Unit compatibility and normalization
- Mapping priority, freshness threshold, display name, enabled state, and calibration metadata foundation
- Transactional audit records
- Live summary values from the existing Home Assistant state cache
- Loading, empty, offline, validation, and retry states

### Deferred

- Equipment mapping UI and equipment control
- Default light schedules
- Electricity tariffs
- Environment targets
- Reservoirs and irrigation zones
- Plants, grows, journals, and timelines
- Persisting Home Assistant measurements as historical time-series data
- Companion-integration entities beyond app availability

## 3. Universal Grow-Space Model

A grow space represents a physical cultivation area. Its type describes the place but does not determine fixed fields or equipment.

Supported types:

- `tent`
- `room`
- `cabinet`
- `greenhouse`
- `hydroponic_system`
- `other`

Sensors, equipment, targets, schedules, reservoirs, and later capabilities attach to the grow space independently. This avoids separate schemas for tents, rooms, cabinets, and hydroponic systems.

An indoor tent can therefore be created with core metadata, receive environmental mappings during setup, and later receive grow-light, fan, pump, valve, and approved-script mappings through an Equipment section.

## 4. Architecture

The feature is a typed vertical slice within the existing modular monolith.

### Frontend

- Grow-space list route backed by the real API
- Three-step guided wizard
- Grow-space detail route that becomes the home for later capability sections
- Typed Zod API contracts
- TanStack Query for loading, mutation, invalidation, and retry behavior

### Backend

- Grow-space router
- Entity-mapping router
- Home Assistant entity-discovery router
- Application services for validation, unit normalization, transactions, and audit logging
- Focused repository interfaces backed by SQLAlchemy

### Infrastructure

- SQLite stores grow-space configuration and mappings
- The existing `EntityStateCache` supplies current Home Assistant states and attributes
- Supervisor REST loads the initial state snapshot
- Supervisor WebSocket updates the cache continuously

Configuration is authoritative in Cultivation Assistant. Entity state and physical safety are authoritative in Home Assistant.

## 5. Data Model

### `grow_spaces`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `name` | string | Required; trimmed; unique among active spaces |
| `description` | text or null | Optional |
| `location` | string or null | Optional |
| `space_type` | string | Validated through the supported type registry |
| `active` | boolean | Defaults to true; false means archived |
| `area_m2` | decimal or null | Positive; normalized to square metres |
| `volume_m3` | decimal or null | Positive; normalized to cubic metres |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

The API accepts supported metric or imperial dimension units and stores canonical SI values.

### `entity_mappings`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | Primary key |
| `grow_space_id` | UUID string | Foreign key with cascade behavior defined by the repository |
| `entity_id` | string | Valid Home Assistant `domain.object_id` syntax |
| `role` | string | Validated through the semantic-role registry |
| `display_name` | string or null | Optional user override |
| `priority` | integer | Non-negative; lower number is preferred |
| `source_unit` | string or null | Captured from current HA metadata when available |
| `normalized_unit` | string or null | Canonical role unit |
| `enabled` | boolean | Defaults to true |
| `calibration` | JSON or null | Reserved foundation for validated calibration metadata |
| `stale_after_seconds` | integer | Positive and bounded |
| `created_at` | UTC datetime | Server generated |
| `updated_at` | UTC datetime | Server generated and updated |

A unique constraint prevents duplicate `(grow_space_id, entity_id, role)` tuples. Multiple entities may map to the same role. The same entity may map to different roles only when each role accepts its current metadata.

### Extensible semantic-role registry

Roles are application-validated strings rather than a restrictive database enum. Every role definition declares:

- Stable role key
- Category (`environmental` or later `equipment`)
- Compatible Home Assistant domains
- Compatible device classes
- Accepted source units
- Canonical normalized unit
- Default stale threshold
- Optional name hints

Adding equipment roles later does not require redesigning the mapping table.

## 6. First-Slice Environmental Roles

- `air_temperature`
- `canopy_temperature`
- `root_zone_temperature`
- `relative_humidity`
- `co2`
- `illuminance`
- `ppfd`
- `water_temperature`
- `external_vpd`
- `power`
- `energy`
- `leak_detection`

Canonical units:

- Temperature: `°C`
- Relative humidity: `%`
- CO₂: `ppm`
- Illuminance: `lx`
- PPFD: `µmol/m²/s`
- VPD: `kPa`
- Power: `W`
- Energy: `kWh`
- Leak detection: boolean state

Known convertible units are normalized, including Fahrenheit to Celsius, kilowatts to watts, and watt-hours to kilowatt-hours.

## 7. API

All routes use the existing `/api/v1` prefix and public error envelope.

### Grow spaces

- `GET /grow-spaces`
  - Lists active spaces by default
  - Supports an explicit archived filter
  - Returns mapping counts and a compact live summary when cached values exist
- `POST /grow-spaces`
  - Accepts core details and an optional mappings array
  - Creates the space, mappings, and audit record in one transaction
- `GET /grow-spaces/{grow_space_id}`
  - Returns details, mappings, compatibility status, and cached live values
- `PATCH /grow-spaces/{grow_space_id}`
  - Updates core fields and writes an audit record
- `DELETE /grow-spaces/{grow_space_id}`
  - Archives rather than physically deleting the grow space
  - Writes an audit record

### Entity mappings

- `POST /grow-spaces/{grow_space_id}/entity-mappings`
- `PATCH /grow-spaces/{grow_space_id}/entity-mappings/{mapping_id}`
- `DELETE /grow-spaces/{grow_space_id}/entity-mappings/{mapping_id}`

Mapping deletion removes the configuration record but preserves its audit history.

### Home Assistant discovery

- `GET /home-assistant/entities?role={role}`

The response includes:

- Entity ID
- Friendly name
- Domain
- Device class
- Source unit
- Current state
- Last-updated timestamp
- Availability
- Compatibility (`compatible`, `convertible`, or `unknown`)
- Compatibility explanation

Known incompatible entities are omitted from suggestions. The user may still type a manual entity ID.

## 8. Discovery and Validation

For a selected semantic role, discovery ranks cached Home Assistant entities by:

1. Exact device-class and unit match
2. Compatible device class with convertible unit
3. Compatible domain plus friendly-name hints
4. Alphabetical fallback among otherwise equivalent candidates

A syntactically valid manual entity ID can be saved when it is absent from the cache. Its source unit remains unknown until the entity appears.

If Home Assistant currently knows an entity and its unit or device class is incompatible with the selected role, the API rejects the mapping with `422`. This prevents silently incorrect normalized values.

If Home Assistant discovery is offline, the endpoint returns `503`. Existing grow-space configuration remains available, and the wizard permits manual IDs.

Live values are read from `EntityStateCache`; the first slice does not duplicate state history in SQLite.

## 9. Guided Wizard

### Step 1: Space details

- Required name
- Type
- Optional description and location
- Optional area and volume with unit selectors
- Inline validation

### Step 2: Environmental mappings

- One section per supported environmental role
- Role-filtered suggestions
- Manual entity ID entry
- Multiple mappings per role
- Optional advanced display name, priority, and stale threshold
- Mapping is not required to continue

### Step 3: Review and create

- Core details
- Normalized dimensions
- Mapped and skipped roles
- Entity availability and compatibility summary
- One atomic create mutation

A valid grow space requires core details only. All mappings are optional and can be added later.

On success, the app opens the new grow-space detail page. On failure, it retains all entered values, displays an accessible error summary, focuses the first relevant error, and permits retry.

## 10. Grow-Space Detail and Future Capabilities

The detail route establishes independent sections:

- Overview
- Environment
- Equipment
- Targets
- Reservoirs

Only Overview and Environment are functional in this slice. The other sections communicate planned capability boundaries without offering nonfunctional controls.

Future equipment roles include grow lights, exhaust fans, intake fans, circulation fans, humidifiers, dehumidifiers, heaters, irrigation pumps, fill pumps, circulation pumps, valves, and emergency-stop scripts.

Equipment mapping does not imply equipment control. Read-only state may come from a mapped entity, but consequential actions must invoke explicitly configured Home Assistant scripts with safety limits and interlocks.

## 11. Error Handling

- `404`: grow space or mapping does not exist
- `409`: duplicate mapping, duplicate active name, archived-space mutation, or conflicting update
- `422`: invalid dimensions, entity ID, role, priority, stale threshold, or known-incompatible Home Assistant metadata
- `503`: live Home Assistant discovery unavailable

All errors use the existing stable envelope and correlation ID middleware. No Supervisor token, authorization header, cookie, or database path appears in responses or logs.

## 12. Audit Behavior

The following actions write an append-only audit record in the same database transaction as the configuration change:

- Grow-space creation
- Grow-space update
- Grow-space archival
- Mapping creation
- Mapping update or enable/disable
- Mapping deletion

Audit details contain changed public fields and stable identifiers but no Home Assistant token or secret configuration.

## 13. UI States and Accessibility

The Grow Spaces route supports:

- Loading skeletons
- Empty-state onboarding
- Loaded cards from the real API
- Archived-space view
- Backend failure with retry
- Home Assistant offline state without hiding stored spaces

The UI keeps existing Ministry of Elsewhere styling and Civic Chimera dark mode. It supports desktop, tablet, mobile, and the Home Assistant companion webview.

Requirements:

- Keyboard-operable wizard and entity picker
- Visible focus
- Explicit labels and descriptions
- Error summary with field association
- No status communicated by color alone
- Text alternatives for compatibility and stale status

## 14. Testing Strategy

### Backend unit tests

- Grow-space field validation
- Semantic-role registry behavior
- Entity-ID syntax
- Unit compatibility and conversion
- Candidate ranking
- Stale threshold defaults and bounds
- Duplicate mapping detection

### Backend integration tests

- Alembic migration and constraints
- Grow-space list/create/retrieve/update/archive
- Atomic space-plus-mapping creation
- Rollback on invalid mapping
- Audit records committed with configuration changes
- Mapping lifecycle
- Archived-space mutation rejection
- Discovery with compatible, convertible, unknown, unavailable, and incompatible entities
- Home Assistant discovery offline behavior

### Frontend tests

- Typed API response validation
- Ingress-relative requests
- Wizard step navigation
- Required-name validation
- Details-only completion
- Multiple mappings per role
- Filtered suggestions and manual IDs
- Review summary
- Successful create and query invalidation
- Save failure retention and retry
- Loading, empty, offline, and archived states
- Mobile layout and keyboard interaction

### Regression verification

- Full `pnpm verify`
- Alembic migration against a fresh temporary database
- Docker image build from synchronized app context
- Container smoke tests for degraded and connected Home Assistant states

## 15. Acceptance Criteria

The slice is complete when:

1. A user can create an active grow space using core details only.
2. A user can optionally map one or more compatible environmental entities during setup.
3. Home Assistant suggestions are filtered and ranked by semantic compatibility.
4. Known convertible units are normalized to canonical units.
5. Known incompatible mappings are rejected without corrupting configuration.
6. A user can manage mappings after creation.
7. A user can archive and view archived spaces.
8. The Grow Spaces UI contains no hard-coded fixture spaces.
9. Every consequential configuration change creates an audit record.
10. Existing app health, Ingress, migration, Docker, and companion-integration behavior continues to pass verification.
