// The vault workspace: an Obsidian-shaped editor (ribbon + folder explorer +
// editor as the main area, with markdown preview) and the constellation as an
// openable pane. Panes are resizable. Bundled with render-core, three.js and
// marked into public/bundle.js.

import { marked } from "marked";
import { createConstellation } from "./render-core.js";
import { fetchVaultNotes, vaultResolvers } from "./vault-adapter.js";

const $ = (id) => document.getElementById(id);
const slug = (text) =>
	String(text || "")
		.toLowerCase()
		.replace(/[^a-z0-9/]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "untitled";
const baseName = (path) =>
	(path.split("/").pop() || path).replace(/\.md$/i, "").toLowerCase();

marked.setOptions({ gfm: true, breaks: true });

const state = {
	current: null,
	constellation: null,
	notes: [],
	folders: [],
	selectedFolder: "",
	expanded: new Set(),
	mode: "edit",
};

/* ── Explorer tree ──────────────────────────────────────────────────────── */

async function loadTree(query = "") {
	if (query) {
		// A search flattens to matching notes; the folder tree is for browsing.
		state.notes = await fetchVaultNotes(query);
		renderFlat(state.notes);
		return;
	}
	const res = await fetch("api/vault/tree");
	const tree = res.ok ? await res.json() : { folders: [], notes: [] };
	state.folders = tree.folders || [];
	state.notes = (tree.notes || []).map((note) => ({
		id: note.path,
		title: note.title,
		tags: note.tags || [],
		type: note.type || "",
	}));
	updateGroupList();
	renderTree();
}

// Real folders and types share one namespace, so both feed the type/folder
// combobox. Types are shown with a leading # to mark them as virtual folders.
function updateGroupList() {
	const list = $("group-list");
	if (!list) return;
	const values = new Set(state.folders);
	for (const note of state.notes) if (note.type) values.add(note.type);
	list.innerHTML = "";
	for (const value of [...values].sort()) {
		const option = document.createElement("option");
		option.value = value;
		list.appendChild(option);
	}
}

function renderFlat(notes) {
	const root = $("tree");
	root.innerHTML = "";
	if (!notes.length) {
		root.innerHTML = '<div class="note-empty">No matches.</div>';
		return;
	}
	for (const note of notes) root.appendChild(noteRow(note.id, note.title, note.tags));
}

function noteRow(path, title, tags) {
	const row = document.createElement("div");
	row.className = "note-item";
	row.dataset.path = path;
	if (state.current === path) row.classList.add("active");
	const name = document.createElement("span");
	name.className = "note-item-title";
	name.textContent = title;
	row.appendChild(name);
	if (tags && tags.length) {
		const tag = document.createElement("span");
		tag.className = "note-item-tags";
		tag.textContent = tags.map((t) => `#${t}`).join(" ");
		row.appendChild(tag);
	}
	row.addEventListener("click", () => openNote(path));
	return row;
}

// Build the tree and render it: real folders (nested), then type groups (which
// behave as virtual folders), then loose notes. A folder and a type are the
// same kind of thing here — one namespace, selected and expanded alike.
function renderTree() {
	const root = $("tree");
	root.innerHTML = "";
	const dirOf = (path) => {
		const cut = path.lastIndexOf("/");
		return cut === -1 ? "" : path.slice(0, cut);
	};
	const notesByDir = new Map();
	const typeGroups = new Map();
	const rootNotes = [];
	for (const note of state.notes) {
		const dir = dirOf(note.id);
		if (dir) {
			if (!notesByDir.has(dir)) notesByDir.set(dir, []);
			notesByDir.get(dir).push(note);
		} else if (note.type) {
			const key = `#${note.type}`;
			if (!typeGroups.has(key)) typeGroups.set(key, []);
			typeGroups.get(key).push(note);
		} else rootNotes.push(note);
	}
	const childrenOf = (parent) =>
		state.folders.filter((folder) => dirOf(folder) === parent);

	// A folder or type header row: selecting sets it as the target, expand shows
	// its notes. `key` is the folder path or "#type"; both toggle identically.
	const groupRow = (key, label, depth, isType) => {
		const open = state.expanded.has(key);
		const head = document.createElement("div");
		head.className = isType ? "folder-row type-group" : "folder-row";
		head.style.paddingLeft = `${8 + depth * 12}px`;
		if (state.selectedFolder === key) head.classList.add("selected");
		head.innerHTML = `<span class="caret">${open ? "▾" : "▸"}</span><span class="folder-name">${label}</span>`;
		head.addEventListener("click", () => {
			state.selectedFolder = state.selectedFolder === key ? "" : key;
			if (open) state.expanded.delete(key);
			else state.expanded.add(key);
			renderTree();
		});
		return head;
	};

	const renderFolders = (container, parent, depth) => {
		for (const folder of childrenOf(parent)) {
			container.appendChild(groupRow(folder, folder.split("/").pop(), depth, false));
			if (state.expanded.has(folder)) {
				const sub = document.createElement("div");
				container.appendChild(sub);
				renderFolders(sub, folder, depth + 1);
				for (const note of notesByDir.get(folder) || []) {
					const row = noteRow(note.id, note.title, note.tags);
					row.style.paddingLeft = `${8 + (depth + 1) * 12}px`;
					sub.appendChild(row);
				}
			}
		}
	};

	renderFolders(root, "", 0);

	for (const key of [...typeGroups.keys()].sort()) {
		root.appendChild(groupRow(key, key, 0, true));
		if (state.expanded.has(key))
			for (const note of typeGroups.get(key)) {
				const row = noteRow(note.id, note.title, note.tags);
				row.style.paddingLeft = "20px";
				root.appendChild(row);
			}
	}

	for (const note of rootNotes)
		root.appendChild(noteRow(note.id, note.title, note.tags));

	if (!root.children.length)
		root.innerHTML = '<div class="note-empty">No notes yet.</div>';
}

async function newFolder() {
	const name = window.prompt("New folder name");
	if (!name || !name.trim()) return;
	// A type group isn't a real directory, so a new folder there lands at root.
	const parent = state.selectedFolder.startsWith("#") ? "" : state.selectedFolder;
	const path = parent ? `${parent}/${name.trim()}` : name.trim();
	await fetch("api/vault/folder", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	state.expanded.add(path.split("/").slice(0, -1).join("/") || path);
	state.expanded.add(path);
	state.selectedFolder = path;
	await loadTree();
}

/* ── Editor ─────────────────────────────────────────────────────────────── */

async function openNote(path) {
	const res = await fetch(`api/vault/note?path=${encodeURIComponent(path)}`);
	if (!res.ok) return;
	const note = await res.json();
	state.current = note.path;
	$("note-title").value = note.title || "";
	$("note-tags").value = (note.tags || []).join(", ");
	$("note-type").value = note.type || "";
	$("note-body").value = note.body || "";
	$("tab-title").textContent = note.title || note.path;
	$("delete-btn").disabled = false;
	setStatus("");
	showEditor();
	renderPreview();
	highlightActive();
	void loadBacklinks(note.path);
}

function newNote() {
	const sel = state.selectedFolder;
	const asType = sel.startsWith("#");
	state.current = null;
	$("note-title").value = "";
	$("note-tags").value = "";
	// A type group pre-fills the type; a real folder just files it there.
	$("note-type").value = asType ? sel.slice(1) : "";
	$("note-body").value = "";
	$("tab-title").textContent = sel ? `New note in ${sel}` : "New note";
	$("delete-btn").disabled = true;
	$("backlink-list").innerHTML = "";
	setStatus("");
	showEditor();
	renderPreview();
	highlightActive();
	$("note-title").focus();
}

async function saveNote() {
	const title = $("note-title").value.trim();
	if (!title && !state.current) return setStatus("A title is needed.", true);
	// Keep an existing note where it is; a new note lands in the selected folder.
	// A type group is not a directory, so it prefixes nothing — the type field
	// (pre-filled by newNote) is what files it under that virtual folder.
	const folder = state.selectedFolder.startsWith("#") ? "" : state.selectedFolder;
	const path = state.current || `${folder ? `${folder}/` : ""}${slug(title)}.md`;
	setStatus("Saving…");
	const res = await fetch("api/vault/note", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			path,
			title,
			type: $("note-type").value.trim(),
			tags: $("note-tags").value,
			body: $("note-body").value,
		}),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		return setStatus(error.error || "Save failed.", true);
	}
	const note = await res.json();
	state.current = note.path;
	$("tab-title").textContent = note.title || note.path;
	$("delete-btn").disabled = false;
	setStatus("Saved.");
	await loadTree($("search").value.trim());
	highlightActive();
	void loadBacklinks(note.path);
}

