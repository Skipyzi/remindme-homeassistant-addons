import express from "express";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { VaultStore, type VaultNote } from "./vault";

/*
 * A standalone Obsidian-format vault, served from Home Assistant. It embeds the
 * same VaultStore the RemindMe add-on uses and reads the very same files under
 * /share/vault, so notes edited here, in Obsidian, or by the model are one set.
 *
 * The server owns parse/index/graph/CRUD; the page is a thin Obsidian-style
 * editor plus a three.js constellation pane. Everything is same-origin, so the
 * WebGL runs on the viewer's GPU rather than the Pi's.
 */
const app = express();
const port = Number(process.env.VAULT_PORT || 8091);
app.use(express.json({ limit: "4mb" }));

const VAULT_ROOT = process.env.VAULT_DATA_PATH || "/share/vault";
const vault = new VaultStore(VAULT_ROOT);
void vault.load();

/** Resolve a vault-relative path to an absolute one, refusing to escape root. */
function resolveInside(relPath: string): string {
	const clean = relPath.split(/[\\/]+/).filter(Boolean).join(sep);
	const absolute = join(VAULT_ROOT, clean);
	const rel = relative(VAULT_ROOT, absolute);
	if (rel.startsWith("..")) throw new Error("Path escapes the vault");
	return absolute;
}

/** Every folder under the vault, relative and POSIX-style, empty ones included. */
async function walkFolders(): Promise<string[]> {
	const dirs: string[] = [];
	async function recurse(absolute: string, rel: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(absolute, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// Dotfolders (like Obsidian's own .obsidian) are config, not vault.
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			dirs.push(childRel);
			await recurse(join(absolute, entry.name), childRel);
		}
	}
	await recurse(VAULT_ROOT, "");
	return dirs.sort();
}

/** Frontmatter patch from a save request — only the fields supplied. */
function noteFrontmatter(
	body: Record<string, unknown> | undefined,
): Record<string, string | string[]> {
	const patch: Record<string, string | string[]> = {};
	if (typeof body?.title === "string" && body.title.trim())
		patch.title = body.title.trim();
	if (typeof body?.type === "string" && body.type.trim())
		patch.type = body.type.trim();
	if (Array.isArray(body?.tags))
		patch.tags = body.tags.map((t) => String(t).replace(/^#/, "")).filter(Boolean);
	else if (typeof body?.tags === "string" && body.tags.trim())
		patch.tags = body.tags
			.split(",")
			.map((t) => t.trim().replace(/^#/, ""))
			.filter(Boolean);
	return patch;
}

/** A note trimmed for a list or graph payload — never the whole body. */
function summarise(note: VaultNote) {
	return {
		path: note.path,
		title: note.title,
		type: note.type,
		tags: note.tags,
		links: note.links.length,
		updatedAt: note.updatedAt,
		snippet: note.body.replace(/\s+/g, " ").trim().slice(0, 160),
	};
}

app.get("/api/vault", (request, response) => {
	const notes = vault.list({
		tag: request.query.tag ? String(request.query.tag) : undefined,
		type: request.query.type ? String(request.query.type) : undefined,
		search: request.query.search ? String(request.query.search) : undefined,
	});
	response.json(notes.map(summarise));
});
app.get("/api/vault/tags", (_request, response) => response.json(vault.tags()));
/* The explorer tree: every folder (empty ones too) plus note summaries. */
app.get("/api/vault/tree", async (_request, response) => {
	response.json({
		folders: await walkFolders(),
		notes: vault.list().map(summarise),
	});
});
/* Create a folder by exploring/adding to the vault storage. */
app.post("/api/vault/folder", async (request, response) => {
	const path = String(request.body?.path || "").trim();
	if (!path) return response.status(400).json({ error: "A folder path is required." });
	try {
		await mkdir(resolveInside(path), { recursive: true });
		response.status(201).json({ path });
	} catch (error) {
		response
			.status(400)
			.json({ error: error instanceof Error ? error.message : "Could not create folder" });
	}
});
app.get("/api/vault/graph", (request, response) =>
	response.json(vault.graph({ includeTags: request.query.tags === "1" })),
);
app.get("/api/vault/related", (request, response) => {
	const related = vault.related(String(request.query.path || ""));
	response.json({
		backlinks: related.backlinks.map(summarise),
		byTag: related.byTag.map(summarise),
	});
});
app.get("/api/vault/note", (request, response) => {
	const note = vault.get(String(request.query.path || ""));
	response.status(note ? 200 : 404).json(note || { error: "Note not found" });
});
app.put("/api/vault/note", async (request, response) => {
	const path = String(request.body?.path || "").trim();
	if (!path) return response.status(400).json({ error: "A note path is required." });
	try {
		const note = await vault.write(path, {
			body: typeof request.body?.body === "string" ? request.body.body : undefined,
			frontmatter: noteFrontmatter(request.body),
		});
		response.json(note);
	} catch (error) {
		response
			.status(400)
			.json({ error: error instanceof Error ? error.message : "Write failed" });
	}
});
app.delete("/api/vault/note", async (request, response) => {
	const removed = await vault.delete(String(request.query.path || ""));
	response.status(removed ? 204 : 404).end();
});
app.post("/api/vault/reload", async (_request, response) => {
	await vault.load();
	response.json({ notes: vault.list().length });
});

app.use(
	express.static(resolve(process.cwd(), "public"), {
		etag: true,
		setHeaders: (r) => r.setHeader("Cache-Control", "no-cache, must-revalidate"),
	}),
);
app.get("/", (_request, response) =>
	response
		.set("Cache-Control", "no-cache, must-revalidate")
		.sendFile("index.html", { root: "public" }),
);

app.listen(port, () => console.log(`RemindMe Vault listening on port ${port}`));
