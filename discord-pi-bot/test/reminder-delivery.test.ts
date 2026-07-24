import assert from "node:assert/strict";
import test from "node:test";
import {
	deliverReminder,
	deliveryTargets,
} from "../src/harness/reminderDelivery.ts";
import type { Reminder } from "../src/utils/reminderManager.ts";

const OWNER = "owner-123";

function reminder(overrides: Partial<Reminder> = {}): Reminder {
	return {
		id: "rem_1",
		message: "call mum",
		time: new Date(),
		createdAt: new Date(),
		userId: OWNER,
		channelId: "",
		notified: false,
		...overrides,
	};
}

test("an owner's private (channel-less) reminder targets all three, incl. a Discord DM", () => {
	const targets = deliveryTargets(reminder(), OWNER);
	assert.equal(targets.homeAssistant, "pending");
	assert.equal(targets.mobile, "pending");
	// The point of the fix: no channel no longer means Discord is skipped.
	assert.equal(targets.discord, "pending");
});

test("a non-owner's channel reminder is Discord-only", () => {
	const targets = deliveryTargets(
		reminder({ userId: "someone-else", channelId: "chan-9" }),
		OWNER,
	);
	assert.equal(targets.homeAssistant, "skipped");
	assert.equal(targets.mobile, "skipped");
	assert.equal(targets.discord, "pending");
});

test("a reminder with neither channel nor user is genuinely undeliverable on Discord", () => {
	const targets = deliveryTargets(
		reminder({ userId: "", channelId: "" }),
		OWNER,
	);
	assert.equal(targets.discord, "skipped");
});

test("deliverReminder marks the channel-less owner reminder delivered via the DM adapter", async () => {
	let dmed = "";
	const status = await deliverReminder(reminder(), OWNER, {
		homeAssistant: async () => {},
		mobile: async () => {},
		discord: async (rem) => {
			dmed = rem.userId;
		},
	});
	assert.equal(dmed, OWNER);
	assert.equal(status.discord, "delivered");
	assert.equal(status.homeAssistant, "delivered");
});

test("a failed Discord delivery is reported as failed so it retries", async () => {
	const status = await deliverReminder(reminder(), OWNER, {
		homeAssistant: async () => {},
		mobile: async () => {},
		discord: async () => {
			throw new Error("network");
		},
	});
	assert.equal(status.discord, "failed");
});
