# Building the hostile archives the import path must reject

The automated tests construct these in memory (`worlds.TestImportRejectsUnsafeArchives`).
These commands build the same archives for manual testing on a real installation.

All of them **must** be refused with a "rejected as unsafe" error, and **must not** leave a
world behind in the worlds list or any file outside `/data/staging`.

## Path traversal

```bash
mkdir -p evil/world
echo level > evil/world/level.dat
( cd evil && zip -r ../traversal.zip world )
# Rewrite an entry name to escape the archive root:
printf '@ world/level.dat\n@=../../escape/level.dat\n' | zipnote -w traversal.zip
```

## Absolute path

```bash
zip absolute.zip /etc/hostname          # most zip tools strip the leading slash
# Force it with a tool that preserves it, or use the -j0 option of some packers.
```

## Symbolic link

```bash
mkdir -p linky/world
echo level > linky/world/level.dat
ln -s /etc/passwd linky/world/secret
( cd linky && zip -ry ../symlink.zip world )   # -y stores the link itself
```

## ZIP bomb (implausible compression ratio)

```bash
mkdir -p bomb/world
echo level > bomb/world/level.dat
head -c 200M /dev/zero > bomb/world/region.mca      # compresses to almost nothing
( cd bomb && zip -r9 ../bomb.zip world )
```

The import refuses any entry whose uncompressed size is more than 200 times its compressed
size, and stops as soon as the total uncompressed size passes the limit, so the extraction
never has to finish to be rejected.

## Not a world at all

```bash
echo "just some notes" > notes.txt
zip notworld.zip notes.txt
```

Rejected with "archive does not contain a Minecraft world (no level.dat found)".

## Deep nesting

```bash
path=deep
for i in $(seq 1 30); do path="$path/level$i"; done
mkdir -p "$path"
echo level > "$path/level.dat"
zip -r deep.zip deep
```

Rejected because the entry is nested deeper than 24 levels.
