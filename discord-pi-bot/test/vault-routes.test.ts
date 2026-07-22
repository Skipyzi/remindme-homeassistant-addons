import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("vault routes read and write the notes on disk", async (context) => {
	// The store is constructed at module import, so the vault path must be set
	// before harness-server is pulled in.
	const directory = await mkdtemp(join(tmpdir(), "vault-routes-"));
	process.env.VAULT_DATA_PATH = directory;

	const { createHarnessApp } = await import("../src/harness-server.ts");
	const app = createHarnessApp();
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test server address");
	const base = `http://127.0.0.1:${address.port}`;
	context.after(() => server.close());

	// Empty to start.
	const empty = await fetch(`${base}/api/vault`);
	assert.deepEqual(await empty.json(), []);

	// Save a note.
	const saved = await fetch(`${base}/api/vault/note`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			path: "projects/remindme",
			title: "RemindMe",
			type: "project",
			tags: ["ai", "#home"],
			body: "The [[Vault]] is the memory. Inline #graph tag.",
		}),
	});
	assert.equal(saved.status, 200);
	const note = await saved.json();
	assert.equal(note.path, "projects/remindme.md");
	assert.equal(note.type, "project");
	// Leading # is stripped from the tags field; inline #graph is picked up.
	assert.deepEqual([...note.tags].sort(), ["ai", "graph", "home"]);
	assert.deepEqual(note.unresolvedLinks, ["Vault"]);

	// It shows up in the list, trimmed to a summary (no full body).
	const list = await (await fetch(`${base}/api/vault`)).json();
	assert.equal(list.length, 1);
	assert.equal(list[0].path, "projects/remindme.md");
	assert.equal(list[0].body, undefined);

	// Tag filter and tag counts.
	const byTag = await (await fetch(`${base}/api/vault?tag=ai`)).json();
	assert.equal(byTag.length, 1);
	const tags = await (await fetch(`${base}/api/vault/tags`)).json();
	assert.ok(tags.some((t: { tag: string }) => t.tag === "ai"));

	// Full note fetch carries the body.
	const full = await (
		await fetch(`${base}/api/vault/note?path=${encodeURIComponent("projects/remindme.md")}`)
	).json();
	assert.match(full.body, /memory/);

	// Graph with tag nodes.
	const graph = await (await fetch(`${base}/api/vault/graph?tags=1`)).json();
	assert.ok(graph.nodes.some((n: { id: string }) => n.id === "#ai"));

	// Delete it.
	const removed = await fetch(
		`${base}/api/vault/note?path=${encodeURIComponent("projects/remindme.md")}`,
		{ method: "DELETE" },
	);
	assert.equal(removed.status, 204);
	assert.deepEqual(await (await fetch(`${base}/api/vault`)).json(), []);
});
