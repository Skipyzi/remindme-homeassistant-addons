# Changelog

All notable changes to this add-on are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are semantic.

## 1.7.0 - 2026-08-19

Three changes aimed at the thing a Raspberry Pi actually struggles with: sharing
four cores, one memory bus and one disk with Home Assistant.

### Added

- **The server is pinned away from core 0**, which stays with Home Assistant and
  this controller, so a busy server no longer delays automations and a busy Home
  Assistant no longer costs ticks. The mask is set on the launching thread and
  inherited across fork, which needs no extra container privilege: setting it on
  the running child would need CAP_SYS_NICE (dropped by container runtimes) and
  wrapping the launch in taskset would need util-linux (not in the base image).
  Turn it off with the new `pin_server_cpus` option.
- **A memory ceiling measured on your machine.** The Settings hint and a
  dashboard warning now name the largest heap this machine should give the JVM,
  reserving room for Home Assistant, the OS and - the part that is easy to
  forget - the page cache that keeps world file IO fast. Maxing the heap trades
  invisible cache for visible autosave stutter.
- **The dashboard says what /data sits on.** An SD card is the most common cause
  of a stuttering Pi server; it is now named next to the free space, with a
  warning banner, instead of leaving the operator to guess.

### Changed

- **Backup verification samples instead of re-reading everything.** A full
  `restic check --read-data` after every backup is an IO storm at exactly the
  moment players are online; the after-write check now verifies the structure
  fully and re-reads 5% of the data, which still covers the repository over
  twenty backups. A full check remains available on the Backups page.

## 1.6.0 - 2026-08-19

### Added

- **Mods and plugins from Modrinth.** A new Mods tab searches Modrinth for content that
  fits the running server - Paper plugins (including everything published for Bukkit and
  Spigot), Fabric mods for the Babric flavour - filtered to server-side content and, for
  Paper, to the installed Minecraft version. Every file is verified against the SHA-512
  Modrinth publishes, comes only from Modrinth's own CDN, and lands with an audit entry
  and a restart-required flag; nothing restarts by itself. Jars added by hand are listed
  and removable too. One click checks every managed entry for updates.
- **Curated packs**: small vetted sets per flavour - an admin toolkit for Paper
  (LuckPerms, CoreProtect, EssentialsX, BlueMap) and a mod foundation plus content picks
  for Babric (HalpLibe, Catalyst, and the most-downloaded server-side BTA mods). Per this
  add-on's standing rule, no "performance cleaner" plugins in any of them.
- Plain BTA explains that mods need the Babric flavour instead of showing an empty page.

### Changed

- **The interface got its own voice.** Everything the machine says - states, labels,
  numbers, file names - is set in the system's monospace face (terminal heritage, no font
  download), and the status palette is drawn from the game's ores: emerald runs, gold
  warns, redstone fails, lapis informs, amethyst works.
- **The state seam**: a strip of pixel blocks under the header whose colour is the server
  state, visible from every tab. It marches while anything is in flight and holds still
  at rest; reduced-motion preferences stop the animation.
- The ten tabs are grouped by what they touch: run / world / tune / system.

## 1.5.0 - 2026-08-19

### Added

- **Better than Adventure! 8.x.** BTA installs now come from the project's official CDN
  (`downloads.betterthanadventure.net`), whose manifest carries the whole history from
  1.7.4 to 8.0.1. The GitHub repository the add-on previously installed from stopped
  publishing at 7.3_04 while the project moved on. The CDN publishes no checksums, so the
  installer computes the SHA-256 of the download from the first-party host and records it
  in the audit log; every source that does publish a checksum is still verified against it
  and refused on mismatch.
- **A third flavour: BTA with Babric**, the Fabric-loader build of Better than Adventure
  that supports mods. It installs the official server bundle (launcher, libraries, base
  mods) from Turnip Labs' releases, digest-verified, with every redirect hop checked.
  Bundle updates replace only the files the bundle owns - `libraries/` and the launcher -
  and never touch `server.properties`, the world, or mods you added yourself; `mods/` is
  merged, not replaced. Rollback keeps the previous bundle zip and re-extracts it.

### Fixed

- Literal "null" text no longer appears in the Settings flavour and version cards (and a
  null-safe `append` helper now guards every conditional element in the UI, so the class
  of bug is gone rather than the instance).

## 1.4.0 - 2026-08-19

### Changed

- **First run is one guided flow.** The dashboard walks through flavour, version,
  the EULA and install-and-start in a single card, instead of scattering those
  steps between the dashboard and two Settings sections. A first install no
  longer demands a typed confirmation phrase - it replaces nothing.
