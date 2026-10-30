import assert from "node:assert/strict";
import test from "node:test";
import { type Fix, UserLocation, roughly, whereLine } from "../src/assistant/location.ts";

const zones = [
	{ id: "zone.home", name: "Home", lat: 51.3406, lon: 12.3747, radius: 100 },
	{ id: "zone.work", name: "Klinikum", lat: 51.33, lon: 12.39, radius: 200 },
];
const now = new Date("2026-10-30T12:00:00Z");

test("each turn hears roughly where the user is, never the coordinates", () => {
	const away: Fix = { state: "not_home", lat: 51.333, lon: 12.3975, accuracy: 3, zones, at: "2026-10-30T11:55:00Z" };
	const line = whereLine(away, now)!;
	assert.match(line, /away from home, about 2 km from it \(reported 5 minutes ago\)/);
	assert.doesNotMatch(line, /51\.3|12\.39/);
	assert.match(whereLine({ ...away, state: "home", at: "2026-10-30T00:09:00Z" }, now)!, /at home \(reported 12 hours ago, so it may be out of date\)/);
	assert.match(whereLine({ ...away, state: "Klinikum" }, now)!, /at Klinikum/);
	assert.equal(whereLine({ ...away, state: "unknown" }, now), undefined);
	assert.equal(roughly(240), "about 200 m");
	assert.equal(roughly(12_400), "about 12 km");
});

test("an old report is refreshed by asking the phone, then the address is looked up", async () => {
	let fix: Fix = { state: "not_home", lat: 51.333, lon: 12.3975, accuracy: 3, zones, at: "2026-10-30T00:09:00Z" };
	let asked = 0;
	const location = new UserLocation({
		read: async () => fix,
		askPhone: async () => {
			asked++;
			setTimeout(() => (fix = { ...fix, lat: 51.3401, lon: 12.3749, state: "home", at: "2026-10-30T11:59:50Z" }), 5);
			return true;
		},
		address: async (lat) => (lat > 51.34 ? "Lützowstraße 1, Gohlis, 04155 Leipzig" : "Riebeckstraße 12, 04317 Leipzig"),
		now: () => now,
		pollMs: 10,
		waitMs: 500,
	});
	const here = (await location.locate())!;
	assert.equal(asked, 1);
	assert.equal(here.askedPhone, "answered");
	assert.equal(here.where, "home");
	assert.equal(here.address, "Lützowstraße 1, Gohlis, 04155 Leipzig");
	assert.equal(here.fresh, true);
	assert.equal(here.lat, 51.3401);

	// A fresh report needs no asking.
	const again = (await location.locate())!;
	assert.equal(asked, 1);
	assert.equal(again.askedPhone, undefined);
});

test("a phone that doesn't answer leaves the last report, said as old", async () => {
	const fix: Fix = { state: "not_home", lat: 51.333, lon: 12.3975, zones, at: "2026-10-30T00:09:00Z" };
	const location = new UserLocation({ read: async () => fix, askPhone: async () => true, now: () => now, pollMs: 5, waitMs: 30 });
	const here = (await location.locate())!;
	assert.equal(here.askedPhone, "no answer");
	assert.equal(here.fresh, false);
	assert.equal(here.metresFromHome, 1795);
	const none = await new UserLocation({ read: async () => undefined }).locate();
	assert.equal(none, undefined);
});

test("find_place searches a kind of place around the user when asked for near me", async () => {
	const { buildTools, newEffects, runTool } = await import("../src/assistant/tools.ts");
	const { ConfirmationStore } = await import("../src/assistant/confirmations.ts");
	const asked: Array<{ kind: string; around?: { lat: number; lon: number }; speciality?: string }> = [];
	const place = { name: "Praxis für Kieferorthopädie", lat: 51.3375, lon: 12.3672, address: "Beethovenstraße 8, 04107 Leipzig", away: 935, from: "you" as const, speciality: "orthodontics" };
	const tools = await buildTools(
		{
			confirmations: new ConfirmationStore(),
			reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false },
			places: {
				find: async () => [],
				nearby: async (kind, options) => (asked.push({ kind, ...options }), { places: [place], km: 1.5, from: options.around ? ("you" as const) : ("home" as const) }),
			},
			location: { locate: async () => ({ where: "away", lat: 51.3397, lon: 12.3731, fresh: true }) },
		},
		{ nativeWebSearch: true },
	);
	const result = await runTool(tools, { id: "1", name: "find_place", input: { kind: "orthodontist", near_user: true } }, newEffects());
	const data = JSON.parse(result.content);
	assert.deepEqual(asked[0], { kind: "orthodontist", around: { lat: 51.3397, lon: 12.3731 }, speciality: undefined });
	assert.equal(data.searched, "Searched within 1.5 km of the user, closest first.");
	assert.equal(data.places[0].metres_from_user, 935);
	assert.equal(data.places[0].speciality, "orthodontics");
	assert.ok(tools.find((tool) => tool.spec.name === "user_location"), "where the user is can be looked up");
});
