# ADR 0001: Local-first modular monolith

- **Status:** Accepted
- **Date:** 2026-07-22

## Decision

Run one FastAPI process inside the Home Assistant app. Organize business behavior into framework-independent domain modules, repository interfaces, infrastructure adapters, and versioned HTTP routes. Store durable records in SQLite under `/data` and evolve every schema change through Alembic.

The React frontend is built into static assets served by FastAPI. The companion integration remains a separate Home Assistant custom component and consumes the app's local API.

## Consequences

- Installation and backup remain local to the Home Assistant host.
- Domain calculations can be tested without FastAPI, SQLAlchemy, or Home Assistant.
- Background work must remain restart-safe and may not block critical monitoring.
- A future standalone container can reuse the same backend without creating a cloud service.
