# Manual test plan: Raspberry Pi 5 (8 GB)

Automated tests cover the logic with mocked Paper and restic. This plan covers what only
real hardware can: thermals, real chunk generation, real storage throughput and Home
Assistant integration.

Record the result of every step. Anything marked **must** is a release blocker.

## Environment

- Raspberry Pi 5, 8 GB, active cooling, SSD or NVMe over USB3 or PCIe
- Home Assistant OS, current release
- A Minecraft Java Edition client on the same network
- Optional: `stress-ng` through an SSH add-on for the thermal test

Baseline before starting: note Home Assistant's own CPU and memory use with the add-on
stopped.

## 1. Installation and first start

1. Add the repository, install the add-on. **Must** build for aarch64 without errors.
2. Start the add-on. **Must** reach "management interface listening" and stay running.
3. Open the Web UI through Ingress. **Must** load with the state `stopped`.
4. Confirm the dashboard shows CPU, memory, temperature and free disk from the real host.
5. Note the controller's memory use (dashboard, "Controller"). Expected: well under 100 MB.

## 2. EULA and installation of PaperMC

1. Press **Start** before accepting the EULA. **Must** be refused with a clear message.
2. Accept the EULA (type `I-ACCEPT`). Check `/data/runtime/paper/eula.txt` contains
   `eula=true`.
3. Install PaperMC from the dashboard. **Must** verify the checksum and report the build.
4. Start the server. **Must** reach `running`; the console shows `Done`.

## 3. Gameplay and telemetry

1. Join with the client. **Must** appear in the player list within a second or two.
2. Confirm TPS, MSPT, JVM heap, loaded chunks and entity counts are populated (the bridge
   plugin is connected).
3. Walk around for a few minutes with the dashboard open. TPS should stay at or near 20.
4. Leave the server; confirm the player list empties.

## 4. Configuration and presets

1. Change the view distance in the Configuration tab. **Must** report that a restart is
   required and mark the value as your own change.
2. Apply the **Balanced** preset. **Must** show a diff first, and **must** list the view
   distance as *your change* and keep it.
3. Apply it again with "also overwrite my changes". Confirm the view distance now matches
   the preset.
4. Restart, then verify in game (F3) that the view distance changed.
5. Open the raw `server.properties` editor, make a change, save. Confirm a snapshot appears
   and can be restored.
6. Write deliberately invalid YAML into `bukkit.yml`. **Must** be rejected and **must** not
   modify the file.

## 5. Worlds

1. Create a second world with a fixed seed.
2. Switch to it with "back up first". **Must** stop, switch, start, and show the new world.
   Verify in game that the seed matches (`/seed`).
3. Switch back.
4. Clone a world; confirm the copy has the same content and appears in the list.
5. Export a world; download the ZIP and open it locally. **Must** contain
   `world/level.dat`.
6. Import that ZIP as a new world. **Must** be accepted and validate.
7. Craft a hostile archive (`zip -y` with a symlink, or an entry named `../escape.txt`) and
   import it. **Must** be rejected and **must** not leave a world behind.
8. Delete a non-active world. **Must** move it to the trash; restore it; delete it again and
   permanently delete it (typing `DELETE-PERMANENTLY`).
9. Try to delete the active world while running. **Must** be refused.
10. Rollback test: stop the server, corrupt a world's `level.dat`
    (`truncate -s 0`), then switch to it. **Must** fail to start, roll back to the previous
    world, and start it again.

## 6. Backups

1. Take a manual backup while the server is running. **Must** complete with consistency
   `flushed`. In the console, the time between `save-off` and
   `Automatic saving is now enabled` **must** be under a second.
2. Take a second backup without playing. **Must** add far less data than the first
   (deduplication).
3. Play for ten minutes, then back up again. Added data should roughly match the region
   files you touched.
4. Take an offline backup. **Must** stop the server, back up, and start it again.
5. Verify the repository (structure), then run a deep verify at 5%. Note the durations.
6. Destroy something obvious in game, save, then restore the earlier backup. **Must** create
   a safety backup, restore, start, and show the world as it was.
