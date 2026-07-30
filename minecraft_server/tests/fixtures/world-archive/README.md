# Minimal valid world archive

The smallest layout the importer accepts. Zip the `myserver` directory and import it; the
add-on normalises it into `world`, `world_nether` and `world_the_end`.

```bash
cd tests/fixtures/world-archive
zip -r /tmp/valid-world.zip myserver
```

Layout:

```text
myserver/
├── server.properties        ignored by the importer, harmless
├── world/
│   ├── level.dat            required: this is how a world is recognised
│   └── region/r.0.0.mca     placeholder region file
├── world_nether/
│   └── level.dat
└── world_the_end/
    └── level.dat
```

The files here are placeholders, not real NBT: the importer only checks the layout, and
Minecraft regenerates anything it cannot read. For a realistic import test, export a world
from a running server instead (Worlds tab → Export).

Variants worth testing by hand:

| Variant | Expected result |
| --- | --- |
| Only `world/` present | Imported; Minecraft generates the Nether and the End, with a warning |
| World folder at the archive root (no `myserver/`) | Imported the same way |
| Only `world_nether/` present | Imported as the Overworld, with a warning saying so |
| Two extra world folders | The extras are ignored, with a warning |
