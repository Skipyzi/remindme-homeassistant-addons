# Cultivation Assistant

Cultivation Assistant is a local-first Home Assistant app for plant planning and cultivation monitoring. It provides an Ingress UI, persists its data locally with SQLite, and communicates with Home Assistant through the Supervisor-provided API token.

## Install

1. Add `https://github.com/Skipyzi/remindme-homeassistant-addons` as a Home Assistant app repository.
2. Reload the app store.
3. Install **Cultivation Assistant**.
4. Start the app and enable **Show in sidebar**.
5. Open the Ingress UI and verify that the connection indicator becomes available.

## Current foundation

- Home Assistant Ingress UI
- FastAPI health, readiness, and diagnostics endpoints
- SQLite WAL storage with automatic Alembic migrations
- Supervisor API authentication
- Initial entity-state loading and WebSocket state subscription
- Local-only operation without a user-generated long-lived access token

## Safety boundary

Home Assistant remains authoritative for physical equipment safety. Keep leak protection, overflow shutdown, emergency ventilation, pump interlocks, lighting limits, and similar safeguards in Home Assistant automations or device firmware.

## Storage and networking

- Persistent application data: `/data`
- Internal Ingress port: `8099`
- Direct host exposure: disabled by default
- Authentication: Supervisor-provided token

## Status endpoints

- `/api/v1/health`
- `/api/v1/readiness`
- `/api/v1/diagnostics`

Readiness reports unavailable until both SQLite and Home Assistant connectivity are ready.
