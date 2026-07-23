# Changelog

## 0.2.0

- Added universal Grow Spaces with audited create, update, list, detail, and archive APIs.
- Added optional environmental entity mappings, compatibility-ranked Home Assistant discovery, manual entity IDs, and normalized live readings.
- Added a guided details → environmental mappings → review setup wizard.
- Replaced Grow Space fixtures with live register and capability-detail views.
- Added Alembic migration `0002` for grow spaces and entity mappings.
- Preserved Home Assistant as the authority for physical equipment safety; equipment control remains deferred.

## 0.1.0

- Added the Home Assistant Ingress app foundation.
- Added FastAPI health, readiness, and redacted diagnostics endpoints.
- Added SQLite WAL storage and automatic Alembic migrations.
- Added Supervisor API authentication and state subscription foundations.
