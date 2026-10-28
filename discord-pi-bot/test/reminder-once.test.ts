import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a reminder that takes long to deliver still goes out once", async () => {
	process.env.REMINDER_DATA_PATH = join(await mkdtemp(join(tmpdir(), "reminder-once-")), "reminders.json");
	const { addReminder, startReminderScheduler, stopReminderSystem } = await import("../src/utils/reminderManager.ts");
	await addReminder("Get a doctor's appointment", 0, "owner", "");
	let deliveries = 0;
	// Delivery slower than the sweep, as with a slow Home Assistant or Discord.
	startReminderScheduler(
		async () => {
			deliveries++;
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { homeAssistant: "delivered", mobile: "skipped", discord: "delivered" };
		},
		{ pollMs: 40 },
	);
	await new Promise((resolve) => setTimeout(resolve, 700));
	stopReminderSystem();
	assert.equal(deliveries, 1);
});
