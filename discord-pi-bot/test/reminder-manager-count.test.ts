import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("counts only active unnotified reminders for the requested owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reminder-count-"));
	process.env.REMINDER_DATA_PATH = join(directory, "reminders.json");
	const {
		deleteReminder,
		getActiveReminderCount,
		setReminder,
	} = await import("../src/utils/reminderManager.ts");
	const delivered = async () => ({ discord: "delivered" as const });
	const ownerReminder = setReminder("owner", 0, "owner", "channel", delivered);
	setReminder("other", 0, "other-user", "channel", delivered);
	assert.equal(getActiveReminderCount("owner"), 1);
	assert.equal(getActiveReminderCount("other-user"), 1);
	assert.equal(getActiveReminderCount(""), 0);
	assert.equal(deleteReminder(ownerReminder.id, "owner"), true);
	assert.equal(getActiveReminderCount("owner"), 0);
	setReminder("delivers", 0, "owner", "channel", delivered);
	assert.equal(getActiveReminderCount("owner"), 1);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(getActiveReminderCount("owner"), 0);
});
