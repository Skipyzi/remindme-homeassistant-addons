import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityLog } from "../src/assistant/activity.ts";

test("a message's buttons go once one is tapped, here or from anywhere else that did the same", async () => {
	const log = new ActivityLog(join(mkdtempSync(join(tmpdir(), "activity-")), "activity.json"));
	await log.load();
	const ikea = "sensor.ikea_switch_battery";
	const battery = log.add({ kind: "sent", channel: "nudge", text: "🔋 IKEA switch at 1%.", actions: [{ label: "Remind me Saturday", kind: "battery-remind", ref: ikea }, { label: "Got it", kind: "battery-hide", ref: ikea }] });
	const older = log.add({ kind: "sent", channel: "nudge", text: "🔋 IKEA switch at 3%.", actions: [{ label: "Got it", kind: "battery-hide", ref: ikea }] });
	const reminder = log.add({ kind: "sent", channel: "reminder", text: "Reminder: call the landlord", actions: [{ label: "In 1 hour", kind: "reminder-later", ref: "call the landlord" }] });
	assert.equal(log.get(battery.id)?.actions?.length, 2);
	log.acted(reminder.id, "I'll remind you again in an hour.");
	assert.equal(log.get(reminder.id)?.acted, "I'll remind you again in an hour.");
	// Tapped on the phone or the inbox card: every message with that battery's buttons says so.
	log.settle(ikea, "Reminder set for Saturday at 10:00.");
	assert.equal(log.get(battery.id)?.acted, "Reminder set for Saturday at 10:00.");
	assert.equal(log.get(older.id)?.acted, "Reminder set for Saturday at 10:00.");
	log.settle(ikea, "Hidden until the battery is changed.");
	assert.equal(log.get(battery.id)?.acted, "Reminder set for Saturday at 10:00.", "the first outcome stays");
});
