# Backups and recovery

## What is backed up, and by whom

| Mechanism | Covers | Restores |
| --- | --- | --- |
| Add-on backups (this document) | One world set per snapshot, deduplicated | A single world, without restarting the add-on |
| Home Assistant add-on backups | The whole `/data` volume, including the restic repository | Everything, by restoring the add-on |

Use add-on backups for "I blew up my base"; use Home Assistant backups for "the SD card
died". They are complementary: the repository lives inside `/data`, so a Home Assistant
backup carries your world history with it.

## The repository

- Location: `/data/backups/repo`
- Password: `/data/secrets/restic.pass`, generated on first use, mode 0600
- Cache: `/data/backups/cache`

**Copy the password file somewhere outside the Pi.** Without it the repository cannot be
read, by you or by anyone else. Every other piece of this system can be rebuilt; that file
cannot.

```bash
# From a Home Assistant terminal add-on
cat /addon_configs/../addons_data/*minecraft_server/secrets/restic.pass
```

The exact path depends on your installation; the file is `secrets/restic.pass` inside the
add-on's data directory.

## How a live backup stays consistent

Minecraft keeps chunks inside region files and writes them continuously, so copying a live
world file by file produces a torn copy. Individual chunks cannot be copied independently
either - they share region files. The add-on therefore does this:

```text
save-off                 stop autosaving
save-all flush           write everything pending to disk, wait for confirmation
hardlink snapshot        /data/staging/live/<world>, milliseconds even for gigabytes
save-on                  autosaving continues
restic backup            deduplicate and compress from the snapshot
verify                   check the repository structure
remove staging
```

Saving is disabled only for the hardlink pass. The snapshot shares inodes with the live
world, so region files that Minecraft later rewrites are written to new inodes and the
snapshot keeps the flushed content.

If the flush cannot be confirmed, the backup is **refused** unless you explicitly ask for a
crash-consistent one, and that backup is labelled `live` rather than `flushed`. Saving is
re-enabled on every failure path, and again during startup recovery if the controller died
mid-backup.

## Consistency labels

| Label | Meaning |
| --- | --- |
| `clean` | The server was stopped |
| `flushed` | Saving was disabled and the world flushed before the snapshot |
| `live` | Copied while the server was writing; usable, but treat it as a crash |

## Restoring from the UI

1. **Backups** tab → **Preview** to see what is inside.
2. **Restore**, type `RESTORE`.
3. The add-on stops the server, backs up the current world (unless you skip it), restores
   into staging, validates that the Overworld has a `level.dat`, swaps atomically, starts
   the server and verifies it comes up.
4. If it does not come up, the previous world is put back automatically and the result says
   `rolled_back`.

A failed restore cannot silently destroy the active world: the previous copy is kept beside
the world directory until the new one has started successfully.

## Recovering without the add-on UI

If the controller will not start, everything is still recoverable with a terminal.

```bash
# 1. Look at what happened last
tail -n 50 /data/audit/audit.log

# 2. List snapshots
export RESTIC_REPOSITORY=/data/backups/repo
export RESTIC_PASSWORD_FILE=/data/secrets/restic.pass
restic snapshots

# 3. Restore one into a scratch directory
restic restore <snapshot-id> --target /data/staging/manual

# 4. Find the world set inside it (restic recreates the original path)
find /data/staging/manual -name level.dat

# 5. Move the current world aside and put the restored one in place
mv /data/worlds/survival /data/worlds/survival.broken
mv /data/staging/manual/data/staging/live/survival /data/worlds/survival
```

Start the add-on afterwards. It re-creates any missing metadata, and startup reconciliation
cleans up leftovers.

If restic is not available where you are working, copy the repository directory to another
machine; it is a self-contained, encrypted repository.

## Interrupted operations

The controller writes a journal row before each filesystem step, so recovery is
deterministic:

| Interrupted during | On next start |
| --- | --- |
| Backup, any phase | Staging removed, record marked failed, saving re-enabled |
| Restore, before the swap | Nothing was changed; the entry is closed |
| Restore, during or just after the swap | The kept-aside world is put back automatically |
| Restore that had already completed | Detected and closed as successful |
| World switch | The previous world is restored and, if it had been running, started |
| Terrain generation | The job is adopted as paused for review |

The **Activity** tab shows the journal; `/data/audit/audit.log` shows the same history as
plain text.

## Retention

Retention runs after every successful backup and can be triggered manually. Defaults keep
the last 5, 7 daily, 4 weekly and 3 monthly snapshots. After `forget --prune`, the local
index is reconciled with the repository, so a record whose snapshot is gone disappears from
the list rather than pretending to be restorable.

## Verification

- **Verify structure** (`restic check`) is quick and runs after each backup by default.
- **Deep verify** re-reads a percentage of the stored data. On a Pi this is slow, so it is
  a manual action; 5% monthly is a reasonable habit.

## What to do when the disk fills up

1. Free space first: the **Backups** tab shows the repository size, the **Worlds** tab
   shows per-world and per-dimension sizes, and `/data/trash` may still hold deleted worlds.
2. Empty the trash (permanent deletion) and apply retention.
3. Terrain generation cancels itself below the configured threshold (15 GB by default),
   because a full disk corrupts region files rather than merely stopping progress.