7. Restore with a deliberately broken snapshot target: stop the add-on mid-restore (restart
   the add-on from Home Assistant). On the next start, reconciliation **must** report the
   rollback and the world **must** still be usable.
8. Confirm `/data/secrets/restic.pass` exists with mode 0600. Copy it off the device.

## 7. Terrain generation

1. Install Chunky from the Terrain tab. **Must** verify the checksum. Restart Minecraft.
2. Plan a Gentle run: radius 3000, playable border 2500, margin 500. Check the estimate:
   chunk count, storage range, free space, and the border comparison.
3. Set the playable border to 3000 with the same generation radius. **Must** warn that
   players could outrun the generated area.
4. Start the run outside the allowed hours. **Must** pause with `outside_allowed_hours`.
5. Widen the allowed hours to now; the job **must** resume after the dwell time.
6. Join the server. **Must** pause within about five seconds with `players_online`.
7. Leave. **Must** stay paused for the configured empty-server delay, then resume.
8. Thermal: run `stress-ng --cpu 4` (or block the fan) until the temperature passes the
   threshold. **Must** pause with `cpu_temperature`, and **must** only resume once the
   temperature drops below the recovery threshold.
9. Low disk: create a large file (`fallocate -l <n>G /data/ballast`) until free space falls
   below the threshold. **Must** cancel the job, not pause it. Delete the ballast file.
10. Restart the add-on while a job is running. **Must** adopt the job as paused after start.
11. Let a small run (radius 512) finish. **Must** report completion, update the world's
    generated radius, and take the post-generation backup if enabled.
12. Compare in game: fly to the edge of the generated area; chunk generation stutter should
    stop inside it and reappear outside.

## 8. Home Assistant integration

1. Install the Mosquitto broker add-on if it is not there. Restart this add-on.
2. Confirm the device and all documented entities appear.
3. Press `button.minecraft_start` and `button.minecraft_stop`. **Must** work and **must**
   appear in the audit log with actor `homeassistant`.
4. Change `select.minecraft_world`. **Must** switch the world with a safety backup.
5. Change `select.minecraft_generation_profile`. **Must** be reflected in the UI.
6. Confirm `sensor.minecraft_tps` and `sensor.minecraft_cpu_temperature` update roughly
   every ten seconds while running.
7. Stop the add-on. **Must** turn every entity unavailable rather than freezing values.

## 9. Restarts and reliability

1. Restart the add-on while Minecraft is running. **Must** stop Minecraft gracefully first
   (the log shows the flush and stop), and **must** start it again on the next boot because
   it was running before.
2. Kill the container hard (`ha addons restart`, or pull power for a real test) while
   Minecraft runs. On the next start, reconciliation **must** terminate any orphan, report
   unfinished operations and leave a usable world.
3. Force stop from the dashboard. **Must** require `FORCE-STOP`, kill immediately, and be
   audited.
4. Configure a daily restart two minutes ahead. **Must** warn in game and restart on time.
5. Configure idle shutdown at 1 minute with nobody online. **Must** stop the server and
   audit `server.idle_shutdown`.
6. Enable crash restart, then kill the JVM (`kill -9` its pid from an SSH add-on). **Must**
   detect the crash with an exit code and restart after the backoff.

## 10. Updates

1. Check for updates in Settings. **Must** list versions and the newest build.
2. Install the same version's newest build (type `UPDATE`). **Must** back up, stop, swap,
   start and verify.
3. Roll-back path: install a build that cannot start (for example a Paper build for a much
   newer Minecraft version than the bundled Java supports). **Must** fail to start and
   restore the previous JAR automatically.

## 11. Resource envelope

With ten minutes of two players online, Balanced preset, no generation running:

- Controller memory **must** stay under 100 MB.
- Controller CPU should be a few percent at most.
- Total system memory use should leave at least 1.5 GB available for Home Assistant.
- CPU temperature should stay below the pause threshold with active cooling.

Record the actual figures; they are the baseline for the next release.
