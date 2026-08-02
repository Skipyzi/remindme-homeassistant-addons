# Multi-flavour Minecraft server support — plan

Design: `docs/superpowers/specs/2026-07-31-minecraft-server-flavours-design.md`

## Phase 1 — flavour contract

- [x] `adapter.Capabilities`, `WorldBinding`, and `Capabilities`, `JarName`, `WorldArgs`,
      `FlagProfile` on `adapter.Backend`
- [x] JVM flag profiles moved to `adapter/javaflags` so every backend shares them
- [x] `flavours` registry and `flavours.Switchable`

## Phase 2 — BTA backend

- [x] `adapter/bta`: argv (no arguments), console grammar, Brigadier save commands,
      config files including the `lines` format, Pi-friendly defaults, no phone-home
- [x] `updates.Source` split: `PaperSource` (v3 fill API) and `BTASource` (GitHub
      releases, asset digest, redirect-checked download)

## Phase 3 — per-flavour state

- [x] `Paths` nested per flavour with a shared reference, `MigrateLayout` for existing
      installations
- [x] `Settings.Flavour`, `PerFlavour`, `SwitchFlavour`, `IncludePreReleases`
- [x] world binding by link for backends without a world-container argument
- [x] backups: flavour recorded, tagged, and cross-flavour restore refused
- [x] mcconfig allow-list and knob catalog follow the active backend

## Phase 4 — switching and UI

- [x] `commands.SwitchFlavour` with the flavour name as confirmation, plus
      `GET /api/server/flavours` and `POST /api/server/flavour`
- [x] Settings: flavour cards, pre-release toggle, flavour-aware version wording
- [x] Dashboard: install button names the flavour and points at Settings
- [x] Terrain tab explains itself when the flavour has no pre-generation

## Phase 5 — hardening and docs

- [x] `privdrop`: unprivileged server process, `run_server_as_root` option, image user
- [x] `server_flavour` and `run_server_as_root` add-on options
- [x] README, DOCS (flavour comparison, data layout, settings), CHANGELOG, API reference
- [x] tests: bta backend, BTA source, layout migration, per-flavour settings, level link,
      switch command; live API probe behind `MC_LIVE_API`

## Found on the way (fixed, out of the original scope)

- `EnsureRepo` re-initialised the restic repository whenever `restic cat config` failed,
  not only when the repository was missing, which could write a fresh key over a healthy
  repository and make every snapshot unreadable. Reproduced in the container.
- A data race in the generation manager, surfaced by running the suite under `-race` for
  the first time (it needs a C toolchain, which the development machine lacks; it was run
  in a Linux container instead).
- The crash path published the process state before clearing the "should be running"
  marker.
- Two tests assumed Windows behaviour and failed on Linux.

## Verified in the container

- aarch64 and amd64 images build; the image has the `minecraft` user (uid 1000) and both
  JREs.
- On amd64: BTA `7.3_04` installed with a matching checksum, started to `running`, the
  ready line detected, the world written through the level link into
  `/data/worlds/bta/survival/world`, all files owned by `minecraft`, graceful stop.
- Backup tagged `flavour:bta` and staged at `/data/staging/live/bta/survival`; restoring
  it after switching to Paper is refused with the flavour message.
- World switch relinks; flavour switch creates the Paper layout and switching back
  restores the BTA active world.
- Full suite passes under `-race` on Linux, twice.

## Not done

- The BTA path has not run on real aarch64 hardware; the arm64 image was only exercised
  under qemu, where the server was still starting when the check timed out.
- The symlink tests skip on Windows (no privilege); they run on Linux.
