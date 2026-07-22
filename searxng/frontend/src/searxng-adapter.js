// ── SearXNG adapter ───────────────────────────────────────────────────────
// Maps a live SearXNG instance's JSON API onto the render core's result shape.
// Same-origin only — the constellation page is served from the instance, so
// `base` stays "" and nothing ever leaves the LAN.

// Group each result by its engine so every engine becomes a column.
export async function searchSearxng(query, { base = "", pageno = 1, categories = "general", signal } = {}) {
	const params = new URLSearchParams({ q: query, format: "json", pageno: String(pageno), categories });
	const res = await fetch(`${base}/search?${params}`, { signal, headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`SearXNG ${res.status}`);
	const data = await res.json();
	return (data.results || []).map((r) => ({
		title: r.title || r.url,
		url: r.url,
		snippet: r.content || "",
		group: String(r.engine || (r.engines && r.engines[0]) || "web").toLowerCase(),
		// Only ever use an image the instance already proxied (same-origin, signed).
		// General web results carry none, so the core draws a letter tile instead —
		// no third-party favicon fetch, no IP leak.
		favicon: typeof r.img_src === "string" && r.img_src.startsWith("/") ? r.img_src : null,
	}));
}
