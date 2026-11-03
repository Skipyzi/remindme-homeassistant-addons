import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PictureStore, pictureFile } from "../src/harness/pictures.ts";
import { ThreadStore } from "../src/assistant/threads.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("a sent picture is kept once, under its hash, and only our own names are served", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pictures-"));
	const store = new PictureStore(dir);
	const first = await store.save("image/png", png.toString("base64"));
	const again = await store.save("image/png", png.toString("base64"));
	assert.deepEqual(first, again);
	assert.match(first.id, /^[a-f0-9]{24}$/);
	assert.deepEqual(await readFile(store.path(pictureFile(first))!), png);
	assert.equal(store.path("../threads.json"), undefined);
	assert.equal(store.path(`${first.id}.exe`), undefined);
});

test("a picture no message shows any more goes, unless it's from the last hour", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pictures-"));
	const store = new PictureStore(dir);
	const kept = await store.save("image/png", png.toString("base64"));
	const gone = await store.save("image/jpeg", Buffer.from("other").toString("base64"));
	const fresh = await store.save("image/webp", Buffer.from("new").toString("base64"));
	const old = new Date(Date.now() - 2 * 3_600_000);
	for (const picture of [kept, gone]) utimesSync(join(dir, pictureFile(picture)), old, old);
	assert.equal(await store.prune(new Set([kept.id])), 1);
	assert.ok(existsSync(join(dir, pictureFile(kept))));
	assert.ok(!existsSync(join(dir, pictureFile(gone))));
	assert.ok(existsSync(join(dir, pictureFile(fresh))));
});

test("a message keeps its pictures, and the store knows which are still shown", async () => {
	const threads = new ThreadStore(join(mkdtempSync(join(tmpdir(), "threads-")), "threads.json"));
	await threads.load();
	const thread = threads.create({ title: "Pictures", origin: "console" });
	const saved = threads.append(thread.id, { role: "user", text: "(1 picture)", pictures: [{ id: "a".repeat(24), type: "image/png" }] });
	assert.deepEqual(saved?.pictures, [{ id: "a".repeat(24), type: "image/png" }]);
	assert.deepEqual([...threads.pictureIds()], ["a".repeat(24)]);
});
