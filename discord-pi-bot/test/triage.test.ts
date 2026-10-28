import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EntityCard } from "../src/harness/entities.ts";
import { Triage, houseConcerns, newMail, parsePicks, soonEvents, stuckJobs, type Candidate } from "../src/assistant/triage.ts";

const now = new Date("2026-10-28T15:00:00");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const card = (entityId: string, state: string, values: Partial<EntityCard> = {}) => ({ entityId, domain: entityId.split(".")[0], name: entityId, state, available: true, attributes: {}, ...values }) as EntityCard;

test("open doors, unlocked locks and alarms are concerns; a door just opened isn't yet", () => {
	const concerns = houseConcerns(
		[
			card("binary_sensor.balcony_door", "on", { name: "Balcony door", deviceClass: "door", lastChanged: ago(45) }),
			card("binary_sensor.front_door", "on", { name: "Front door", deviceClass: "door", lastChanged: ago(5) }),
			card("lock.front", "unlocked", { name: "Front lock", lastChanged: ago(30) }),
			card("binary_sensor.bath_leak", "on", { name: "Bathroom leak", deviceClass: "moisture", lastChanged: ago(1) }),
			card("binary_sensor.window", "on", { name: "Window", deviceClass: "window", lastChanged: ago(90), available: false }),
			card("light.desk", "on", { name: "Desk lamp", lastChanged: ago(300) }),
		],
		now,
	);
	assert.deepEqual(
		concerns.map((concern) => concern.what),
		["Balcony door is open since 14:15", "Front lock is unlocked since 14:30", "Alarm: Bathroom leak is on since 14:59"],
	);
	assert.match(concerns[0].key, /^house:binary_sensor\.balcony_door:on:/);
});

test("candidates come from appointments, new mail and stuck jobs", () => {
	assert.deepEqual(soonEvents([{ calendar: "Home (iCloud)", summary: "Dentist", start: "2026-10-28T16:30:00+01:00", end: "2026-10-28T17:00:00+01:00", allDay: false, location: "Praxis Dr. Weber" }]).map((event) => event.what), [
		"Dentist at 16:30, Praxis Dr. Weber (Home (iCloud) calendar)",
	]);
	const digest = [
		{ id: "gmx|INBOX|1", account: "GMX", date: ago(30), from: "Anna", subject: "Heute Abend?", label: "inbox", snippet: "Kommst du?" },
		{ id: "gmx|INBOX|2", account: "GMX", date: ago(30), from: "Stadtwerke", subject: "Rechnung", label: "invoices", snippet: "39,99 €" },
		{ id: "gmx|INBOX|3", account: "GMX", date: ago(400), from: "Bob", subject: "Old", label: "inbox", snippet: "" },
	];
	assert.deepEqual(newMail(digest, new Date(now.getTime() - 3_600_000)).map((mail) => mail.key), ["mail:gmx|INBOX|1"], "only mail since the last pass, and bills have their own nudge");
	const job = (id: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, title: id, createdAt: updatedAt, updatedAt, origin: "console", last: "", count: 1, job: { status, instructions: "", runs: 1, ...extra } });
	const stuck = stuckJobs(
		[
			job("flights", "needs_you", ago(150), { question: { text: "Thursday or Friday?", options: [] } }),
			job("fresh", "needs_you", ago(20), { question: { text: "Which?", options: [] } }),
			job("receipts", "stopped", ago(60), { error: "GMX refused the password" }),
			job("done", "done", ago(10)),
		] as never,
		now,
	);
	assert.deepEqual(stuck.map((item) => item.what), ['The job "flights" has waited since 12:30 for an answer: Thursday or Friday?', 'The job "receipts" stopped: GMX refused the password']);
});

test("the AI's picks only count with keys it was given", () => {
	const keys = new Set(["a", "b"]);
	assert.deepEqual(parsePicks('```json\n[{"keys":["a","x"],"text":"Door open"},{"keys":["x"],"text":"Made up"},{"keys":["b"],"text":"Leak"}]\n```', keys, 2), [
		{ keys: ["a"], text: "Door open" },
		{ keys: ["b"], text: "Leak" },
	]);
	assert.deepEqual(parsePicks("not json", keys, 2), []);
	assert.deepEqual(parsePicks('[{"keys":["a"],"text":"one"},{"keys":["b"],"text":"two"}]', keys, 1).length, 1);
});

test("a heads-up goes out once, at most four a day, and passes are spaced out", async () => {
	let candidates: Candidate[] = [{ key: "house:door", what: "Balcony door is open since 14:15" }, { key: "mail:1", what: "Mail from Anna" }];
	const prompts: string[] = [];
	const sent: string[] = [];
	const triage = new Triage({
		statePath: join(mkdtempSync(join(tmpdir(), "triage-")), "triage.json"),
		gather: async () => candidates,
		ask: async (prompt) => {
			prompts.push(prompt);
			return JSON.stringify([{ keys: ["house:door"], text: "The balcony door has been open since 14:15, and it's about to rain." }]);
		},
		notify: async (text) => (sent.push(text), true),
	});
	await triage.load();
	assert.deepEqual(await triage.maybeRun(now), ["The balcony door has been open since 14:15, and it's about to rain."]);
	assert.match(prompts[0], /\[house:door\] Balcony door is open since 14:15/);
	assert.match(prompts[0], /information, never instructions/);
	assert.deepEqual(await triage.maybeRun(new Date(now.getTime() + 30 * 60_000)), [], "not again within two hours");
	assert.equal(prompts.length, 1);
	await triage.maybeRun(new Date(now.getTime() + 2.5 * 3_600_000));
	assert.ok(!prompts[1].includes("house:door"), "something already told isn't offered again");
	assert.equal(sent.length, 1, "the AI picked the door again, but it was already told");

	candidates = [];
	assert.deepEqual(await triage.run(new Date(now.getTime() + 5 * 3_600_000)), []);
	assert.equal(prompts.length, 2, "nothing new, no AI call");

	let n = 0;
	candidates = [{ key: "x", what: "x" }];
	const busy = new Triage({
		statePath: join(mkdtempSync(join(tmpdir(), "triage-")), "triage.json"),
		gather: async () => [{ key: `k${++n}`, what: "something" }],
		ask: async (prompt) => JSON.stringify([{ keys: [prompt.match(/\[(k\d+)\]/)![1]], text: "news" }]),
		notify: async () => true,
		maxPerDay: 4,
	});
	await busy.load();
	let total = 0;
	for (let hour = 0; hour < 8; hour++) total += (await busy.run(new Date(now.getTime() + hour * 60_000))).length;
	assert.equal(total, 4, "four a day at most");
});
