# Changelog

All notable changes to this add-on are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are semantic.

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
