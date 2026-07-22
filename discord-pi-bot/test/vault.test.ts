import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VaultStore } from "../src/harness/vault.ts";

async function seedVault(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vault-"));
	await mkdir(join(root, "projects"), { recursive: true });
	await mkdir(join(root, ".obsidian"), { recursive: true });
	await writeFile(join(root, ".obsidian", "app.json"), "{}");
	await writeFile(
		join(root, "projects", "remindme.md"),
		[
			"---",
			"title: RemindMe",
			"type: project",
			"tags: [home, ai]",
			"aliases: [the bot]",
			"---",
			"",
			"# RemindMe",
			"Links to [[Qwen]] and [[missing note]].",
			"Inline #vault tag and a `#notag` in code.",
		].join("\n"),
	);
	await writeFile(
		join(root, "qwen.md"),
		[
			"---",
			"type: reference",
			"tags:",
			"  - ai",
			"  - model",
			"---",
			"The model behind [[the bot]].",
		].join("\n"),
	);
	return root;
}

test("parses frontmatter, inline tags, and wikilinks", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();

	const note = store.get("projects/remindme.md");
	assert.ok(note);
	assert.equal(note.title, "RemindMe");
	assert.equal(note.type, "project");
	// Frontmatter list + inline #vault; the `#notag` in a code span is excluded.
	assert.deepEqual([...note.tags].sort(), ["ai", "home", "vault"]);
	assert.ok(!note.tags.includes("notag"));
});

test("resolves wikilinks by basename and alias, tracks unresolved", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();

	const remind = store.get("projects/remindme.md");
	const qwen = store.get("qwen.md");
	assert.ok(remind && qwen);
	// [[Qwen]] resolves to qwen.md; [[missing note]] stays unresolved.
	assert.deepEqual(remind.links, ["qwen.md"]);
	assert.deepEqual(remind.unresolvedLinks, ["missing note"]);
	// [[the bot]] resolves via RemindMe's alias — backlink lands on remindme.
	assert.deepEqual(qwen.links, ["projects/remindme.md"]);
});

test("ignores dotfolders like .obsidian", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	assert.equal(store.list().length, 2);
});

test("related() returns backlinks and tag-neighbours", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	const related = store.related("qwen.md");
	assert.deepEqual(
		related.backlinks.map((note) => note.path),
		["projects/remindme.md"],
	);
	// Both notes carry the `ai` tag.
	assert.deepEqual(
		related.byTag.map((note) => note.path),
		["projects/remindme.md"],
	);
});

test("graph exposes note links and optional tag nodes", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	const plain = store.graph();
	assert.equal(plain.nodes.length, 2);
	assert.ok(plain.edges.some((e) => e.kind === "link"));
	assert.ok(!plain.edges.some((e) => e.kind === "tag"));

	const tagged = store.graph({ includeTags: true });
	assert.ok(tagged.nodes.some((n) => n.kind === "tag" && n.id === "#ai"));
	assert.ok(tagged.edges.some((e) => e.kind === "tag"));
});

test("write creates a linkable note and reindexes", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	const note = await store.write("ideas/graph view", {
		frontmatter: { type: "project", tags: ["ai", "ui"] },
		body: "Render the [[RemindMe]] vault as a constellation.",
	});
	assert.equal(note.path, "ideas/graph view.md");
	assert.deepEqual(note.links, ["projects/remindme.md"]);
	// The new note now backlinks the target.
	const related = store.related("projects/remindme.md");
	assert.ok(related.backlinks.some((n) => n.path === "ideas/graph view.md"));
	assert.deepEqual([...note.tags].sort(), ["ai", "ui"]);
});

test("write refuses to escape the vault root", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	await assert.rejects(() => store.write("../escape", { body: "no" }));
});

test("delete removes a note and its backlinks", async () => {
	const store = new VaultStore(await seedVault());
	await store.load();
	assert.equal(await store.delete("qwen.md"), true);
	assert.equal(store.get("qwen.md"), undefined);
	// RemindMe's [[Qwen]] is now unresolved again.
	const remind = store.get("projects/remindme.md");
	assert.ok(remind?.unresolvedLinks.includes("Qwen"));
});
