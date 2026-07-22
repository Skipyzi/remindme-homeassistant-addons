import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	TaskStore,
	computeNextRun,
	describeSchedule,
	extractSchedule,
	parseSchedule,
} from "../src/harness/taskStore.ts";

test("parses interval, daily, and weekly cadences", () => {
	assert.deepEqual(parseSchedule("every 30 minutes"), {
		kind: "interval",
		minutes: 30,
	});
	assert.deepEqual(parseSchedule("every 2 hours"), {
		kind: "interval",
		minutes: 120,
	});
	assert.deepEqual(parseSchedule("daily at 8"), { kind: "daily", time: "08:00" });
	assert.deepEqual(parseSchedule("every day at 7:30am"), {
		kind: "daily",
		time: "07:30",
	});
	assert.deepEqual(parseSchedule("weekly on monday at 9"), {
		kind: "weekly",
		weekday: 1,
		time: "09:00",
	});
	assert.deepEqual(parseSchedule("fridays at 6pm"), {
		kind: "weekly",
		weekday: 5,
		time: "18:00",
	});
	// A bare hour is read literally for a schedule, not bumped to the evening.
	assert.deepEqual(parseSchedule("at 6"), { kind: "daily", time: "06:00" });
	assert.equal(parseSchedule("whenever i feel like it"), undefined);
});

test("extractSchedule lifts the cadence out and keeps the instruction", () => {
	const daily = extractSchedule("every day at 8 summarise what happened yesterday");
	assert.deepEqual(daily.schedule, { kind: "daily", time: "08:00" });
	assert.equal(daily.rest, "summarise what happened yesterday");

	const research = extractSchedule(
		"find the cheapest RTX 4090 and list every listing, every 6 hours",
	);
	assert.deepEqual(research.schedule, { kind: "interval", minutes: 360 });
	assert.equal(
		research.rest,
		"find the cheapest RTX 4090 and list every listing,",
	);

	const weekly = extractSchedule("mondays at 9 to send the weekly digest");
	assert.deepEqual(weekly.schedule, { kind: "weekly", weekday: 1, time: "09:00" });
	assert.equal(weekly.rest, "send the weekly digest");

	// No cadence: schedule undefined, whole text kept.
	const none = extractSchedule("just do a thing");
	assert.equal(none.schedule, undefined);
	assert.equal(none.rest, "just do a thing");
});

test("computeNextRun finds the next slot strictly after now", () => {
	const monday9 = new Date("2026-07-20T09:00:00"); // a Monday
	// Interval steps from the given moment.
	assert.equal(
		computeNextRun({ kind: "interval", minutes: 90 }, monday9).toISOString(),
		new Date("2026-07-20T10:30:00").toISOString(),
	);
	// Daily at 08:00 has already passed today, so it rolls to tomorrow.
	const daily = computeNextRun({ kind: "daily", time: "08:00" }, monday9);
	assert.equal(daily.getDate(), 21);
	assert.equal(daily.getHours(), 8);
	// Weekly on Monday, but 09:00 is now, so next is a week out.
	const weekly = computeNextRun(
		{ kind: "weekly", weekday: 1, time: "09:00" },
		monday9,
	);
	assert.equal(weekly.getDate(), 27);
});

test("describeSchedule reads back in words", () => {
	assert.equal(describeSchedule({ kind: "interval", minutes: 60 }), "every 1 hour");
	assert.equal(describeSchedule({ kind: "daily", time: "08:00" }), "daily at 08:00");
	assert.equal(
		describeSchedule({ kind: "weekly", weekday: 1, time: "09:00" }),
		"every monday at 09:00",
	);
});

test("store creates, lists due, records a run, and rolls forward", async () => {
	const directory = await mkdtemp(join(tmpdir(), "task-store-"));
	const store = new TaskStore(join(directory, "tasks.json"));
	await store.load();

	const task = await store.create({
		name: "Morning recap",
		prompt: "Summarise what happened yesterday.",
		schedule: { kind: "interval", minutes: 60 },
		deliver: ["vault", "notify"],
	});
	assert.equal(task.deliver.length, 2);
	assert.ok(new Date(task.nextRun) > new Date());

	// Force it due, then confirm due() sees it.
	await store.update(task.id, {});
	task.nextRun = new Date(Date.now() - 1000).toISOString();
	// Persist the forced time through a real field update path.
	const forced = store.get(task.id);
	if (forced) forced.nextRun = new Date(Date.now() - 1000).toISOString();
	assert.equal(store.due().length, 1);

	const ran = await store.recordRun(task.id, {
		status: "ok",
		summary: "Nothing much.",
		notePath: "tasks/2026-07-23-morning-recap.md",
	});
	assert.ok(ran);
	assert.equal(ran.lastStatus, "ok");
	assert.equal(ran.lastNotePath, "tasks/2026-07-23-morning-recap.md");
	// Next run rolled forward past now.
	assert.ok(new Date(ran.nextRun) > new Date());
	assert.equal(store.due().length, 0);

	// Survives reload.
	const reloaded = new TaskStore(join(directory, "tasks.json"));
	await reloaded.load();
	assert.equal(reloaded.list().length, 1);
	assert.equal(reloaded.get(task.id)?.name, "Morning recap");
});

test("invalid delivery targets fall back to the default set", async () => {
	const directory = await mkdtemp(join(tmpdir(), "task-delivery-"));
	const store = new TaskStore(join(directory, "tasks.json"));
	await store.load();
	const task = await store.create({
		name: "x",
		prompt: "y",
		schedule: { kind: "daily", time: "08:00" },
		deliver: ["telepathy"] as never,
	});
	assert.deepEqual(task.deliver, ["vault", "notify"]);
});
