# Constellation — a 3D file viewer for Obsidian

Flies through your vault as a constellation of specimens: each note is a glass
blob, grouped by its **type** (frontmatter `type`, else its top folder, else its
leading tag) and related to its neighbours by **shared tag**. Click a specimen —
or press Enter on the focused one — to open that note.

The renderer (`src/render-core.js`) is data-agnostic and is shared verbatim with
the RemindMe SearXNG search constellation; only `src/constellation-view.ts` is
Obsidian-specific, mapping vault files (via `metadataCache`) onto the core's
result shape.

## Develop

```sh
npm install
npm run dev      # esbuild watch → main.js
```

Then symlink or copy `manifest.json` + `main.js` into
`<vault>/.obsidian/plugins/remindme-constellation/` and enable it.

```sh
npm run build    # minified production main.js
```

Desktop-only: it renders WebGL with three.js, which is bundled in.

## Relation to the chat vault graph

The RemindMe chat harness has its own **in-chat vault graph** (`/graph`) — a
lightweight same-origin SVG constellation of the same vault. This plugin is the
full three.js viewer, living where the vault files actually are.
