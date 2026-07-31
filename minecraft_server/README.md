# Minecraft Server add-on

Runs and manages an optimized Minecraft server on Home Assistant OS, with a management web
interface behind Ingress. Built for a Raspberry Pi 5 with 8 GB of RAM that also runs Home
Assistant.

Two server flavours are supported: [PaperMC](https://papermc.io/) for current Minecraft,
and [Better than Adventure!](https://www.betterthanadventure.net/) for its continuation of
Beta 1.7.3. Each keeps its own worlds, configuration and installed server, so switching
between them moves no data and is reversible.

The management interface keeps running while Minecraft is stopped, so the add-on is also
how you start the server in the first place.

## What it does

- **Server flavours** — PaperMC or Better than Adventure!, chosen in the UI. Features a
  flavour does not have (plugins, terrain pre-generation, in-server telemetry) are hidden
  rather than offered, and backups are tied to the flavour they were taken from.
- **Process supervision** — the server runs as a child of the controller: live console,
  bounded log history, crash detection with exit codes, graceful stop with escalation,
  optional crash restart, no duplicate servers.
- **Configuration** — structured forms for the settings that matter on a Pi, plus a
  guarded editor for `server.properties`, `bukkit.yml`, `spigot.yml`, the Paper configs,
  `ops.json` and `whitelist.json`. Every write is validated, snapshotted and atomic.
- **Presets** — Low Power, Balanced, Performance, Creative, Terrain Generation and
  Maintenance, applied as overlays and always shown as a diff first. Manual changes are
  remembered and never silently reverted.
- **Worlds** — create, import, export, clone, rename, archive, switch and delete world
  sets (Overworld + Nether + End together). Switching rolls back automatically if the new
  world fails to start; deleting moves to a trash directory first.
- **Backups** — incremental, deduplicated [restic](https://restic.net/) snapshots.
  Live backups disable saving, flush the world, take a hardlink snapshot and re-enable
  saving in well under a second. Restores stage, validate, swap atomically and roll back.
- **Terrain pre-generation** — [Chunky](https://modrinth.com/plugin/chunky) driven from
  the console, with guards that pause when a player joins, when TPS drops, when the Pi
  gets hot or busy, outside the allowed hours, and that cancel when the disk fills up.
- **Home Assistant entities** — sensors, buttons and selects over MQTT discovery, routed
  through the same validation and audit trail as the web UI.
- **Unprivileged server process** — the controller keeps root to manage `/data`, and the
  Minecraft process is dropped to an ordinary user, which is what the server's own
  "running as root" warning asks for.

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on store**, open the three-dot
   menu and choose **Repositories**.
2. Add `https://github.com/skipyzi/remindme-homeassistant-addons`.
3. Install **Minecraft Server**, then start it. The add-on starts with Minecraft stopped.
4. Open the add-on's **Web UI** (Ingress). Accept the Minecraft EULA — the add-on never
   does this for you — then install the PaperMC JAR from the dashboard and press **Start**.
5. Forward TCP port `25565` on your router only if you want players from outside your
   network. Remove the port mapping in the add-on's network settings to keep the server
   LAN-only.

Minecraft data lives in the add-on's `/data` volume and is included in Home Assistant
add-on backups. The add-on's own world backups are separate and are described in
[docs/backup-recovery.md](docs/backup-recovery.md).

## Recommended settings for a Raspberry Pi 5 (8 GB)

| Situation | Preset | Heap | View / simulation distance |
| --- | --- | --- | --- |
| Home Assistant is busy, up to 5 players | Low Power | 2048 MB | 5 / 4 |
| Everyday use, up to 10 players | Balanced | 3072 MB | 7 / 5 |
| Minecraft is the priority, active cooling, NVMe | Performance | 3584 MB | 9 / 6 |
| Pre-generating terrain | Terrain Generation | 3584 MB | 4 / 3 |

Keep the maximum heap at or below 3584 MB. Home Assistant, the add-on itself and the page
cache all need memory; a bigger heap on an 8 GB board makes the whole system slower, not
the server faster.

## Documentation

| Document | Contents |
| --- | --- |
| [DOCS.md](DOCS.md) | Add-on options, the management interface, first-run walkthrough |
| [docs/api.md](docs/api.md) | REST API and event stream reference |
| [docs/backup-recovery.md](docs/backup-recovery.md) | Backup model and manual recovery, including without the add-on |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes and fixes |
| [docs/security.md](docs/security.md) | Security model and boundaries |
| [docs/development.md](docs/development.md) | Local development, tests, ARM64 builds |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Support and limitations

- Java Edition only; no proxy (Velocity/BungeeCord) setups.
- One server instance per add-on installation.
- The image bundles Java 21 and Java 25 because Minecraft needs different feature
  releases per version (the 1.21 line runs on 21, the 26.x releases declare 25).
  The controller reads the requirement out of the server JAR and launches with the
  matching runtime; a build that needs something newer is refused with an
  explanation instead of failing to boot.
- Plugins other than Chunky and the bundled telemetry bridge are your responsibility:
  drop them in `/data/runtime/paper/plugins` and restart.
- The container is Alpine based, so Java runs against musl. Paper works, but if you hit a
  native-library problem with an unusual plugin, that is the first thing to suspect.

## Licence

MIT — see [LICENSE](LICENSE). Minecraft itself is licensed by Mojang; you must accept the
[Minecraft EULA](https://aka.ms/MinecraftEULA) to run a server.
