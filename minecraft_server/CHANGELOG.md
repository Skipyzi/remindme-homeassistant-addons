# Changelog

All notable changes to this add-on are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are semantic.

## Unreleased

### Fixed

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
