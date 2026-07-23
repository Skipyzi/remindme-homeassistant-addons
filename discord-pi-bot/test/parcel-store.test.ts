import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ParcelStore } from "../src/harness/parcelStore.ts";

async function freshStore() {
	const dir = await mkdtemp(join(tmpdir(), "parcels-"));
	const path = join(dir, "parcels.json");
	return { store: new ParcelStore(path), path, dir };
}

test("adds a parcel with sensible defaults", async () => {
	const { store, dir } = await freshStore();
	const parcel = await store.add({ trackingNumber: "00340", slug: "dhl" });
	assert.ok(parcel.id);
	assert.equal(parcel.trackingNumber, "00340");
	assert.equal(parcel.label, "Parcel");
	assert.equal(parcel.tag, "Pending");
	assert.equal(parcel.delivered, false);
	assert.deepEqual(store.list().length, 1);
	await rm(dir, { recursive: true, force: true });
});

test("finds by tracking number, case-insensitive", async () => {
	const { store, dir } = await freshStore();
	await store.add({ trackingNumber: "AbC123", slug: "dpd" });
	assert.ok(store.findByNumber("abc123"));
	assert.equal(store.findByNumber("nope"), undefined);
	await rm(dir, { recursive: true, force: true });
});

test("updates status and removes", async () => {
	const { store, dir } = await freshStore();
	const parcel = await store.add({ trackingNumber: "X1", slug: "dhl" });
	const updated = await store.update(parcel.id, {
		tag: "Delivered",
		delivered: true,
		statusMessage: "Delivered to the porch",
	});
	assert.equal(updated?.tag, "Delivered");
	assert.equal(updated?.delivered, true);
	assert.equal(await store.remove(parcel.id), true);
	assert.equal(store.list().length, 0);
	assert.equal(await store.remove(parcel.id), false);
	await rm(dir, { recursive: true, force: true });
});

test("persists across reloads", async () => {
	const { store, path, dir } = await freshStore();
	await store.add({ trackingNumber: "P9", slug: "gls", label: "Keyboard" });
	const reloaded = new ParcelStore(path);
	await reloaded.load();
	assert.equal(reloaded.list().length, 1);
	assert.equal(reloaded.list()[0].label, "Keyboard");
	await rm(dir, { recursive: true, force: true });
});

test("a missing store file loads as empty", async () => {
	const dir = await mkdtemp(join(tmpdir(), "parcels-"));
	const store = new ParcelStore(join(dir, "absent.json"));
	await store.load();
	assert.deepEqual(store.list(), []);
	await rm(dir, { recursive: true, force: true });
});
