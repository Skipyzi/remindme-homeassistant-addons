import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("counts only active unnotified reminders for the requested owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reminder-count-"));
	const dataPath = join(directory, "reminders.json");
	process.env.REMINDER_DATA_PATH = dataPath;
	const { addReminder, countReminders, deleteReminder } = await import(
		"../src/utils/reminderManager.ts"
	);
	const ownerReminder = await addReminder("owner", 10, "owner", "channel");
	await addReminder("other", 10, "other-user", "channel");
	assert.equal(await countReminders("owner"), 1);
	assert.equal(await countReminders("other-user"), 1);
	assert.equal(await countReminders(""), 0);
	assert.equal(await deleteReminder(ownerReminder.id, "owner"), true);
	assert.equal(await countReminders("owner"), 0);

	const delivered = await addReminder("delivers", 0, "owner", "channel");
	assert.equal(await countReminders("owner"), 1);
	const stored = JSON.parse(await readFile(dataPath, "utf8")) as Array<{
		id: string;
		notified: boolean;
	}>;
	const deliveredRecord = stored.find((item) => item.id === delivered.id);
	assert.ok(deliveredRecord);
	deliveredRecord.notified = true;
	await writeFile(dataPath, JSON.stringify(stored), "utf8");
	assert.equal(await countReminders("owner"), 0);
});
