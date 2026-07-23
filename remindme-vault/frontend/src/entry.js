// The vault workspace: an Obsidian-shaped editor (ribbon + file explorer +
// editor as the main area) with the constellation as an openable pane, not the
// default view. Bundled with the render core and three.js into public/bundle.js.

import { createConstellation } from "./render-core.js";
import { fetchVaultNotes, vaultResolvers } from "./vault-adapter.js";

const $ = (id) => document.getElementById(id);
const slug = (text) =>
	String(text || "")
		.toLowerCase()
		.replace(/[^a-z0-9/]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "untitled";

const state = { notes: [], current: null, constellation: null };

async function loadList(query = "") {
	state.notes = await fetchVaultNotes(query);
	const list = $("note-list");
	list.innerHTML = "";
	if (!state.notes.length) {
		const empty = document.createElement("li");
		empty.className = "note-empty";
		empty.textContent = query ? "No matches." : "No notes yet.";
		list.appendChild(empty);
		return;
	}
	for (const note of state.notes) {
		const item = document.createElement("li");
		item.className = "note-item";
		item.dataset.path = note.id;
		if (state.current === note.id) item.classList.add("active");
		const title = document.createElement("span");
		title.className = "note-item-title";
		title.textContent = note.title;
		const tags = document.createElement("span");
		tags.className = "note-item-tags";
		tags.textContent = (note.tags || []).map((t) => `#${t}`).join(" ");
		item.append(title, tags);
		item.addEventListener("click", () => openNote(note.id));
		list.appendChild(item);
	}
}

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
	highlightActive();
	void loadBacklinks(note.path);
	for (const item of document.querySelectorAll(".note-item"))
		item.classList.toggle("active", item.dataset.path === note.path);
}

function newNote() {
	state.current = null;
	$("note-title").value = "";
	$("note-tags").value = "";
	$("note-type").value = "";
	$("note-body").value = "";
	$("tab-title").textContent = "New note";
	$("delete-btn").disabled = true;
	$("backlink-list").innerHTML = "";
	setStatus("");
	showEditor();
	highlightActive();
	$("note-title").focus();
}

async function saveNote() {
	const title = $("note-title").value.trim();
	const body = $("note-body").value;
	if (!title && !state.current) return setStatus("A title is needed.", true);
	// Keep an existing note at its path; derive a new note's path from its title.
	const path = state.current || `${slug(title)}.md`;
	setStatus("Saving…");
	const res = await fetch("api/vault/note", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			path,
			title,
			type: $("note-type").value.trim(),
			tags: $("note-tags").value,
			body,
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
	await loadList($("search").value.trim());
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
	await loadList($("search").value.trim());
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

function showEditor() {
	$("editor-pane").hidden = false;
	$("graph-pane").hidden = true;
	$("rb-graph").classList.remove("active");
}

function openGraph() {
	$("editor-pane").hidden = true;
	$("graph-pane").hidden = false;
	$("rb-graph").classList.add("active");
	// Recreate each open so the WebGL context is fresh and the data current;
	// a constellation left mounted while hidden sizes itself to a zero box.
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
	showEditor();
}

function wire() {
	$("rb-new").addEventListener("click", newNote);
	$("rb-graph").addEventListener("click", () =>
		$("graph-pane").hidden ? openGraph() : closeGraph(),
	);
	$("rb-reload").addEventListener("click", async () => {
		await fetch("api/vault/reload", { method: "POST" });
		await loadList($("search").value.trim());
	});
	$("graph-close").addEventListener("click", closeGraph);
	$("save-btn").addEventListener("click", saveNote);
	$("delete-btn").addEventListener("click", deleteNote);
	$("search").addEventListener("input", (event) =>
		loadList(event.target.value.trim()),
	);
	// Ctrl/Cmd+S saves, like the app it's imitating.
	$("note-body").addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "s") {
			event.preventDefault();
			void saveNote();
		}
	});
	$("note-title").addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "s") {
			event.preventDefault();
			void saveNote();
		}
	});
}

wire();
newNote();
void loadList();
