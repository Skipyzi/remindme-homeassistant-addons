# ADR 0002: Home Assistant owns physical safety

- **Status:** Accepted
- **Date:** 2026-07-22

## Decision

Cultivation Assistant records, analyzes, recommends, and requests actions. Home Assistant scripts and automations remain authoritative for equipment schedules, maximum pump runtime, leak shutdown, overflow protection, dry-run prevention, valve sequencing, cooldowns, and emergency stops.

The app may invoke explicitly configured script entities. Equipment requests must later pass domain prerequisites and idempotency checks before reaching the Home Assistant client. The client rejects non-script targets through its script-invocation interface.

## Consequences

- An app outage cannot disable existing Home Assistant safety automations.
- The application will not provide unrestricted indefinite pump controls.
- Audit records must cover every consequential action request and outcome.
- Raw service-call capability remains internal infrastructure rather than a public API.
