# Changelog

## 0.4.0

- Added Plant and Grow journal entries with type, tags, an optional related lifecycle stage, and an optional related issue.
- Added Plant measurements for height, width, canopy and stem diameter, node count, container and plant weight, and named custom metrics.
- Added Plant photo uploads with caption, tags, optional journal-entry and measurement links, and file-backed storage under `/data`.
- Added a merged per-Plant Activity Timeline combining stage transitions, journal entries, measurements, and photos in one chronological feed.
- Added a Plant detail Activity/Photos tabbed view with inline note, measurement, and photo composers, plus a Grow detail journal section.
- Added Alembic migration `0005` for journal entries, measurements, and photos.
- Preserved Home Assistant independence: all new record-keeping remains usable while Home Assistant is disconnected.

## 0.3.0

- Added first-class Grows that belong to a Grow Space and support multiple simultaneous active cycles.
- Added minimal structured cultivars with an optional breeder so unknown or gifted genetics can be recorded.
- Added installation-wide lifecycle stages with rename, reorder, enable/disable, and custom-stage support; disabling preserves history.
- Added individually identifiable Plants with seed/clone identity, cultivation details, plan-versus-actual dates, and status.
- Added append-only lifecycle stage transitions with deterministic current-stage projection and backward/skipped confirmation.
- Added a Plant Duplicate workflow that reviews a prefilled draft without copying lifecycle history.
- Added Grows and Plants register, Grow detail, Plant detail, and lifecycle stage settings routes.
- Added Alembic migration `0004` for breeders, cultivars, lifecycle stages, grows, plants, and transitions.
- Preserved Home Assistant independence: all new cultivation records remain usable while Home Assistant is disconnected.

## 0.2.1

- Corrected editable Grow Space types to Indoor Tent, Greenhouse, Outdoor, and Room.
- Added canonical dimensions with calculated floor area and volume.
- Added full Grow Space editing and reversible Active/Inactive status.

## 0.2.0

- Added universal Grow Spaces with audited create, update, list, detail, and reversible Active/Inactive APIs.
- Added Indoor Tent, Greenhouse, Outdoor, and Room physical-space types while preserving removed values as readable legacy records.
- Added length × width × height entry in centimetres or inches with calculated floor area and volume.
- Added optional environmental entity mappings, compatibility-ranked Home Assistant discovery, manual entity IDs, and normalized live readings.
- Added a guided details → environmental mappings → review setup wizard plus full core-detail editing.
- Replaced Grow Space fixtures with live register and capability-detail views.
- Added Alembic migrations `0002` and `0003` for mappings and canonical dimensions.
- Preserved Home Assistant as the authority for physical equipment safety; equipment control remains deferred.

## 0.1.0

- Added the Home Assistant Ingress app foundation.
- Added FastAPI health, readiness, and redacted diagnostics endpoints.
- Added SQLite WAL storage and automatic Alembic migrations.
- Added Supervisor API authentication and state subscription foundations.