async function deleteNote() {
	if (!state.current) return;
	if (!window.confirm(`Delete "${$("note-title").value || state.current}"?`)) return;
	await fetch(`api/vault/note?path=${encodeURIComponent(state.current)}`, {
		method: "DELETE",
	});
	newNote();
	await loadTree($("search").value.trim());
}

async function loadBacklinks(path) {
	const list = $("backlink-list");
	list.innerHTML = "";
	const res = await fetch(`api/vault/related?path=${encodeURIComponent(path)}`);
	if (!res.ok) return;
	const related = await res.json();
	const seen = new Set();
	for (const note of [...related.backlinks, ...related.byTag]) {
		if (seen.has(note.path)) continue;
		seen.add(note.path);
		const item = document.createElement("li");
		item.textContent = note.title;
		item.addEventListener("click", () => openNote(note.path));
		list.appendChild(item);
	}
	if (!seen.size) list.innerHTML = '<li class="note-empty">None yet.</li>';
}

function highlightActive() {
	for (const item of document.querySelectorAll(".note-item"))
		item.classList.toggle("active", item.dataset.path === state.current);
}

function setStatus(text, error = false) {
	const el = $("save-status");
	el.textContent = text;
	el.classList.toggle("error", error);
}

/* ── Markdown preview ───────────────────────────────────────────────────── */

