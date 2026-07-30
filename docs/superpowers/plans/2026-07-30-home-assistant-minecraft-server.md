# Home Assistant Minecraft Server Add-on — Implementation Plan

Design: `docs/superpowers/specs/2026-07-30-home-assistant-minecraft-server-design.md`
Target: `homeassistant-addons/minecraft_server/`

## Repository shape

```text
homeassistant-addons/
├── repository.yaml                 (already exists — add-on discovered automatically)
└── minecraft_server/
    ├── config.yaml                 add-on options + schema + ingress
    ├── build.yaml                  aarch64/amd64 base images
    ├── Dockerfile                  multi-stage: Go build → HA Alpine base + JRE 21 + restic
    ├── README.md CHANGELOG.md DOCS.md LICENSE
    ├── translations/en.yaml
    ├── docs/                       api.md, backup-recovery.md, troubleshooting.md,
    │                               security.md, development.md, screenshots/
    ├── rootfs/etc/s6-overlay/...   controller service definition
    ├── backend/                    Go module (controller)
    ├── frontend/                   static HTML/CSS/ES modules (embedded via go:embed)
    ├── paper-plugin/               mcbridge (Maven, Java 21)
    ├── presets/                    example preset overlays (also embedded)
    ├── scripts/                    build-arm64.sh, dev.sh, fetch-frontend-deps (none)
    └── tests/                      integration tests, fixtures, manual Pi test plan
```

## Backend package plan

| Package | Responsibility |
| --- | --- |
| `appcfg` | Parse `/data/options.json`, defaults, controller settings persisted in `/data/config/settings.json`, path layout |
| `atomicfs` | `WriteFile`, `ReplaceDir`, `HardlinkTree`, `SwapSymlink`, temp-file + fsync + rename |
| `events` | In-process pub/sub, typed events, SSE fan-out with per-client ring |
| `store` | SQLite open/migrate/integrity-check/rebuild, kv, audit, journal, worlds meta cache, jobs, backups index |
| `adapter` | `Backend` interface (argv, jar path, log grammar, commands for save/stop/chunky) |
| `adapter/paper` | PaperMC implementation |
| `supervisor` | Start/stop/restart/force, stdin console, bounded log ring, crash classification, restart policy, pidfile, state machine + leases |
| `bridge` | Unix-socket listener for `mcbridge`, token auth, last-telemetry snapshot |
| `mcconfig` | Allow-listed files, format validation (properties/yaml/json), snapshots, atomic writes, restart-required rules, structured settings |
| `presets` | Built-in + user overlays, diff against live values, apply, user override tracking |
| `worlds` | World sets, meta, sizes, create/clone/rename/import/export/archive/activate/delete/trash/restore |
| `backups` | restic repo lifecycle, live snapshot pipeline, retention, verify, restore + rollback, progress events |
| `generation` | Chunky install/verify, jobs, guard loop with hysteresis, profiles, chunk + storage estimation, reconcile |
| `stats` | System/process/JVM/disk/thermal sampling, cached directory sizes |
| `scheduler` | Scheduled restarts/backups/updates, idle shutdown |
| `updates` | Paper build discovery, checksum verify, staged swap, health check, rollback |
| `commands` | Single authorization + validation surface shared by REST and MQTT |
| `hass` | MQTT discovery, availability, state publication, command subscriptions |
| `api` | Router, middleware (ingress/CSRF/confirm tokens), REST handlers, `/api/events` SSE, static files |

## Phase 1 — skeleton and lifecycle

1. `config.yaml`, `build.yaml`, Dockerfile, s6 service, translations.
2. Go module; `appcfg`, `paths`, `atomicfs`, `events`, `store` (kv + audit + journal).
3. `adapter` + `adapter/paper` (argv builder, EULA handling, log grammar).
4. `supervisor`: state machine, log ring, crash detection, graceful stop, force stop,
   duplicate-process guard, persisted runtime state.
5. `api`: `/api/status`, `/api/console`, `/api/server/{start,stop,restart,command}`,
   `/api/events` SSE, static frontend.
6. Frontend: dashboard + live console, Ingress-relative fetches.

Exit: page reachable over Ingress with Minecraft stopped; start/stop/restart works; crash
is detected and reported with exit code.

## Phase 2 — configuration, presets, metrics, worlds

1. `mcconfig`: properties/YAML/JSON round-trip, allow-list, snapshot-before-write,
   atomic replace, audit entry, `restart_required`.
2. Structured settings form mapping (gamemode … java flags) + advanced file editor.
3. `presets`: overlay schema, six built-ins, diff preview, apply, user overrides file.
4. `stats`: `/proc` + `/sys` sampling, cached sizes, disk stats; `bridge` + `mcbridge`
   plugin for TPS/MSPT/heap/chunks/entities/players.
