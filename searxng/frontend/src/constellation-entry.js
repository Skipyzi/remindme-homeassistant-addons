// Entry point for the served constellation view. Bundled (with three.js and
// the render core) into /static/remindme/constellation.js by build.mjs, so the
// page loads a single self-hosted module — no import map, no CDN, no inline
// script. That keeps it inside SearXNG's default `script-src 'self'` CSP.

import { createConstellation } from "./render-core.js";
import { searchSearxng } from "./searxng-adapter.js";

const q = new URLSearchParams(location.search).get("q") || "";

const view = createConstellation({
	mount: document.getElementById("app") || document.body,
	placeholder: "query the open web",
	initialQuery: q,
	onSearch: (query) => searchSearxng(query),
	onOpen: (r) => { if (r.url) window.open(r.url, "_blank", "noopener"); },
});

// Deep link: /static/remindme/constellation.html?q=… runs the search on load.
if (q) { document.title = `${q} · RemindMe Search`; view.search(q); }
view.focus();

// Handy for debugging from the console; harmless in production.
window.__constellation = view;