// [[Target]] and [[Target|alias]] become links the preview can resolve back to
// a note; everything else is ordinary markdown.
function renderPreview() {
	if (state.mode === "edit") return;
	const source = $("note-body").value.replace(
		/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
		(_all, target, alias) =>
			`[${(alias || target).trim()}](#wl:${encodeURIComponent(target.trim())})`,
	);
	$("preview").innerHTML = marked.parse(source);
}

function resolveWikilink(name) {
	const key = name.toLowerCase();
	const match = state.notes.find(
		(note) => baseName(note.id) === key || (note.title || "").toLowerCase() === key,
	);
	return match ? match.id : null;
}

function setMode(mode) {
	state.mode = mode;
	$("edit-split").dataset.mode = mode;
	for (const btn of document.querySelectorAll(".mode-btn"))
		btn.classList.toggle("active", btn.dataset.mode === mode);
	renderPreview();
}

/* ── Graph pane ─────────────────────────────────────────────────────────── */

// The editor is always present; the graph opens below it, never replacing it.
function showEditor() {
	$("editor-pane").hidden = false;
}

function openGraph() {
	$("graph-gutter").hidden = false;
	$("graph-pane").hidden = false;
	$("rb-graph").classList.add("active");
	state.constellation?.dispose();
	state.constellation = createConstellation({
		mount: $("graph-mount"),
		placeholder: "search the vault",
		onSearch: (query) => fetchVaultNotes(query),
		...vaultResolvers((note) => {
			void openNote(note.id);
		}),
	});
	void state.constellation.search("");
	state.constellation.focus();
}

function closeGraph() {
	state.constellation?.dispose();
	state.constellation = null;
	$("graph-gutter").hidden = true;
	$("graph-pane").hidden = true;
	$("rb-graph").classList.remove("active");
}

/* ── Resizable dividers ─────────────────────────────────────────────────── */

function makeResizer(gutter, { get, set, persist, axis = "x", invert = false }) {
	let start = null;
	gutter.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		start = { pos: axis === "x" ? event.clientX : event.clientY, val: get() };
		try {
			gutter.setPointerCapture(event.pointerId);
		} catch (_) {}
		document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
	});
	gutter.addEventListener("pointermove", (event) => {
		if (!start) return;
		// Invert for a pane below the gutter: dragging down shrinks it.
		const raw = (axis === "x" ? event.clientX : event.clientY) - start.pos;
		set(start.val + (invert ? -raw : raw));
	});
	const end = () => {
		if (!start) return;
		start = null;
		document.body.style.cursor = "";
		persist?.();
	};
	gutter.addEventListener("pointerup", end);
	gutter.addEventListener("pointercancel", end);
}

