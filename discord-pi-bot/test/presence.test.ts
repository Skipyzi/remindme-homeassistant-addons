import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "discord.js";
import {
	formatPresenceActivity,
	formatPresenceDuration,
	startPresenceMonitor,
	updatePresence,
} from "../src/presence.ts";
import type { UptimeSnapshot } from "../src/presenceUptime.ts";

const snapshot: UptimeSnapshot = {
	totalOnlineMs: 12 * 86_400_000 + 4 * 3_600_000,
	availabilityPercent: 99.987,
	trackingStartedAt: 0,
	lastHeartbeatAt: 1,
};

function fakeClient(calls: unknown[]): Client {
	return {
		user: {
			setPresence: (value: unknown) => calls.push(value),
		},
	} as unknown as Client;
}

test("formats concise uptime durations", () => {
	assert.equal(formatPresenceDuration(0), "0m");
	assert.equal(formatPresenceDuration(47 * 60_000), "47m");
	assert.equal(formatPresenceDuration(3 * 3_600_000 + 8 * 60_000), "3h 8m");
	assert.equal(
		formatPresenceDuration(12 * 86_400_000 + 4 * 3_600_000),
		"12d 4h",
	);
});

test("formats health name and bot metrics state", () => {
	const connected = formatPresenceActivity(true, snapshot, 1);
	const offline = formatPresenceActivity(
		false,
		{ ...snapshot, availabilityPercent: 120 },
		3,
	);
	const invalid = formatPresenceActivity(true, snapshot, Number.NaN);
	assert.deepEqual(connected, {
		name: "RemindMe • Pi connected",
		state: "Up 12d 4h • 99.99% • 1 reminder",
	});
	assert.deepEqual(offline, {
		name: "RemindMe • Pi offline",
		state: "Up 12d 4h • 100.00% • 3 reminders",
	});
	assert.match(invalid.state, /0 reminders$/);
	for (const activity of [connected, offline, invalid]) {
		assert.equal(activity.name.length < 128, true);
		assert.equal(activity.state.length < 128, true);
	}
});

test("reachability still controls Discord status", async () => {
	const calls: Array<Record<string, unknown>> = [];
	await updatePresence(
		fakeClient(calls),
		snapshot,
		async () => true,
		() => 2,
	);
	assert.equal(calls[0].status, "online");
	assert.match(JSON.stringify(calls[0]), /RemindMe • Pi connected/);
	assert.match(JSON.stringify(calls[0]), /2 reminders/);
});

test("presence monitor serializes slow heartbeat ticks", async () => {
	const calls: unknown[] = [];
	let scheduled: (() => void) | undefined;
	let sampleCalls = 0;
	let reminderCountCalls = 0;
	let releaseSample: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		releaseSample = resolve;
	});
	const tracker = {
		initialize: async () => snapshot,
		sample: async () => {
			sampleCalls++;
			if (sampleCalls === 1) await pending;
			return snapshot;
		},
	};
	await startPresenceMonitor(fakeClient(calls), {
		tracker,
		reachable: async () => true,
		reminderCount: () => ++reminderCountCalls,
		schedule: (callback) => {
			scheduled = callback;
			return {} as NodeJS.Timeout;
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(reminderCountCalls, 1);
	scheduled?.();
	scheduled?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sampleCalls, 1);
	releaseSample?.();
	await new Promise((resolve) => setImmediate(resolve));
	scheduled?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sampleCalls, 2);
	assert.equal(reminderCountCalls, 3);
	assert.match(JSON.stringify(calls.at(-1)), /3 reminders/);
});

test("reminder count failures fall back to zero", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const originalError = console.error;
	console.error = () => {};
	try {
		await updatePresence(
			fakeClient(calls),
			snapshot,
			async () => false,
			() => {
				throw new Error("private reminder failure");
			},
		);
	} finally {
		console.error = originalError;
	}
	assert.equal(calls[0].status, "idle");
	assert.match(JSON.stringify(calls[0]), /0 reminders/);
	assert.doesNotMatch(JSON.stringify(calls[0]), /private reminder failure/);
});
