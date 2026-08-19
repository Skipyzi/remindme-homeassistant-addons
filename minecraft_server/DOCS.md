# Minecraft Server add-on documentation

## First run

1. Start the add-on. Minecraft stays stopped; only the controller runs.
2. Open the Web UI through Ingress.
3. **Accept the EULA.** You have to type `I-ACCEPT`. The add-on never accepts Mojang's
   licence on your behalf, and Minecraft will not start until you do.
4. **Install PaperMC.** The dashboard offers this when no JAR is present. The download is
   verified against the SHA-256 published with the build.
5. Press **Start**. The console shows the server booting; the state pill turns *running*
   when Paper reports `Done`.
6. Optionally apply a preset (**Presets** tab) and restart to pick up the changes.

A world called `survival` is created automatically on first start. Additional worlds are
managed on the **Worlds** tab.

## Add-on options

These live in the add-on's configuration page and need an add-on restart. Everything you
change day to day lives in the web UI instead and takes effect without restarting the
add-on.

| Option | Default | Meaning |
| --- | --- | --- |
| `server_flavour` | `paper` | Which server to run on a fresh installation: `paper` or `bta`. After the first start the web UI owns this; see [Server flavours](#server-flavours). |
| `server_port` | `25565` | Port Minecraft listens on. Remove the port mapping in the network section to keep the server LAN-only. |
| `memory_min_mb` | `1024` | Initial JVM heap (`-Xms`). |
| `memory_max_mb` | `3072` | Maximum JVM heap (`-Xmx`). Keep at or below 3584 on an 8 GB Pi. |
| `jvm_flags_profile` | `balanced` | `low_power`, `balanced`, `performance` or `custom`. |
| `jvm_flags_custom` | empty | Used only with `custom`. Heap flags are rejected; they are managed above. |
| `paper_version` | empty | Minecraft version to install. Empty means the newest stable release. |
| `run_server_as_root` | `false` | Keep the Minecraft process running as root. Off means the server runs as an unprivileged user, which is why the "running as root" warning is gone. |
| `auto_restart_on_crash` | `false` | Restart after an unexpected exit. Gives up after three consecutive crashes. |
| `stop_timeout_seconds` | `120` | Grace period before SIGTERM, then SIGKILL. |
| `mqtt_enabled` | `true` | Publish Home Assistant entities over MQTT discovery. |
| `mqtt_host` / `mqtt_port` / `mqtt_username` / `mqtt_password` | empty | Only needed for an external broker. Empty uses the broker the Supervisor offers. |
| `mqtt_discovery_prefix` | `homeassistant` | Must match the MQTT integration's discovery prefix. |
| `chunky_source` | `modrinth` | Where Chunky is downloaded from: `modrinth` (hash from release metadata), `url` (your URL plus your checksum) or `manual` (no downloads). |
| `chunky_download_url` / `chunky_sha256` | empty | Required when `chunky_source` is `url`. |
| `allow_direct_access` | `false` | When off, requests that do not arrive through Ingress may read status but never change anything. |
| `log_level` | `info` | Controller log verbosity in the add-on log tab. |

## Server flavours

The add-on can run more than one kind of server. The flavour is chosen in **Settings →
Server flavour**; switching needs Minecraft stopped and the flavour name typed as
confirmation.

| | PaperMC | Better than Adventure! | BTA with Babric |
| --- | --- | --- |
| Minecraft | current releases | a fork of Beta 1.7.3 | the same fork, with the Fabric loader |
| Source | `fill.papermc.io`, checksum from the build metadata | the project's own CDN; no published checksum, so the download's SHA-256 is computed and recorded | Turnip Labs' releases, digest-verified server bundle |
| Mods / plugins | Bukkit/Spigot plugins | none | Fabric mods in `mods/` |
| Terrain pre-generation | Chunky | not available | not available |
| TPS and heap telemetry | from the bridge plugin | from the process only | from the process only |
| World format | Anvil, three directories per world set | McRegion, one directory | same as BTA, same version only |
| Listen port | launch argument | written into `server.properties` | written into `server.properties` |
| Configuration | `server.properties`, Bukkit/Spigot/Paper files, JSON lists | `server.properties` and text lists | `server.properties` and text lists |

Each flavour keeps its own runtime directory, its own worlds, its own installed server
and its own active world, so **switching moves no data and is reversible**: switching back
finds everything exactly as it was left. Nothing is shared except the backup repository,
and every snapshot records the flavour it came from - restoring a PaperMC backup into a
BTA world (or the other way round) is refused, because the world formats cannot be read
across the two.

The features a flavour does not have are hidden rather than offered: with BTA selected the
Terrain tab explains that pre-generation needs a plugin that does not exist for it, and the
Configuration tab lists BTA's own settings.

Better than Adventure! runs on the Java 21 runtime in the image, and only contacts its own
stats API when you set a `stats-token`, which the add-on leaves empty.

## The management interface

### Dashboard

On a fresh installation the dashboard is a guided setup: pick the server flavour and
version, accept the EULA and press one button to install and start. While anything is in
flight the dashboard shows the controller's current step with an elapsed timer, so a long
download or world generation explains itself.

Live server state, players, TPS and MSPT, JVM heap, system CPU and memory, Raspberry Pi
temperature and throttling, free disk, world and backup-repository sizes, the current
terrain-generation job and the last console lines. Values arrive over a Server-Sent Events
stream; nothing polls.

Controls: start, graceful stop, restart, force stop (confirmed), maintenance mode, and
"back up now". Confirmations follow one rule everywhere: recoverable actions state their
consequences and take one click; only irreversible deletions require typing the name of
the thing being destroyed.

TPS, MSPT, heap and per-dimension chunk and entity counts come from the bundled `McBridge`
plugin. Without it, everything else still works and those fields read `—`.

### Console

The full console with a command input and history. Commands go to the server's standard
input and are written to the audit log. Controller actions appear inline, prefixed with
`>`, so causes and effects are visible together.

### Configuration

Structured forms for the settings the add-on manages, grouped by gameplay, performance,
entities, chunks and storage. Each field documents what it costs on a Pi and whether it
needs a restart. Changed values are marked with a bullet as *your* change, so applying a
preset later leaves them alone unless you ask otherwise.

Below that, an editor for the raw files:

```text
server.properties
bukkit.yml
spigot.yml
config/paper-global.yml
config/paper-world-defaults.yml
ops.json
whitelist.json
```

Writes are validated for their format, snapshotted into `/data/config/snapshots`, written
to a temporary file, flushed and renamed over the original. The editor refuses to save if
the file changed on disk since it was opened.

### Presets

Six built-in overlays; you can save your own or shadow a built-in one by using the same
identifier. Applying always shows a diff of every value that would change, which file it
lives in, and whether a restart is needed.

### Worlds

The Overworld, Nether and End are one *world set*, stored as
`/data/worlds/<id>/{world,world_nether,world_the_end}`. Switching worlds changes Paper's
`--world-container` argument, so no data is moved.

Switching: validate → optional backup → graceful stop → change configuration → start →
health check → automatic rollback to the previous world if the server does not come up.

Deleting moves the world to `/data/trash`. Permanent deletion is a second step that
requires typing `DELETE-PERMANENTLY`. The active world cannot be deleted, and never while
the server is running.

Imports accept a ZIP archive: they are extracted to staging, checked for absolute paths,
traversal segments, symbolic links, implausible compression ratios, excessive depth and
size, and only then installed. Exports stream a ZIP; exporting the active world while the
server runs produces a crash-consistent copy and says so.

### Backups

Separate from Home Assistant's add-on backups, because a world needs to be restorable on
its own and without restarting the add-on.

Live backup pipeline:

```text
save-off
save-all flush
hardlink snapshot into /data/staging/live/<world>
save-on
restic backup (deduplicating, compressing)
verify
remove staging
```

Saving is disabled only for the hardlink pass. If the flush cannot be confirmed, the
backup is refused unless you explicitly ask for a crash-consistent one, and the result is
labelled `live` instead of `flushed`. Saving is re-enabled on every failure path and again
during startup recovery.

Each backup records its kind (manual, scheduled, pre-world-switch, pre-restore,
pre-generation, post-generation, pre-update), a label, notes, size, newly added data,
duration, consistency and verification state. Retention (keep last / daily / weekly /
monthly) is applied after each backup and can be run manually.

Restore: verify the snapshot → back up what is there now → restore into staging →
validate the world → swap atomically → start → roll back if it does not come up.

### Terrain

Chunky is installed from the configured trusted source with its checksum verified. A run
is planned with a world, dimensions, shape, radius, centre, playable border radius and
safety margin. Before it starts you see the chunk count, a storage *range* measured from
your own world's region files, the free space, an estimated duration and a warning if the
playable border reaches past the generated area.

Profiles:

| Profile | Behaviour |
| --- | --- |
| Gentle | Only while empty, inside the allowed hours, respects every threshold. Backs up first. |
| Balanced | Ignores the hours window, higher thresholds, still pauses for players. |
| Maximum | Maintenance mode keeps players out, only temperature and disk limits apply, dimensions sequential, restart and backup afterwards. |

Guards are evaluated every five seconds. Pause and resume use different thresholds and a
minimum dwell time, so a job cannot flap. Low disk space cancels rather than pauses: a
full disk corrupts region files. A job survives an add-on restart and is adopted as
*paused* so you can review the numbers before resuming.

### Mods

Searches Modrinth for content that fits the running server: plugins for PaperMC
(everything published for Paper, Bukkit or Spigot, filtered to the installed Minecraft
version), Fabric mods for the Babric flavour. Client-only content is filtered out. Every
file is verified against the SHA-512 Modrinth publishes and comes only from Modrinth's
CDN; installs and removals are audited and take effect on the next server start.

Curated packs are small vetted sets per flavour - an admin toolkit for Paper, a mod
foundation and content picks for Babric. Jars you drop into the directory by hand are
listed as "added by hand" and can be removed here too. Plain BTA has no mod loader; the
tab explains that Babric is the same game with mods.

### Settings

Heap, JVM profile, stop timeout, crash restart, start-on-boot, daily restart (with in-game
warnings), daily backup, idle shutdown, retention, the generation safety policy, the
[server flavour](#server-flavours) and the server update workflow.

**Server version** is where you choose which version to install. The dashboard's install
button always takes the newest stable build; the dropdown here installs a specific one.
Pre-release versions are left out of the list unless you turn on *Offer pre-release
versions*.

Updates: check versions, back up, stop, swap the JAR atomically, start, verify, roll back
on failure. Automatic installation only happens if you enable scheduled updates.

Version data comes from PaperMC's v3 API (`fill.papermc.io`); the retired v2 API now
answers HTTP 410, and an add-on still using it cannot see any builds. Downloads use the
URL published in the build metadata, restricted to PaperMC's own hosts, and are verified
against the SHA-256 from that metadata.

### Java versions

Minecraft needs different Java feature releases per version: the 1.21 line runs on Java
21, the 26.x releases declare Java 25. The image ships both, and the controller reads
`version.json` out of the server JAR to pick the matching runtime. Consequences worth
knowing:

- Installing a build whose Java requirement this add-on cannot meet is refused *before*
  the JAR is swapped, so you never end up with a server that will not boot.
- The Settings tab shows what the installed JAR needs and what the image provides.
- Starting a JAR that was copied in by hand and needs something newer fails with a plain
  message rather than `UnsupportedClassVersionError`.

### Activity

The recovery journal (what the controller was doing, phase by phase) and the audit log
(who did what, and how it ended). The audit log is also plain text at
`/data/audit/audit.log`, readable with the Home Assistant file editor even if the
controller will not start.

## Home Assistant entities

With MQTT enabled the add-on publishes one device with:

```text
binary_sensor.minecraft_server_running
binary_sensor.minecraft_maintenance_mode

sensor.minecraft_state
sensor.minecraft_players_online
sensor.minecraft_tps
sensor.minecraft_mspt
sensor.minecraft_heap_used
sensor.minecraft_world_size
sensor.minecraft_backup_repository_size
sensor.minecraft_last_backup
sensor.minecraft_cpu_temperature
sensor.minecraft_generation_progress
sensor.minecraft_generation_rate

button.minecraft_start
button.minecraft_stop
button.minecraft_restart
button.minecraft_backup
button.minecraft_pause_generation
button.minecraft_resume_generation

select.minecraft_world
select.minecraft_preset
select.minecraft_generation_profile
```

Every entity also exposes the full state document as attributes (player list, uptime,
version, pause reason, free disk, throttling). Commands from Home Assistant go through the
same service as the web UI, so they are validated and audited identically. Destructive
actions (force stop, delete, restore, permanent delete) are deliberately *not* exposed as
entities: they require a typed confirmation.

## Data layout

```text
/data/
├── runtime/<flavour>/    server working directory (JAR, configs, plugins, logs)
├── worlds/<flavour>/<id>/  world sets plus meta.json, one tree per flavour
├── worlds/.layout        marker: worlds are nested per flavour
├── backups/repo/         restic repository
├── staging/              hardlink snapshots, restore staging, uploads
├── presets/              your presets
├── config/               controller settings and configuration snapshots
├── trash/                soft-deleted worlds
├── jars/                 staged and previous server JARs
├── secrets/              restic password, bridge token (0600)
├── run/                  bridge socket, pid file
├── audit/audit.log       human-readable operation log
└── controller.db         SQLite state
```

An installation created before flavours existed keeps its worlds directly under
`/data/worlds/`. They are moved into `/data/worlds/paper/` once, on the first start after
the update, before anything else reads them.

## Reliability

Every multi-step operation writes a journal row before touching the filesystem. On
startup the controller re-enables world saving, clears staging, rolls back interrupted
world switches and restores, marks interrupted generation jobs paused, terminates an
orphaned Minecraft process left by a previous controller, and recreates the state database
if it fails its integrity check (moving the broken file aside first).
