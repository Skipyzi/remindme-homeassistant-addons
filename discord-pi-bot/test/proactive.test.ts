import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CalendarEvent, HomeApi } from "../src/agent/home.ts";
import { normalizeEntity } from "../src/harness/entities.ts";
import type { Assistant } from "../src/assistant/agent.ts";
import { Proactive, binLabel, binNudge, inQuietHours, minutesOf, plainBrief } from "../src/assistant/proactive.ts";

const at = (text: string) => new Date(text);

test("times and quiet hours, including a window across midnight", () => {
	assert.equal(minutesOf("07:30"), 450);
	assert.equal(minutesOf("7.05"), 425);
	assert.equal(minutesOf(""), undefined);
	assert.equal(minutesOf("25:00"), undefined);
	assert.equal(inQuietHours("22:30-07:00", at("2026-10-28T23:00:00")), true);
	assert.equal(inQuietHours("22:30-07:00", at("2026-10-28T06:59:00")), true);
	assert.equal(inQuietHours("22:30-07:00", at("2026-10-28T07:00:00")), false);
	assert.equal(inQuietHours("13:00-14:00", at("2026-10-28T13:30:00")), true);
	assert.equal(inQuietHours("", at("2026-10-28T13:30:00")), false);
});

const event = (calendar: string, summary: string, start: string): CalendarEvent => ({ calendar, summary, start, end: start, allDay: start.length === 10 });

test("bins come from the waste calendar, named in English too", () => {
	assert.equal(binLabel("Blaue Tonne"), "paper (Blaue Tonne)");
	assert.equal(binLabel("Gelbe Tonne"), "packaging (Gelbe Tonne)");
	assert.equal(binLabel("Restmüll"), "residual waste (Restmüll)");
	assert.equal(
		binNudge([event("Abfallkalender", "Blaue Tonne", "2026-10-29"), event("Abfallkalender", "Bio Tonne", "2026-10-29"), event("Dienstplan", "Early shift", "2026-10-29T06:00:00+01:00")]),
		"🗑️ Bins tonight: paper (Blaue Tonne) and organic (Bio Tonne). Collection is tomorrow.",
	);
	assert.equal(binNudge([event("Dienstplan", "Late shift", "2026-10-29T14:00:00+01:00")]), undefined);
});

function setup(options: Partial<{ briefTime: string; binTime: string; quietHours: string; batteryThreshold: number }> = {}) {
	const sent: string[] = [];
	const asks: Array<{ channel: string; extra?: string }> = [];
	const cards = [
		normalizeEntity({ entity_id: "sensor.remote_battery", state: "1", attributes: { friendly_name: "IKEA remote battery", device_class: "battery" } }),
		normalizeEntity({ entity_id: "sensor.door_battery", state: "80", attributes: { friendly_name: "Door battery", device_class: "battery" } }),
	];
	const home = {
		cards: async () => cards,
		calendarEvents: async (start: Date) =>
			start.getDate() === 29 ? [event("Abfallkalender", "Gelbe Tonne", "2026-10-29")] : [event("Abfallkalender", "Gelbe Tonne", "2026-10-29"), event("Dienstplan", "Early shift", "2026-10-28T06:00:00+01:00")],
		serviceResponse: async () => ({}),
	} as unknown as HomeApi;
	const assistant = {
		ask: async (input: { channel: string; extra?: string }) => {
			asks.push(input);
			return { text: "Early shift at 06:00. Yellow bin tonight.", confirms: [], cards: [], artifacts: [] };
		},
	} as unknown as Assistant;
	const proactive = new Proactive({
		assistant,
		home,
		notify: async (text) => {
			sent.push(text);
			return true;
		},
		reminders: async () => [],
		options: { briefTime: "07:00", binTime: "19:00", quietHours: "22:30-07:00", batteryThreshold: 15, ...options },
		statePath: join(mkdtempSync(join(tmpdir(), "proactive-")), "state.json"),
	});
	return { proactive, sent, asks };
}

test("the brief goes out once, after its time, written from gathered facts", async () => {
	const { proactive, sent, asks } = setup({ batteryThreshold: 0 });
	await proactive.tick(at("2026-10-28T06:59:00"));
	assert.equal(sent.length, 0);
	await proactive.tick(at("2026-10-28T07:02:00"));
	await proactive.tick(at("2026-10-28T07:03:00"));
	assert.deepEqual(sent, ["Early shift at 06:00. Yellow bin tonight."]);
	assert.equal(asks[0].channel, "brief");
	assert.match(asks[0].extra || "", /"bins_out_tonight":\["packaging \(Gelbe Tonne\)"\]/);
	assert.match(asks[0].extra || "", /Early shift/);
});

test("a brief missed by hours is skipped rather than sent at night", async () => {
	const { proactive, sent } = setup({ batteryThreshold: 0, binTime: "" });
	await proactive.tick(at("2026-10-28T21:00:00"));
	assert.equal(sent.length, 0);
});

test("the bins nudge comes the evening before, once", async () => {
	const { proactive, sent } = setup({ briefTime: "", batteryThreshold: 0 });
	await proactive.tick(at("2026-10-28T18:00:00"));
	await proactive.tick(at("2026-10-28T19:01:00"));
	await proactive.tick(at("2026-10-28T19:30:00"));
	assert.deepEqual(sent, ["🗑️ Bins tonight: packaging (Gelbe Tonne). Collection is tomorrow."]);
});

test("low batteries are mentioned once a week, never in quiet hours", async () => {
	const { proactive, sent } = setup({ briefTime: "", binTime: "" });
	await proactive.tick(at("2026-10-28T23:30:00"));
	assert.equal(sent.length, 0);
	await proactive.tick(at("2026-10-29T08:00:00"));
	await proactive.tick(at("2026-10-30T08:00:00"));
	assert.deepEqual(sent, ["🔋 IKEA remote at 1%. Time for a new battery."]);
	await proactive.tick(at("2026-11-06T08:00:00"));
	assert.equal(sent.length, 2);
});

test("without the AI, the brief is a plain list of the same facts", () => {
	const text = plainBrief(
		{
			today_and_tomorrow: [event("Dienstplan", "Early shift", "2026-10-28T06:00:00+01:00")],
			bins_out_tonight: ["paper (Blaue Tonne)"],
			weather: { now: "rainy, 11°C" },
			low_batteries: ["IKEA remote battery 1%"],
		},
		"Today's AI budget is used up.",
	);
	assert.equal(
		text,
		[
			"**2026-10-28 06:00** Early shift",
			"**Tonight** paper (Blaue Tonne) out",
			"**Weather** rainy, 11°C",
			"**House** Low batteries: IKEA remote battery 1%",
			"_Plain version: Today's AI budget is used up._",
		].join("\n"),
	);
});
