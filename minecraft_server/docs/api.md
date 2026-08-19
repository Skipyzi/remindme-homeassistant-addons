# API reference

The controller serves a JSON REST API and an event stream on the Ingress port. Paths are
relative to the Ingress base URL, for example
`/api/hassio_ingress/<token>/api/status`.

## Authentication and headers

Home Assistant Ingress provides authentication. On top of that:

- Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must send
  `X-Minecraft-Addon: 1`. A browser cannot set that header on a cross-site form post
  without a CORS preflight, which is what makes it a CSRF guard.
- State-changing requests that do not arrive through Ingress are refused with `403` unless
  the `allow_direct_access` option is enabled.
- Reads are allowed without the header.

```bash
curl -X POST -H 'X-Minecraft-Addon: 1' http://localhost:8099/api/server/start
```

## Confirmations

Destructive operations require an exact confirmation phrase, sent as `confirm` in the JSON
body or as a `?confirm=` query parameter. A missing or wrong phrase returns
`428 Precondition Required` and the expected phrase in the error message.

| Operation | Phrase |
| --- | --- |
| Accept the EULA | `I-ACCEPT` |
| Force stop | `FORCE-STOP` |
| Move a world to the trash | the world's id |
| Permanently delete a trashed world | `DELETE-PERMANENTLY` |
| Restore a backup | `RESTORE` |
| Delete a backup | `DELETE` |
| Cancel terrain generation | `CANCEL` |
| Install a server update | `UPDATE` |

## Status codes

| Code | Meaning |
| --- | --- |
| `200` / `204` | Success |
| `400` | Validation error, unsafe path, rejected archive |
| `403` | Missing header, or a write that did not come through Ingress |
| `404` | Unknown world, backup, preset, file or endpoint |
| `409` | Conflicting state: already running, busy with another operation, server stopped, EULA not accepted, JAR or plugin missing, not enough disk |
| `428` | Missing confirmation |
| `500` | Unexpected failure |

Errors are `{"error": "...", "status": 409}`. Secrets are redacted from messages.

## Status and telemetry

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/status` | Everything the dashboard needs on load: server state, active world, settings, JAR, bridge, generation, backup summary, warnings |
| `GET` | `/api/stats` | System, process, JVM and cached size metrics |
| `GET` | `/api/players` | Player list, online and maximum counts, and which source they came from |
| `GET` | `/api/console?after=<seq>&limit=<n>` | Console history; `after` is the last sequence number the client has |
| `GET` | `/api/events` | Server-Sent Events stream (see below) |
| `GET` | `/api/audit?limit=<n>&prefix=<action>` | Audit entries |
| `GET` | `/api/journal?limit=<n>` | Recovery journal entries |

## Server control

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/server/start` | — |
| `POST` | `/api/server/stop` | `{"force": false, "confirm": ""}` |
| `POST` | `/api/server/restart` | — |
| `POST` | `/api/server/command` | `{"command": "list"}` |
| `POST` | `/api/server/eula` | `{"accepted": true, "confirm": "I-ACCEPT"}` |
| `POST` | `/api/server/maintenance` | `{"enabled": true}` |
| `GET` | `/api/server/versions?version=1.21.4` | Installed JAR (including `required_java`, `java_runtimes`, `java_supported`), available versions and the newest build |
| `POST` | `/api/server/install` | Installs the newest stable build when none is present |
| `POST` | `/api/server/update` | `{"version": "1.21.4", "build": 0, "confirm": "UPDATE"}` (`build: 0` means newest stable) |
| `GET` | `/api/server/flavours` | Available server flavours, their capabilities, which are installed and whether a switch is currently possible |
| `GET` | `/api/mods` | Installed mods/plugins, packs, loader info |
| `GET` | `/api/mods/search?q=` | Modrinth search for the active flavour |
| `GET` | `/api/mods/updates` | Update check for managed entries |
| `POST` | `/api/mods/install` | `{"project": "luckperms"}`, SHA-512 verified |
| `POST` | `/api/mods/packs/{id}` | Install a curated pack |
| `DELETE` | `/api/mods/{file}` | Remove one jar |
| `POST` | `/api/server/flavour` | `{"flavour": "bta", "confirm": "bta"}` - the confirmation is the flavour name. Minecraft must be stopped |

Version data comes from PaperMC's v3 API. A build is refused with `409` when it declares a
Java feature release the container does not provide; that check runs after the download and
checksum verification but before the JAR is swapped.

Console commands are single-line only: a line break, control character or a command longer
than 512 characters is rejected.

## Configuration

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/config` | — |
| `PUT` | `/api/config` | `{"values": {"view_distance": 7, "difficulty": "normal"}}` |
| `GET` | `/api/config/files` | — |
| `GET` | `/api/config/files/{name}` | — |
| `PUT` | `/api/config/files/{name}` | `{"content": "...", "sha256": "<digest the editor loaded>"}` |
| `GET` | `/api/config/files/{name}/snapshots` | — |
| `POST` | `/api/config/files/{name}/restore` | `{"snapshot": "server.properties.20260730T101500.bak"}` |
| `GET` | `/api/settings` | Controller settings plus redacted add-on options |
| `PUT` | `/api/settings` | Partial patch; unknown fields are rejected |

`{name}` must be one of the allow-listed files (`server.properties`, `bukkit.yml`,
`spigot.yml`, `paper-global.yml`, `paper-world-defaults.yml`, `ops.json`,
`whitelist.json`). Sending `sha256` makes the write conditional: a `409` means the file
changed on disk since it was read.

Responses report `restart_required` when a change only takes effect after a restart.

## Presets

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/presets` | — |
| `POST` | `/api/presets` | A preset document (`id`, `name`, `description`, `knobs`, `settings`) |
| `GET` | `/api/presets/{id}/diff` | — |
| `POST` | `/api/presets/{id}/apply` | `{"override_user_changes": false}` |
| `DELETE` | `/api/presets/{id}` | Only user presets |

