# Home Assistant Minecraft Server Add-on — Design

Date: 2026-07-30
Status: implemented (Phases 1–5)
Slug: `minecraft_server`
Location: `homeassistant-addons/minecraft_server/`

## Goal

A Home Assistant OS add-on that runs and manages an optimized PaperMC server on a
Raspberry Pi 5 (aarch64, 8 GB). Management UI lives behind Ingress and stays available
while Minecraft is stopped. Terrain is pre-generated with Chunky under safety guards so
live generation never competes with Home Assistant.

## Non-goals

- Multi-server / multi-instance hosting.
- Plugin marketplace or auto-updating plugins.
- Replacing Home Assistant's own add-on backups (we back up *worlds*, separately).
- Proxy setups (Velocity/BungeeCord).

## Key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Backend language | Go 1.25 | Small static binary, reliable `os/exec` supervision, no runtime in image |
| SQLite driver | `modernc.org/sqlite` | Pure Go — no cgo, trivial `GOARCH=arm64` cross-compile |
| Frontend | Hand-written HTML/CSS/ES modules | No Node in the final image, no build step, Ingress-relative URLs |
| Live updates | Server-Sent Events | One-way stream is enough; survives Ingress proxying better than WS |
| Base image | `ghcr.io/home-assistant/aarch64-base` (Alpine) + `openjdk21-jre-headless` | HA-conventional, small; musl documented as a caveat |
| Init | s6-overlay from the HA base image | Controller is a supervised service, Minecraft is its child |
| Backups | `restic` subprocess against `/data/backups/repo` | Incremental + content-addressed dedup + verify, battle-tested |
| Snapshot mechanism | hardlink farm in `/data/staging` | Keeps the `save-off` window to well under a second |
| Terrain generation | Chunky driven over server stdin, progress parsed from console | No unauthenticated port, works with any Paper build |
| Telemetry | Custom `mcbridge` Paper plugin → Unix socket, push-only | TPS/MSPT/heap/chunks/entities cannot be scraped reliably from logs |
| HA entities | MQTT discovery (Supervisor `services/mqtt` first, options fallback) | No custom integration to install |
| Server flavours | `adapter.Backend` interface, `paper` implementation | PumpkinMC/Fabric later without touching managers |

## Component map

```text
cmd/controller ──┬── api        REST + SSE + static frontend (Ingress)
                 ├── commands   single authorization/validation surface (UI + MQTT)
                 ├── supervisor process lifecycle, log ring, crash policy
                 │     └── adapter.Backend ── paper (argv, jar, log grammar)
                 ├── bridge     Unix-socket telemetry from mcbridge plugin
                 ├── mcconfig   allow-listed config files, atomic writes, snapshots
                 ├── presets    overlays + diff + user overrides
                 ├── worlds     world sets, import/export/clone/activate/trash
                 ├── backups    restic repo, live snapshot, restore w/ rollback
                 ├── generation Chunky jobs, guard loop, estimation
                 ├── stats      cached system/process/JVM/disk metrics
                 ├── scheduler  restarts, scheduled backups, idle shutdown
                 ├── updates    Paper build discovery, staged swap, rollback
                 ├── hass       MQTT discovery + command subscriptions
                 └── store      SQLite state, audit log, recovery journal
```

## Data layout (`/data`)

```text
runtime/paper/        server cwd: jar, server.properties, config/, plugins/, logs/
worlds/<id>/          world/, world_nether/, world_the_end/, meta.json
backups/repo/         restic repository
staging/              hardlink snapshots + restore staging
presets/              user presets (built-ins are embedded)
config/               controller settings, generation policy, config snapshots
trash/                soft-deleted worlds
jars/                 staged Paper jars
secrets/              restic password, bridge token (0600)
run/                  bridge.sock, minecraft.pid
audit/audit.log       human-readable operation journal
controller.db         SQLite state
```

Active world = atomically swapped symlinks `runtime/paper/world{,_nether,_the_end}`
into `worlds/<id>/`. `level-name` stays `world`, so Paper needs no per-world config.

## State machine

`stopped starting running stopping restarting crashed backing_up restoring
switching_world generating maintenance`

Transitions are owned by the supervisor; long operations take a *state lease* so two
destructive jobs can never interleave. Stopping Minecraft never stops the controller.

Graceful stop: `save-all flush` → `stop` → wait `stop_timeout_seconds` → SIGTERM →
SIGKILL. Force stop is a separate confirmed action.

## Safety model

- Ingress is the primary authentication boundary; the controller additionally requires a
  same-origin custom header for every state-changing request and refuses direct-LAN
  state changes unless explicitly enabled.
- All paths are sanitized and confined; ZIP import rejects traversal, absolute entries,
  symlinks, and oversized/deep archives.
- No user input reaches a shell: every subprocess is an argv array.
- Secrets are 0600, redacted from logs and API responses.
- Destructive actions (force stop, delete, permanent delete, restore, world switch,
  update, EULA) require explicit confirmation and are written to the audit log.
- EULA is never accepted automatically.

## Reliability model

Every multi-step operation writes a journal row (`op`, `phase`, payload) inside a SQLite
transaction before touching the filesystem. On startup the controller reconciles:
re-enables `save-on`, clears staging, rolls back half-finished world switches and
restores, marks interrupted generation jobs paused, and repairs/rebuilds a corrupted
database from scratch after moving it aside.

## Generation guards

Sampled every 5 s with hysteresis and a minimum dwell time; reasons are surfaced in the
UI and over MQTT: players online, TPS/MSPT, CPU temperature, system CPU, free disk,
allowed hours. Storage need is estimated from *measured* bytes-per-chunk (region header
scan), shown as a range, and generation refuses to start below the safe threshold.

## Acceptance mapping

See `homeassistant-addons/minecraft_server/DOCS.md` (configuration + API reference) and
`docs/superpowers/plans/2026-07-30-home-assistant-minecraft-server.md` (phase plan,
test matrix, manual Pi 5 test plan).
