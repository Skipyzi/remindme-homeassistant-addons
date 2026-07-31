# Multi-flavour Minecraft server support — design

Date: 2026-07-31
Status: implemented
Supersedes nothing; extends `2026-07-30-home-assistant-minecraft-server-design.md`.

## Problem

The add-on runs PaperMC. The user asked for Better than Adventure! (BTA), a continuation
of Minecraft Beta 1.7.3, and raised two smaller points that turned out to be related:
the version picker existed but was unreachable from where you would look for it, and the
server logs the usual "running as an administrative or root user" warning.

BTA is not a variant of Paper. It is a different server:

| | PaperMC | BTA 7.3 |
| --- | --- | --- |
| Base | current Minecraft, Bukkit lineage | fork of Beta 1.7.3 |
| Launch arguments | `--nogui`, `--port`, `--world-container` | none; `main` ignores `args` |
| Listen port | launch argument | `server-port` in `server.properties` |
| World format | Anvil, `world` / `world_nether` / `world_the_end` | McRegion, one directory with the other dimensions nested inside it |
| Plugins | Bukkit/Spigot | none |
| EULA | `eula.txt` required | no such file |
| Console | `save-all flush`, `save-off`, `save-on` | Brigadier: `save all`, `save off`, `save on` |
| Ready line | `Done (12.345s)! For help` | `Done (3524571348ns)! For help` |
| Bytecode | current | class file 52 (Java 8), runs on the bundled Java 21 |
| Distribution | `fill.papermc.io` v3 API | GitHub releases, asset digest as checksum |

So the two cannot share a runtime directory, a world directory, an installed JAR or a
configuration file set, and a backup of one is not restorable into the other.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where flavour differences live | `adapter.Backend`, extended with `Capabilities` | The interface already existed for exactly this; capabilities let the managers ask "can this server do X" instead of testing for a name. |
| Switching at runtime | `flavours.Switchable`, an `adapter.Backend` holding an atomic pointer | Every manager keeps the single value it was constructed with. Switching is a pointer swap, not a rebuild of the controller and not a restart of the add-on. |
| Path layout | `runtime/<flavour>/`, `worlds/<flavour>/<id>/`; `Paths` carries a shared flavour reference | `Paths` is passed by value into every manager, so the active flavour has to live behind a pointer for a switch to reach them. |
| Existing installations | one-time move of `worlds/<id>` into `worlds/paper/<id>`, guarded by a `.layout` marker | Everything that existed before was Paper. A rename is atomic and cheap; copying gigabytes of world data is not. |
| Per-flavour settings | parked in `settings.per_flavour` on switch, restored on switch back | The active world, installed version and EULA acceptance belong to one flavour. Losing them on every switch would make switching destructive in practice. |
| Binding the active world | `BindContainerArg` (Paper) or `BindLevelLink` (BTA) | Paper takes `--world-container`, which is atomic and moves nothing. BTA only looks next to its working directory, so the controller points a link there instead. Still no data movement; the link is rewritten on switch. |
| Refusing to clobber | a real directory where the level link belongs is an error | Replacing it would be deleting somebody's world. |
| BTA install source | GitHub releases API, SHA-256 from the asset `digest` field | GitHub publishes a per-asset digest, so the checksum requirement holds without trust-on-first-use. Asset names differ between releases (`bta-7.2-server.jar`, `bta.v7.3_04.server.jar`, `better-than-adventure-7.1.Prerelease.2-server.jar`), so the match is on prefix and suffix. |
| Redirects | every hop checked against the allow-list | GitHub serves assets by redirecting to a storage host. Checking only the first URL would make the allow-list decorative. |
| Backups across flavours | recorded per snapshot (DB column plus a restic tag), restore refused across | An McRegion world handed to a modern server, or the reverse, produces a world that does not open. Better a refusal than a corrupt restore. |
| Restic staging path | unchanged for Paper, `live/<flavour>/<world>` otherwise | The staging path is what restic uses to find the parent snapshot. Changing Paper's would break the dedup chain of every existing repository. |
| Knob catalog | separate list per flavour | Even the shared settings differ: `default-gamemode` against `gamemode`, difficulty as a number against an enum, and most Paper tuning has no counterpart. |
| Unprivileged server | dedicated `minecraft` user (uid 1000) in the image; controller stays root | The controller owns `/data` and signals the JVM, so it needs root. The JVM does not, and running it as root is what the warning is about. `run_server_as_root` restores the old behaviour. |
| Ownership | the runtime, worlds and run directories are given to that user, skipped when already owned | One `stat` per start after the first, instead of a walk of every world. |
| Pre-releases | opt-in setting, off by default | Asked for; a home server should not be steered onto a release candidate by accident. |

## What each flavour reports

`adapter.Capabilities` is the contract: `BukkitPlugins`, `BridgeTelemetry`,
`TerrainGeneration`, `EULAFile`, `ServerPortArg`, `WorldBinding`, `Dimensions`, `Notes`.
A `false` means the feature *cannot* work, so the UI hides it instead of offering
something that will fail. With BTA selected the Terrain tab says pre-generation needs a
plugin that does not exist for it; the bridge plugin is not installed; the Configuration
tab lists BTA's own files, including its plain-text `ops.txt` and `white-list.txt`
(a new `lines` file format).

## Switch sequence

Minecraft stopped, supervisor lease held, flavour name typed as confirmation:

1. journal `flavour_switch`
2. park the current flavour's state, restore the target's (`Settings.SwitchFlavour`)
3. swap the backend pointer, repoint `Paths`
4. `EnsureLayout`, seed default properties (writing the listen port when the backend has
   no argument for it), create the list files, pick an active world
5. journal done, audit

Failing at step 2 leaves both the recorded state and the on-disk state on the old flavour.

## Verification

- BTA's console grammar, property keys, console commands and class-file version were read
  out of the real `bta.v7.3.server.jar` rather than guessed.
- The install source is exercised against the live GitHub API in an opt-in test: 12
  versions discovered, newest `7.3_04`, download through the redirect, published digest
  matches the 5,064,161-byte JAR.
- Unit tests cover the console grammar, capabilities, the version and asset patterns,
  pre-release opt-in, the redirect check, the layout migration, per-flavour settings, the
  level link (including the refusal), and the switch itself.
