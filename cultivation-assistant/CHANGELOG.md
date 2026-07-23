# Changelog

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
