import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BatteryHides, type BatteryKind, batteryHint, batteryShort, lowBatteries } from "../src/assistant/batteries.ts";
import { normalizeEntity } from "../src/harness/entities.ts";

const battery = (id: string, name: string, level: string, attributes: Record<string, unknown> = {}) =>
	normalizeEntity({ entity_id: id, state: level, attributes: { friendly_name: name, device_class: "battery", unit_of_measurement: "%", ...attributes } });
const state = (id: string, value: string) => normalizeEntity({ entity_id: id, state: value, attributes: { friendly_name: id } });

// What the user's Home Assistant reports: a phone with the Companion app, a Sonos Roam with a charging sensor, an IKEA switch on Zigbee.
const kinds = new Map<string, BatteryKind>([
	["sensor.iphone_battery_level", { companion: true, rechargeable: true, chargers: ["sensor.iphone_battery_state"] }],
	["sensor.roam_battery", { companion: false, rechargeable: true, chargers: ["binary_sensor.roam_charging"] }],
	["sensor.switch_battery", { companion: false, rechargeable: false, chargers: [] }],
]);
const cards = (roamCharging = "off", switchLevel = "1") => [
	battery("sensor.iphone_battery_level", "iPhone von Gabor Battery Level", "15"),
	state("sensor.iphone_battery_state", "Not Charging"),
	battery("sensor.roam_battery", "Wohnzimmer Battery", "9"),
	state("binary_sensor.roam_charging", roamCharging),
	battery("sensor.switch_battery", "IKEA of Sweden TRADFRI on/off switch Battery", switchLevel, { battery_size: "CR2032", battery_quantity: 1 }),
	battery("sensor.door_battery", "Door Battery", "80", { battery_size: "AAA", battery_quantity: 2 }),
];

test("a phone warns about itself, a speaker needs charging, a switch needs the battery it names", () => {
	const low = lowBatteries(cards(), kinds, 15);
	assert.deepEqual(low, [
		{ entityId: "sensor.roam_battery", name: "Wohnzimmer", level: 9, rechargeable: true },
		{ entityId: "sensor.switch_battery", name: "IKEA of Sweden TRADFRI on/off switch", level: 1, rechargeable: false, battery: "CR2032" },
	]);
	assert.deepEqual(low.map(batteryHint), ["Needs charging.", "Needs a new CR2032."]);
	assert.deepEqual(low.map(batteryShort), ["charge it", "new CR2032"]);
	assert.equal(batteryHint({ rechargeable: false }), "Time for a new battery.");
	assert.equal(batteryShort({ rechargeable: false, battery: "2 × AAA" }), "new 2 × AAA");
});

test("a speaker on its charger isn't low; without the device lookup, names still tell a phone", () => {
	assert.deepEqual(lowBatteries(cards("on"), kinds, 15).map((entry) => entry.entityId), ["sensor.switch_battery"]);
	const guessed = lowBatteries([battery("sensor.pixel_battery", "Pixel 9 Battery", "8"), battery("sensor.remote_battery", "Remote Battery", "5", { battery_size: "AAA", battery_quantity: 2 })], new Map(), 15);
	assert.deepEqual(guessed, [
		{ entityId: "sensor.pixel_battery", name: "Pixel 9", level: 8, rechargeable: true },
		{ entityId: "sensor.remote_battery", name: "Remote", level: 5, rechargeable: false, battery: "2 × AAA" },
	]);
});

test("a reminder hides the card until it's due; Got it until the battery is changed; an outage forgets nothing", async () => {
	const hides = new BatteryHides(join(mkdtempSync(join(tmpdir(), "batteries-")), "batteries.json"));
	await hides.load();
	const now = new Date("2026-10-28T18:00:00");
	const saturday = new Date("2026-10-31T10:00:00");
	const low = lowBatteries(cards(), kinds, 15);
	await hides.hide("sensor.switch_battery", saturday, now);
	await hides.hide("sensor.roam_battery", undefined, now);
	assert.deepEqual(await hides.visible(low, cards(), 15, now), []);
	assert.deepEqual(await hides.visible(low, [], 15, now), [], "Home Assistant away: still hidden");

	const reloaded = new BatteryHides((hides as unknown as { path: string }).path);
	await reloaded.load();
	assert.deepEqual((await reloaded.visible(low, cards(), 15, new Date("2026-10-31T10:01:00"))).map((entry) => entry.entityId), ["sensor.switch_battery"], "the reminder is due and it's still low");

	// A new battery: the hide is forgotten, so the next time it runs low the card is back.
	await reloaded.visible([], [battery("sensor.roam_battery", "Wohnzimmer Battery", "100")], 15, now);
	assert.deepEqual((await reloaded.visible(low, cards(), 15, now)).map((entry) => entry.entityId), ["sensor.roam_battery", "sensor.switch_battery"]);
});
