import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CalendarChoice, eventTimes, listCalendars } from "../src/connectors/calendar.ts";
import type { EntityCard } from "../src/harness/entities.ts";

test("an event's times are read as the user said them, in local time", () => {
	assert.deepEqual(eventTimes("2026-10-30T10:00"), { data: { start_date_time: "2026-10-30 10:00:00", end_date_time: "2026-10-30 11:00:00" }, label: "Fri 30 Oct, 10:00–11:00" });
	assert.deepEqual(eventTimes("2026-10-30T10:00", "10:45").data, { start_date_time: "2026-10-30 10:00:00", end_date_time: "2026-10-30 10:45:00" });
	assert.deepEqual(eventTimes("2026-10-30T22:30", "2026-10-31T01:00"), { data: { start_date_time: "2026-10-30 22:30:00", end_date_time: "2026-10-31 01:00:00" }, label: "Fri 30 Oct 22:30 to Sat 31 Oct 01:00" });
	assert.equal(eventTimes("2026-12-31T23:30").data.end_date_time, "2027-01-01 00:30:00", "an hour past midnight on New Year's Eve");
});

test("a date alone is an all-day event, and Home Assistant's end is the day after", () => {
	assert.deepEqual(eventTimes("2026-11-02"), { data: { start_date: "2026-11-02", end_date: "2026-11-03" }, label: "Mon 2 Nov, all day" });
	assert.deepEqual(eventTimes("2026-10-30", "2026-11-01"), { data: { start_date: "2026-10-30", end_date: "2026-11-02" }, label: "Fri 30 Oct to Sun 1 Nov, all day" });
});

test("impossible or backwards times are refused", () => {
	assert.throws(() => eventTimes("2026-02-30"), /real date/);
	assert.throws(() => eventTimes("2026-10-30T25:00"), /real date or time/);
	assert.throws(() => eventTimes("tomorrow"), /YYYY-MM-DDTHH:MM/);
	assert.throws(() => eventTimes("2026-10-30T10:00", "09:00"), /before the start/);
	assert.throws(() => eventTimes("2026-11-02", "2026-11-01"), /before the start/);
	assert.throws(() => eventTimes("2026-11-02", "10:00"), /ends on a date/);
	assert.throws(() => eventTimes("2026-11-01", "2026-11-30"), /under 14 days/);
});

test("only calendars that take events are offered for new ones", async () => {
	const card = (entityId: string, name: string, features: number) => ({ entityId, name, domain: entityId.split(".")[0], attributes: { supported_features: features } }) as unknown as EntityCard;
	const home = { cards: async () => [card("calendar.abfall", "Abfall", 0), card("light.desk", "Desk", 44), card("calendar.icloud_home", "Home", 1), card("calendar.ordio_work", "Ordio Work", 7)] };
	assert.deepEqual(await listCalendars(home), [
		{ entityId: "calendar.abfall", name: "Abfall", writable: false },
		{ entityId: "calendar.icloud_home", name: "Home", writable: true },
		{ entityId: "calendar.ordio_work", name: "Ordio Work", writable: true },
	]);
});

test("the chosen calendar survives a restart", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "calendar-")), "calendar.json");
	const choice = new CalendarChoice(path);
	await choice.load();
	assert.equal(choice.newEvents(), undefined);
	await choice.choose("calendar.icloud_home");
	const again = new CalendarChoice(path);
	await again.load();
	assert.equal(again.newEvents(), "calendar.icloud_home");
	await again.choose(undefined);
	await choice.load();
	assert.equal(choice.newEvents(), undefined);
});