- **The server explains what it is doing.** The dashboard shows the controller's
  current step ("downloading 26.2 build 112", "backing up survival before the
  update") with a ticking elapsed time while anything is in flight, and a plain
  crash banner when the server exits unexpectedly.
- **Confirmations follow one rule.** Recoverable actions (update, restore, world
  switch, flavour switch) state their consequences and how they can be undone,
  and take one click. Only irreversible deletions (purging a world, deleting a
  backup) require typing the name of the thing being destroyed.

### Fixed

- The setup card no longer loses the EULA checkbox and version selection when a
  live stats update repaints the dashboard.
- The web UI is served with `Cache-Control: no-cache`, so browsers revalidate
  the ES modules after an add-on update instead of running half the old UI and
  half the new one.
- The "no server installed" and "EULA not accepted" warning banners are gone;
  the setup flow is the single voice for first run (one of them pointed at a
  "Server tab" that never existed).

## 1.3.0 - 2026-07-31

The PaperMC v3 API fix and the dual-JRE change below were released as 1.1.0 and 1.2.0
without their own changelog sections; they are listed here because this is the first
version whose changelog matches what shipped.

### Added

- **Better than Adventure! support.** The add-on can now run BTA, a continuation of
  Minecraft Beta 1.7.3, alongside PaperMC. The flavour is chosen in Settings and switching
  needs the server stopped plus a typed confirmation.
  - Releases are installed from the project's GitHub releases, verified against the
    SHA-256 asset digest GitHub publishes, with every redirect hop checked against an
    allow-list.
  - Each flavour has its own runtime directory, worlds, configuration, installed server
    and active world, so switching moves no data and is reversible.
  - Features BTA does not have are hidden rather than offered: no Bukkit plugins, no
    Chunky pre-generation, and TPS and heap come from the process instead of from the
    bridge plugin.
  - BTA takes no launch arguments, so the listen port is written into `server.properties`,
    and its world is bound by a link in the runtime directory rather than by
    `--world-container`.
- Backups record which flavour they were taken from, and a restore across flavours is
  refused: the McRegion and Anvil world formats cannot be read by each other's server.
- Pre-release versions can be offered in the version list with a new toggle in Settings.
  They stay hidden by default.

### Changed

- The Minecraft process runs as an unprivileged user instead of root, which is what the
  server's own startup warning asks for. Set `run_server_as_root` to keep the old
  behaviour. The controller itself still runs as root: it owns `/data` and signals the JVM.
- The dashboard's install button says it installs the newest stable build and points at
  Settings for choosing a version, which was there all along but hard to find.
- Worlds are stored under `/data/worlds/<flavour>/`. An existing installation's worlds are
  moved into `/data/worlds/paper/` once, on the first start after the update.

### Fixed

- **The backup repository is never re-initialised.** `restic init` was run whenever
  `restic cat config` failed for any reason, not only when the repository was missing.
  A transient failure therefore wrote a fresh config and key over a healthy repository
  and made every snapshot in it unreadable. An existing repository that cannot be opened
  is now reported instead.
- A data race in the terrain-generation manager: the console goroutine wrote job progress
  while `startDimension`, `Pause`, `Resume` and `Cancel` read the same fields without the
  lock. Found by running the suite under the race detector for the first time.
- The "server should be running" marker is cleared before the process state changes, so
  nothing can observe a crashed server that still claims it should be running.
- Two tests assumed Windows path and redirect behaviour and failed on Linux, which is the
  only platform the add-on runs on. `Confine` now rejects a drive-letter prefix on every
  platform.
- PaperMC version and build discovery now uses the v3 (`fill.papermc.io`) API. The v2 API
  was retired and answers HTTP 410, which made the update page report
  "PaperMC API returned HTTP 410" and offer no builds. Download URLs now come from the
  build metadata and are restricted to PaperMC's own hosts.
- Version lists are sorted numerically, so 1.21.11 no longer sorts below 1.21.4, and
  pre-releases are left out of the selectable versions.

### Added

- The image bundles Java 21 and Java 25, and the controller reads `version.json` from the
  server JAR to launch with the runtime that build declares. Minecraft 26.x requires Java
  25, which a Java-21-only image could not run.
- A build that needs a Java release the container does not have is refused before the JAR
  is swapped, and the Settings tab shows the required and available Java versions.

### Changed

- Base image moved to the Alpine 3.23 Home Assistant base, the first with both
  `openjdk21-jre-headless` and `openjdk25-jre-headless`.
- Both build stages now run on the build host and cross-compile, so an aarch64 image no
  longer compiles Go and Java under emulation.

## 1.0.0 - 2026-07-30

First release.

### Added

- Home Assistant OS add-on for aarch64 and amd64 with an Ingress management interface that
  stays available while Minecraft is stopped.
- PaperMC process supervision: live console, bounded history, crash detection with exit
  codes, graceful stop with SIGTERM/SIGKILL escalation, confirmed force stop, optional
  crash restart with backoff, duplicate-process and orphan handling, persistent runtime
  state.
- Dashboard with live server and system statistics over Server-Sent Events, including TPS,
  MSPT, JVM heap, loaded chunks, entity counts, Raspberry Pi temperature and throttling,
  disk, world and backup-repository sizes.
- `McBridge` Paper plugin that pushes telemetry over a Unix domain socket with token
  authentication; no network port is opened.
- Structured configuration editor plus a guarded raw editor for `server.properties`,
  `bukkit.yml`, `spigot.yml`, `config/paper-global.yml`,
  `config/paper-world-defaults.yml`, `ops.json` and `whitelist.json`, with format
  validation, pre-change snapshots and atomic writes.
- Six preset overlays (Low Power, Balanced, Performance, Creative, Terrain Generation,
  Maintenance) with a mandatory diff and preservation of manual changes.
- World management: create, import (ZIP, with strict archive validation), export, clone,
  rename, archive, switch with automatic rollback, trash and confirmed permanent deletion.
- Incremental, deduplicated backups through restic, including the
  save-off/flush/hardlink/save-on pipeline, retention rules, labels, verification, restore
  preview, and restores that stage, validate, swap atomically and roll back.
- Chunky terrain pre-generation with checksum-verified installation, persisted jobs,
  sequential dimensions, measured storage estimation, world-border comparison and guards
  for players, TPS, MSPT, temperature, system load, allowed hours and free disk.
- Home Assistant entities over MQTT discovery, routed through the same command,
  validation and audit path as the web UI.
- Scheduled restarts with in-game warnings, scheduled backups, idle shutdown and opt-in
  scheduled PaperMC updates.
- Controlled PaperMC updates with checksum verification, backup, atomic JAR swap, health
  check and rollback.
- Recovery journal, audit log (database plus plain text), startup reconciliation and
  corrupted-database recovery.
- Unit and integration tests using mocked Paper and restic binaries, plus a manual
  Raspberry Pi 5 test plan.
