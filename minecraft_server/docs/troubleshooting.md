# Troubleshooting

Start with the **Activity** tab (journal and audit log) and the console. The add-on log tab
in Home Assistant shows the controller's own log.

## The server will not start

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The Minecraft EULA has not been accepted yet" | Expected on a fresh install | Dashboard → **Accept EULA**, type `I-ACCEPT` |
| "No server JAR is installed" | Paper was never downloaded | Dashboard → **Install PaperMC**, or Settings → Server version |
| Console shows `FAILED TO BIND TO PORT` | Another process owns 25565 | Stop the other server, or change `server_port` in the add-on options |
| "this server needs Java N but only Java … is installed" | The JAR needs a newer Java feature release than the image provides | Install a Paper build for an older Minecraft version, or update the add-on. The image ships Java 21 and 25 |
| Console shows `UnsupportedClassVersionError` | A JAR copied in by hand bypassed the launch check | Let the add-on install the JAR, or check the Settings tab for the required Java version |
| Start hangs, then "did not finish starting" | Very slow storage, or Paper waiting on something | Look at the console; on an SD card the first start of a new world can exceed the five-minute watchdog |
| "an orphaned Minecraft process could not be stopped" | A previous controller died and its child survived | Restart the add-on; the container restart clears it |

## The server is slow

Check the dashboard first: TPS below 19, MSPT above 40 ms or CPU temperature above 78 °C
each point somewhere different.

| Signal | Meaning | What helps |
| --- | --- | --- |
| High MSPT, normal CPU | One expensive thing per tick (entities, redstone, a plugin) | Lower simulation distance and entity activation ranges; the Low Power preset |
| High CPU across all cores | The Pi is simply out of headroom | Lower view distance, fewer players, Low Power preset, stop terrain generation |
| Temperature above 78 °C, frequency ratio below 0.75 | Thermal throttling | Improve cooling; the dashboard shows "throttling" when the clock drops |
| Free memory low, heap near maximum | Heap too large or too small | Keep the heap at or below 3584 MB; lower view distance before raising the heap |
| Stutter when players join | Chunk streaming | Lower `chunk_send_rate` and `chunk_load_rate` |
| Occasional long freeze | Autosave on slow storage | Lower `max_auto_save_chunks_per_tick`, keep `sync_chunk_writes` off, prefer SSD/NVMe |

Terrain that has been pre-generated with Chunky removes the single most expensive live
operation on a Pi: generating new chunks while a player walks.

## TPS, MSPT and heap show "—"

The bundled `McBridge` plugin is not connected. It is installed automatically into
`/data/runtime/paper/plugins`, needs Java 21 and reads two environment variables the
controller sets. Restart Minecraft after the plugin is first installed, then check the
console for "Management bridge enabled". If the console says the token could not be read,
delete `/data/secrets/bridge.token` and restart the add-on to regenerate it.

Everything else works without the plugin.

## Backups

| Symptom | Cause | Fix |
| --- | --- | --- |
| "PaperMC reports this API endpoint is gone (HTTP 410)" | The add-on is talking to PaperMC's retired v2 API | Update the add-on; current versions use the v3 (`fill.papermc.io`) API |
| "restic is not installed in this container" | The image is broken or was built without restic | Rebuild or reinstall the add-on |
| Backup refused: "could not flush the world" | The server did not confirm the flush in time | Retry; if it persists, back up offline, or accept a crash-consistent backup explicitly |
| "world saving is currently disabled" warning | A backup was interrupted | Startup recovery re-enables saving; if the server is running, `save-on` in the console does it immediately |
| Every backup stores the whole world again | Region files are being rewritten wholesale, for example by a plugin | Compare `added` versus `total` in the backups table; check what rewrites region files |
| Repository grows despite retention | Retention only forgets snapshots; pruning needs to run | Backups tab → **Apply retention now** |
| Restore failed and rolled back | The restored world did not start | Check the console for the real error; the previous world is back in place |

See [backup-recovery.md](backup-recovery.md) for manual recovery.

## Terrain generation

| Symptom | Cause | Fix |
| --- | --- | --- |
| "the server does not know the chunky command" | Chunky is installed but not loaded | Restart Minecraft |
| Generation will not start: not enough space | The measured estimate plus the safety margin exceeds free space | Reduce the radius, free space, or lower the storage safety margin |
| Free space "unknown", generation refuses | The container cannot read the filesystem statistics | Only happens outside Home Assistant OS (for example on a Windows development box) |
| Job pauses immediately | A guard is tripped | The **Terrain** tab shows every guard, its current value and its threshold |
| Job never resumes | Recovery thresholds are stricter than the pause ones, plus the empty-server delay | Wait, lower the thresholds, or resume manually |
| Job paused after an add-on restart | Deliberate | Review the numbers and press **Resume** |
| Progress stays at 0% | Chunky's output format changed | The parser is tolerant, but check the console; the plugin may need updating |

## Worlds

| Symptom | Cause | Fix |
| --- | --- | --- |
| Import rejected as unsafe | Absolute paths, `..`, symlinks, or an implausible compression ratio | Repack the world without those entries |
| "archive does not contain a Minecraft world" | No `level.dat` anywhere in the archive | Include the world folder itself, not just region files |
| Only the Overworld was imported | The archive had no Nether or End | Minecraft generates the missing dimensions on first load |
| World switch rolled back | The new world failed to start | Console shows why; the old world is active again |
| Cannot delete the active world | By design | Switch to another world first |
| A world folder appeared that the add-on did not create | Fine | It is listed with defaulted metadata and stays usable |

## Home Assistant entities

| Symptom | Cause | Fix |
| --- | --- | --- |
| No entities appear | MQTT disabled, or no broker | Enable `mqtt_enabled`, install the Mosquitto add-on, or configure an external broker |
| Entities are "unavailable" | The add-on is stopped, or the broker connection dropped | The availability topic reflects the real state; check the add-on log |
| A button does nothing | The command was rejected | The audit log records `mqtt.<action>` with the reason |
| Destructive actions are missing | Deliberate | Force stop, delete and restore require a typed confirmation in the UI |

## The add-on itself

| Symptom | Cause | Fix |
| --- | --- | --- |
| "state database failed its integrity check" | Storage corruption | The broken file is moved to `controller.db.corrupt-<time>` and a fresh one is created; worlds and backups are unaffected |
| "state-changing requests must arrive through Home Assistant Ingress" | You are calling the API directly | Use the Ingress URL, or enable `allow_direct_access` |
| The UI loads but shows "The controller is not responding" | The controller crashed | Check the add-on log; the container restarts it |
| Unfinished operations logged at startup | The add-on was interrupted | Reconciliation handles them; the Activity tab shows what was done |
| Controller memory above ~100 MB | Unexpected | Report it; steady state is a few tens of megabytes |