function setupResizers() {
	const app = $("app");
	const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

	const storedExplorer = Number(localStorage.getItem("vault.explorerW"));
	if (storedExplorer)
		app.style.setProperty("--explorer-w", `${storedExplorer}px`);
	makeResizer($("explorer-gutter"), {
		axis: "x",
		get: () =>
			parseInt(getComputedStyle(app).getPropertyValue("--explorer-w")) || 260,
		set: (value) =>
			app.style.setProperty("--explorer-w", `${clamp(value, 160, 520)}px`),
		persist: () =>
			localStorage.setItem(
				"vault.explorerW",
				String(parseInt(getComputedStyle(app).getPropertyValue("--explorer-w"))),
			),
	});

	const split = $("edit-split");
	const storedSource = localStorage.getItem("vault.sourceW");
	if (storedSource) split.style.setProperty("--source-w", storedSource);
	makeResizer($("split-gutter"), {
		axis: "x",
		get: () => split.querySelector(".source").getBoundingClientRect().width,
		set: (value) => {
			const total = split.getBoundingClientRect().width;
			const pct = clamp((value / total) * 100, 20, 80);
			split.style.setProperty("--source-w", `${pct}%`);
		},
		persist: () =>
			localStorage.setItem(
				"vault.sourceW",
				split.style.getPropertyValue("--source-w") || "50%",
			),
	});

	// Editor ↕ constellation: the graph pane sits below the editor.
	const workspace = document.querySelector(".workspace");
	const graphPane = $("graph-pane");
	const storedGraph = localStorage.getItem("vault.graphH");
	if (storedGraph) graphPane.style.setProperty("--graph-h", storedGraph);
	makeResizer($("graph-gutter"), {
		axis: "y",
		invert: true,
		get: () => graphPane.getBoundingClientRect().height,
		set: (value) => {
			const total = workspace.getBoundingClientRect().height;
			const pct = clamp((value / total) * 100, 15, 85);
			graphPane.style.setProperty("--graph-h", `${pct}%`);
		},
		persist: () =>
			localStorage.setItem(
				"vault.graphH",
				graphPane.style.getPropertyValue("--graph-h") || "40%",
			),
	});
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

function wire() {
	$("rb-new").addEventListener("click", newNote);
	$("rb-folder").addEventListener("click", newFolder);
	$("rb-graph").addEventListener("click", () =>
		$("graph-pane").hidden ? openGraph() : closeGraph(),
	);
	$("rb-reload").addEventListener("click", async () => {
		await fetch("api/vault/reload", { method: "POST" });
		await loadTree($("search").value.trim());
	});
	$("graph-close").addEventListener("click", closeGraph);
	$("save-btn").addEventListener("click", saveNote);
	$("delete-btn").addEventListener("click", deleteNote);
	$("search").addEventListener("input", (event) =>
		loadTree(event.target.value.trim()),
	);
	for (const btn of document.querySelectorAll(".mode-btn"))
		btn.addEventListener("click", () => setMode(btn.dataset.mode));

	let previewTimer = 0;
	$("note-body").addEventListener("input", () => {
		clearTimeout(previewTimer);
		previewTimer = window.setTimeout(renderPreview, 120);
	});

	// A wikilink in the preview opens the note it points at.
	$("preview").addEventListener("click", (event) => {
		const link = event.target.closest('a[href^="#wl:"]');
		if (!link) return;
		event.preventDefault();
		const path = resolveWikilink(decodeURIComponent(link.getAttribute("href").slice(4)));
		if (path) void openNote(path);
	});

	const save = (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "s") {
			event.preventDefault();
			void saveNote();
		}
	};
	$("note-body").addEventListener("keydown", save);
	$("note-title").addEventListener("keydown", save);

	setupResizers();
}

wire();
newNote();
// A ?note=<path> deep-link (e.g. from the RemindMe chat console's "Open in
// Vault") opens that note once the tree has loaded.
const deepLinkNote = new URLSearchParams(location.search).get("note");
void loadTree().then(() => {
	if (deepLinkNote) void openNote(deepLinkNote);
});
