# ADR 0003: Ingress and local authentication

- **Status:** Accepted
- **Date:** 2026-07-22

## Decision

Use Home Assistant Ingress as the ordinary browser-access boundary. The frontend uses relative assets, hash routing, and relative `api/v1` requests so no mount path is assumed.

Backend-to-Home-Assistant communication uses the Supervisor-provided token and internal REST/WebSocket endpoints. Users are never asked to create a long-lived Home Assistant access token. The companion integration configures a local app URL and exposes only derived health information in the foundation release.

## Consequences

- No external public port is needed by default.
- Ingress path handling requires integration tests before release.
- Logs, errors, and diagnostics must redact authorization headers and token fields.
- Finer-grained app API permissions can be added later without changing the Home Assistant token model.
