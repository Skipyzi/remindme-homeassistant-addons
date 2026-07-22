// Maps the vault's JSON API onto the render core's result shape. Same-origin
// and ingress-safe: paths are relative so they resolve under Home Assistant's
// ingress prefix.

export async function fetchVaultNotes(query = "") {
	const url = query
		? `api/vault?search=${encodeURIComponent(query)}`
		: "api/vault";
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`vault ${res.status}`);
	const notes = await res.json();
	return (notes || []).map((note) => ({
		id: note.path,
		title: note.title || note.path,
		url: note.path,
		snippet: note.snippet || "",
		group: (note.type || "note").toLowerCase(),
		tags: note.tags || [],
	}));
}

// Group notes by type, relate them by their leading tag — the relation map
// draws a link between same-linkKey specimens across groups.
export function vaultResolvers(onOpen) {
	return {
		groupOf: (note) => String(note.group || "note"),
		snippetOf: (note) => note.snippet || "",
		subtitleOf: (note) =>
			note.tags && note.tags.length ? `#${note.tags[0]}` : "",
		linkKeyOf: (note) => (note.tags && note.tags.length ? note.tags[0] : ""),
		faviconFor: () => null,
		onOpen,
	};
}
