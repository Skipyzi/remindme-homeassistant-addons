import assert from "node:assert/strict";
import test from "node:test";
import { parseWhen } from "../src/commands/remind.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("bare durations parse without a leading 'in'", () => {
	assert.equal(parseWhen("30min"), 30 * MIN);
	assert.equal(parseWhen("30 min"), 30 * MIN);
	assert.equal(parseWhen("30m"), 30 * MIN);
	assert.equal(parseWhen("30 minutes"), 30 * MIN);
	assert.equal(parseWhen("2h"), 2 * HOUR);
	assert.equal(parseWhen("1.5 hours"), 1.5 * HOUR);
	assert.equal(parseWhen("3 days"), 3 * DAY);
	assert.equal(parseWhen("1w"), 7 * DAY);
});

test("a leading 'in' is still accepted", () => {
	assert.equal(parseWhen("in 30 minutes"), 30 * MIN);
	assert.equal(parseWhen("in 2h"), 2 * HOUR);
});

test("junk and bare numbers do not parse (no year-2045 surprise)", () => {
	assert.equal(parseWhen("45"), null);
	assert.equal(parseWhen("gibberish"), null);
	assert.equal(parseWhen(""), null);
});

test("relative day phrases land in the future within sane bounds", () => {
	const tomorrow = parseWhen("tomorrow");
	assert.ok(tomorrow !== null && tomorrow > 0 && tomorrow <= 2 * DAY);
	const friday = parseWhen("friday");
	assert.ok(friday !== null && friday > 0 && friday <= 8 * DAY);
	const next = parseWhen("next monday 6pm");
	assert.ok(next !== null && next > 0 && next <= 8 * DAY);
});

test("an absolute date/time parses", () => {
	const future = new Date(Date.now() + 3 * DAY);
	const iso = future.toISOString().slice(0, 16).replace("T", " ");
	const got = parseWhen(iso);
	assert.ok(got !== null && got > 2 * DAY && got < 4 * DAY);
});
