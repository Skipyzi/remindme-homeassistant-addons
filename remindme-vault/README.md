# RemindMe Vault

An editable, Obsidian-format note vault served straight from Home Assistant,
with a 3D constellation view. It runs on the Pi5 host but renders its WebGL on
whatever device you open it from, so the graph stays smooth.

## What it is

- A **file explorer + markdown editor** shaped like Obsidian: a ribbon, a note
  list, and the editor as the main area. Frontmatter, `#tags`, and `[[wikilinks]]`
  are first-class; backlinks and tag-neighbours show under each note.
- A **constellation** pane (the ribbon's ◕) — the same three.js view the
  RemindMe SearXNG search uses, here flying through your notes. Click a specimen
  to open that note. It is a pane, not the main view.

The vault lives at `/share/vault` (read-write), the same plain `.md` files the
RemindMe add-on and a synced Obsidian desktop can open. There is no lock-in:
it is just an Obsidian vault.

## How it relates to the rest

- **RemindMe add-on** already reads/writes the same `/share/vault` as the model's
  editable memory (`/vault`, `/graph`, `search_memory`/`write_memory`). This
  add-on is the human editing surface for it.
- **Obsidian desktop** can point at a synced copy of `/share/vault` and use the
  companion `obsidian-constellation` plugin for the full-fidelity view.

## Build

The Docker image builds everything at image time: `tsc` for the server and
esbuild (with three.js) for `public/bundle.js`. No toolchain ships in the image.

```sh
npm install
npm run build      # dist/server.js + public/bundle.js
npm start
```

Desktop-class browsers only for the constellation (WebGL); the editor works
anywhere.
