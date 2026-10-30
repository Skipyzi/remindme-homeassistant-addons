import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlaceReminders, placeWhen, type PlaceReminder, type Whereabouts } from "../src/assistant/placeReminders.ts";

const zones = [
	{ id: "zone.home", name: "Home", lat: 51.3406, lon: 12.3747, radius: 100 },
	{ id: "zone.office", name: "Office", lat: 51.3397, lon: 12.3731, radius: 150 },
];
function watcher(start: Partial<Whereabouts>) {
	let where: Whereabouts = { state: "not_home", zones, ...start };
	const fired: PlaceReminder[] = [];
	const places = new PlaceReminders({
		path: join(mkdtempSync(join(tmpdir(), "places-")), "place-reminders.json"),
		where: async () => where,
		fire: async (reminder) => void fired.push(reminder),
	});
	return { places, fired, move: (next: Partial<Whereabouts>) => (where = { ...where, ...next }) };
}

test("arriving home fires once, after the move has held for a minute", async () => {
	const { places, fired, move } = watcher({ state: "not_home" });
	const { reminder, insideNow } = await places.add({ message: "Add the model to each thread", on: "arrive", place: "home" });
	assert.equal(insideNow, false);
	assert.equal(placeWhen(reminder), "when you get home");
	const t = Date.now();
	move({ state: "home" });
	assert.deepEqual(await places.check(t), [], "a first sighting only starts the clock");
	assert.deepEqual(await places.check(t + 30_000), [], "half a minute isn't enough");
	assert.equal((await places.check(t + 61_000)).length, 1);
	assert.equal(fired[0].message, "Add the model to each thread");
	assert.equal(places.list().length, 0, "once, unless every time");
});

test("a phone wobbling at the edge of a zone doesn't set it off, and every_time stays", async () => {
	const { places, fired, move } = watcher({ state: "Office" });
	await places.add({ message: "Take the laptop charger", on: "leave", place: "office", everyTime: true });
	const t = Date.now();
	move({ state: "not_home" });
	await places.check(t);
	move({ state: "Office" });
	await places.check(t + 30_000);
	move({ state: "not_home" });
	await places.check(t + 45_000);
	assert.equal((await places.check(t + 90_000)).length, 0, "the clock started over when it came back");
	assert.equal((await places.check(t + 110_000)).length, 1);
	assert.equal(places.list().length, 1, "every time: it stays");
	move({ state: "unknown" });
	assert.equal((await places.check(t + 300_000)).length, 0, "not knowing is no move");
	assert.equal(fired.length, 1);
});

test("said at home, 'when I get home' waits for the next arrival; spots from the map work by distance", async () => {
	const { places, fired, move } = watcher({ state: "home", lat: 51.3406, lon: 12.3747 });
	const { insideNow } = await places.add({ message: "Water the plants", on: "arrive", place: "Home" });
	assert.equal(insideNow, true);
	const pharmacy = await places.add({ message: "Pick up the prescription", on: "arrive", place: "Guten Tag Apotheke", lat: 51.3455, lon: 12.3812 });
	assert.equal(pharmacy.insideNow, false);
	assert.equal(placeWhen(pharmacy.reminder), "when you get to Guten Tag Apotheke");
	const t = Date.now();
	move({ state: "not_home", lat: 51.34552, lon: 12.38118, accuracy: 30 });
	await places.check(t);
	const arrived = await places.check(t + 61_000);
	assert.deepEqual(arrived.map((reminder) => reminder.message), ["Pick up the prescription"], "leaving home isn't arriving");
	assert.equal(fired.length, 1);
	await assert.rejects(places.add({ message: "x", on: "arrive", place: "Gym" }), /no Home Assistant zone called "Gym".*Zones: home, Office/);
	assert.ok(places.cancel(places.list()[0].id));
});
