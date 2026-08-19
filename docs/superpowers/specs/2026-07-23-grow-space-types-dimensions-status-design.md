# Grow Space Types, Dimensions, and Status Correction

**Date:** 2026-07-23  
**Status:** Ready for user review

## Purpose

Correct the first Grow Spaces release so its physical-space vocabulary and
measurements match real cultivation spaces. Replace direct area and volume entry
with ordinary dimensions, reduce the supported type list, and make the current
one-way archival state a reversible Active/Inactive status.

This correction preserves the universal capability model. Environmental
mappings, equipment, targets, schedules, reservoirs, and irrigation remain
independent attachments rather than properties implied by the physical-space
type.

## Scope

This change covers:

- Four user-facing physical-space types
- Length, width, and height entry in centimetres or inches
- Server-side derived area and volume
- Editing all core details after creation
- Reversible Active/Inactive status
- Compatibility behavior for existing legacy type values
- Migration, API, UI, audit, and verification changes

It does not add equipment control, targets, schedules, reservoirs, or irrigation.

## Physical-Space Types

New and edited records support exactly these choices:

| Display label | API value |
| --- | --- |
| Indoor Tent | `tent` |
| Greenhouse | `greenhouse` |
| Outdoor | `outdoor` |
| Room | `room` |

The removed `cabinet`, `hydroponic_system`, and `other` values are not rewritten
automatically. Existing records with those values remain readable and receive a
Legacy type badge. A patch that does not change `space_type` may preserve the
legacy value. Once the user changes the type, it must be one of the four current
values.

## Dimension Model

### User input

The details form contains:

- Length
- Width
- Height
- One shared unit selector: `cm` or `in`

Length and width are required and positive for all new Grow Spaces. Height is
required and positive for Indoor Tent, Greenhouse, and Room. Height is optional
for Outdoor.

The form rejects partial or non-positive dimension sets. Switching the shared
unit converts the current values so the represented physical size does not
change.

### Persistence

Alembic revision `0003` adds nullable columns to `grow_spaces`:

- `length_m NUMERIC(12,4)`
- `width_m NUMERIC(12,4)`
- `height_m NUMERIC(12,4)`
- `dimension_unit VARCHAR(8)`

Canonical lengths are stored in metres using `Decimal`. The preferred input unit
is retained so edit forms can reconstruct familiar values such as
`80 × 80 × 180 cm`.

Existing `area_m2` and `volume_m3` columns remain. They become derived values:

- `area_m2 = length_m × width_m`
- `volume_m3 = area_m2 × height_m`
- `volume_m3 = null` when an Outdoor space has no height

Legacy records keep their existing area and volume and receive null canonical
dimensions. The migration does not invent length, width, or height from area and
volume because those values do not define a unique shape.

### API input

Create and update contracts use a single dimensions object:

```json
{
  "space_type": "tent",
  "dimensions": {
    "length": "80",
    "width": "80",
    "height": "180",
    "unit": "cm"
  }
}
```

Outdoor may send `height: null`. Direct area and volume input is removed from new
API requests. Backend validation and Decimal conversion are authoritative.

Responses include editable dimensions in the preferred unit together with
canonical calculated area and volume. A legacy record may return
`dimensions: null` while retaining `area_m2` and `volume_m3`.

## Active and Inactive Lifecycle

The existing `active` database field becomes an ordinary reversible status.
Inactive replaces archived in user-facing language.

`PATCH /api/v1/grow-spaces/{grow_space_id}` accepts `active`. Both transitions
are allowed:

- Active to Inactive
- Inactive to Active

Transitions preserve mappings and audit history. Inactive records remain
editable, including their environmental mappings. They are hidden from the
default register and appear when Include inactive is enabled.

Reactivation applies active-name uniqueness. If another active record has the
same case-insensitive name, the API returns `409` and leaves the inactive record
unchanged.

The existing DELETE endpoint remains as a backward-compatible deactivation
operation. It sets `active` to false and uses the same deactivation audit action.
The UI uses explicit status editing rather than destructive or archival language.

Audit actions distinguish the transitions:

- `grow_space.deactivated`
- `grow_space.reactivated`

Ordinary core edits continue to use `grow_space.updated`, with changed fields in
the audit details.

## Editing Behavior

The creation wizard and detail editor share a reusable
`GrowSpaceDetailsForm`. It owns labels, type choices, dimension conversion,
calculated previews, and field-level validation.

The existing detail page remains a readable capability record. An Edit details
action opens the shared form with:

- Name
- Description
- Location
- Space type
- Length, width, and height
- Preferred unit
- Active/Inactive status

Status-only and unrelated patches omit unchanged fields. This allows an existing
legacy record to change status without first choosing a new type or inventing
missing dimensions.

If the user changes a legacy type or dimensions, the form requires a current
supported type and a dimension set valid for that type.

## Display Behavior

The Grow Space register and detail page display familiar dimensions first:

```text
80 × 80 × 180 cm
```

Calculated values are secondary:

```text
Floor area 0.64 m²
Volume 1.15 m³
```

Outdoor without height displays length × width, calculated area, and
`Volume not available`.

The current register filter label changes from Include archived to Include
inactive. Inactive and Legacy type states are expressed with text badges and do
not rely on color alone.

## Validation and Error Handling

- Length, width, and required height must be finite positive decimals.
- `cm` and `in` are the only accepted display units.
- Enclosed types reject a missing height with `422`.
- Outdoor accepts a missing height.
- New and changed types reject removed values with `422`.
- A reactivation name conflict returns `409`.
- All validation failures use the existing stable API error envelope.
- Failed edits retain entered values and focus the error summary.
- Calculated previews never replace backend validation.

## Data Flow

1. The shared details form collects dimensions and a preferred unit.
2. The browser calculates a preview for immediate feedback.
3. The typed frontend client sends the dimensions object.
4. Pydantic validates type-dependent requirements.
5. The service converts dimensions to canonical metres with `Decimal`.
6. The service derives area and volume in the same database transaction.
7. Core changes and their audit record commit or roll back together.
8. Responses reconstruct dimensions in the preferred display unit.
9. TanStack Query invalidates list/detail caches after update.

## Testing

Backend tests cover:

- Revision `0003` upgrade and downgrade
- Preservation of existing area, volume, and legacy type values
- Centimetre and inch conversion using `Decimal`
- Required length and width
- Height requirements by type
- Outdoor without height
- Derived area and volume
- Create and patch contracts
- Status transitions and audit actions
- Reactivation name conflicts
- Editing inactive records and mappings

Frontend tests cover:

- The four current type choices
- Required dimensions by type
- Shared centimetre/inch selector
- Unit switching without physical-size changes
- Live area and volume previews
- Outdoor optional height
- Shared creation and editing form behavior
- Full core-detail updates
- Reversible Active/Inactive control
- Include inactive filtering
- Legacy type display and status-only updates
- Loading, API failure, and retained-form-value states

Final verification includes proactive diagnostics, `pnpm verify`, fresh migration
smoke tests, synchronized Docker build, committed-archive Docker build, and both
degraded and authenticated Home Assistant container smoke modes.

## Compatibility and Release

The correction ships as migration `0003` on top of `0002`. Existing Grow Space
IDs, mappings, audit records, area, and volume remain intact. No automatic type
mapping is performed for removed type values.

The already-open publication PR must be updated rather than replaced. Its
committed archive must be rebuilt after the correction, and the PR description
must report the new migration head and fresh verification evidence. Live Home
Assistant Supervisor installation remains explicitly unverified until performed.