## Worlds

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/worlds` | — |
| `POST` | `/api/worlds` | `{"name": "survival", "seed": "", "notes": ""}` |
| `POST` | `/api/worlds/import` | `multipart/form-data` with `file` and optional `name` |
| `GET` | `/api/worlds/{id}` | — |
| `GET` | `/api/worlds/{id}/export` | Streams a ZIP archive |
| `POST` | `/api/worlds/{id}/clone` | `{"name": "survival-copy"}` |
| `POST` | `/api/worlds/{id}/rename` | `{"name": "New name"}` |
| `POST` | `/api/worlds/{id}/activate` | `{"backup": true, "restart": null}` |
| `POST` | `/api/worlds/{id}/archive` | `{"archived": true}` |
| `DELETE` | `/api/worlds/{id}?confirm=<id>` | Moves to the trash |
| `GET` | `/api/worlds/trash` | — |
| `POST` | `/api/worlds/trash/{name}/restore` | — |
| `DELETE` | `/api/worlds/trash/{name}?confirm=DELETE-PERMANENTLY` | Erases data |

`activate` returns `rolled_back: true` when the new world failed to start and the previous
one was put back.

## Backups

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/backups?limit=<n>` | Records plus the running operation |
| `POST` | `/api/backups` | `{"world_id": "", "kind": "manual", "label": "", "notes": "", "offline": false, "allow_live": false}` |
| `GET` | `/api/backups/health` | restic availability, repository size, snapshot count, last check |
| `POST` | `/api/backups/verify` | `{"read_subset": "5%"}`; empty checks structure only |
| `POST` | `/api/backups/retention` | Applies the configured retention rules |
| `POST` | `/api/backups/cancel` | Cancels the running operation when it is safe |
| `GET` | `/api/backups/{id}/preview` | Lists what a restore would put back |
| `POST` | `/api/backups/{id}/label` | `{"label": "", "notes": ""}` |
| `POST` | `/api/backups/{id}/restore` | `{"target_world_id": "", "skip_safety_backup": false, "confirm": "RESTORE"}` |
| `DELETE` | `/api/backups/{id}?confirm=DELETE` | Forgets the snapshot and prunes |

`{id}` accepts either the controller's record id or the restic snapshot id.

## Terrain generation

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/generation` | Job, parameters, live guard values and thresholds, plugin state |
| `GET` | `/api/generation/jobs?limit=<n>` | Job history |
| `POST` | `/api/generation/jobs` | Parameters (below) |
| `POST` | `/api/generation/estimate` | Same parameters; returns chunk count and storage range |
| `POST` | `/api/generation/jobs/{id}/pause` | — |
| `POST` | `/api/generation/jobs/{id}/resume` | — |
| `POST` | `/api/generation/jobs/{id}/cancel?confirm=CANCEL` | — |
| `GET` | `/api/generation/plugin?check=1` | Installed plugin, and the available release with `check=1` |
| `POST` | `/api/generation/plugin/install` | Downloads and verifies Chunky |

```json
{
  "world_id": "survival",
  "dimensions": ["world", "world_nether"],
  "shape": "square",
  "radius_blocks": 4500,
  "center_x": 0,
  "center_z": 0,
  "center_at_spawn": true,
  "border_radius_blocks": 4000,
  "safety_margin_blocks": 500,
  "profile": "gentle",
  "apply_world_border": false
}
```

Starting a job fails with `409` when Chunky is missing, the server is stopped, another job
is active, or the storage estimate does not fit in the free space.

## Event stream

`GET /api/events` is a Server-Sent Events stream. Each message uses the event type as its
SSE `event:` name and carries `{"seq", "type", "time", "data"}`. A comment heartbeat is
sent every 15 seconds, and a `stats_update` every three seconds.

```text
server_state          state, process state, activity, pid, players, exit code, crash count
server_log            one console line: {seq, time, stream, text}
stats_update          system, telemetry, cached sizes, server snapshot
player_join           {player}
player_leave          {player}
backup_progress       {id, percent, message}
restore_progress      {id, percent, message}
generation_progress   {job, world, dimension, status, progress, chunks, rate, pause_reason}
generation_paused     {job, reason}
generation_resumed    {job}
generation_completed  {job, status, detail, chunks, elapsed_ms}
worlds_changed        which world was created, activated, imported, trashed or restored
backups_changed       which backup was created or deleted
config_changed        which file or how many settings changed
settings_changed      controller settings or preset changed
warning               {source, message}
error                 {source, message}
```

Clients should treat `seq` as the ordering key and reconnect on error; the browser's
`EventSource` does that automatically.