5. `worlds`: enumerate, meta, sizes, activate (with rollback), rename, clone.

Exit: dashboard shows real TPS/MSPT/heap/temp; presets show a diff; worlds switchable.

## Phase 3 — backups and restore

1. `backups/restic.go`: repo init, password file, `backup/snapshots/forget/prune/check/
   restore/stats` as argv arrays with JSON output parsing.
2. Live snapshot pipeline: `save-off` → `save-all flush` → hardlink staging → `save-on`
   → restic backup → verify → staging cleanup, all journalled.
3. Retention, labels/notes, repository health, sizes, durations.
4. Restore: verify → safety backup → staged restore → validate → atomic swap → start →
   rollback on failure; cancellation where safe.
5. World import (ZIP-slip safe) / export, archive, trash + permanent delete.

Exit: two consecutive backups of the same world store far less than 2× the data; a
restore that fails validation leaves the original world untouched.

## Phase 4 — terrain generation

1. Chunky acquisition from a configured trusted source with hash verification.
2. Job model persisted in SQLite; console-driven start/pause/continue/cancel; progress
   parsed from Chunky console output.
3. Guard loop (5 s) with hysteresis, dwell time, allowed hours, dimension sequencing.
4. Profiles Gentle/Balanced/Maximum incl. maintenance mode, pre/post backups, post-run
   restart, optional shutdown.
5. Estimation: chunk count from shape/radius; measured bytes-per-chunk from region-file
   headers; range output; disk-space refusal; world-border comparison and warning.
6. Startup reconciliation against Chunky's real task state.

Exit: joining a player pauses generation within one guard tick; overheating pauses it;
low disk cancels it; resume requires the recovery thresholds.

## Phase 5 — integration, updates, hardening, docs, tests

1. `hass`: MQTT discovery for the documented entity set, commands routed through
   `commands` (same validation as REST), availability + attributes.
2. `updates`: Paper builds API, checksum verify, backup, staged swap, health check,
   rollback; opt-in scheduling only.
3. Startup reconciliation for every journalled operation; corrupted-DB recovery.
4. Docs: README, DOCS (configuration + API), backup recovery, troubleshooting, security,
   development; mockup screenshots.
5. Tests + `scripts/build-arm64.sh` (buildx) + manual Pi 5 test plan.

## Test matrix

| Area | Test |
| --- | --- |
| Supervisor | start→running, graceful stop, stop timeout escalation, crash detection + exit code, no duplicate process, intentional-vs-crash |
| Config | properties/YAML/JSON validation, rejected keys, snapshot creation, atomic write (crash-safe temp+rename), restart-required flags |
| Presets | diff correctness, apply writes all scopes, user overrides preserved |
| Worlds | create, clone, ZIP-slip/absolute/symlink/oversize import rejection, valid import, activate rollback on startup failure, trash + permanent delete guard |
| Backups | incremental dedup, `save-on` restored after failure, journal recovery, restore rollback, interrupted restore recovery |
| Generation | scheduling window, player-join pause, TPS pause, thermal pause, low-disk cancel, hysteresis, estimation from region headers, reconcile after restart |
| HA | MQTT command mapping uses `commands` layer, rejects invalid payloads |
| API | Ingress path handling, CSRF header requirement, confirmation tokens |
| Build | `scripts/build-arm64.sh` (docker buildx, skipped without docker) |

Paper and Chunky are mocked with a fake process (`tests/fakepaper`) that speaks the real
console grammar; restic is mocked with a stub binary for failure-path tests.

## Manual Raspberry Pi 5 test plan

1. Install the add-on from the local repository; confirm the aarch64 build succeeds.
2. Start with Minecraft stopped — Ingress page must load and show `stopped`.
3. Accept the EULA explicitly; start Paper; watch the console reach `Done`.
4. Join with a client; confirm players/TPS/MSPT/heap and CPU temperature.
5. Apply the `Balanced` preset, confirm the diff, restart, verify values in-game.
6. Create a second world, switch to it, switch back; confirm rollback path by pointing
   `level-name` at a corrupted world.
7. Run a manual backup while online; confirm `save-off` window < 1 s in the log and the
   second backup adds little repository size.
8. Restore into a fresh world; confirm the safety backup exists.
9. Start a `Gentle` Chunky job with radius 3000; join the server and confirm the pause,
   then leave and confirm the delayed resume.
10. Heat the Pi (stress) to trip the temperature guard; confirm pause and resume.
11. Fill the disk to below the threshold; confirm cancellation.
12. Verify HA entities appear and buttons work; check `sensor.minecraft_tps` updates.
13. Reboot Home Assistant while Minecraft runs; confirm reconciliation output.
14. Confirm controller RSS stays well under 100 MB and idle CPU under a few percent.
