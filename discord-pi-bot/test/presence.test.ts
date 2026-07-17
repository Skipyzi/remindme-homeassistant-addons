import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "discord.js";
import {
	formatPresenceDuration,
	formatPresenceState,
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

test("formats connected and offline lifetime availability", () => {
	const connected = formatPresenceState(true, snapshot);
	const offline = formatPresenceState(false, {
		...snapshot,
		availabilityPercent: 120,
	});
	assert.equal(connected, "Pi connected • Up 12d 4h • 99.99% • !help");
	assert.equal(offline, "Pi offline • Up 12d 4h • 100.00% • !help");
	assert.equal(connected.length < 128 && offline.length < 128, true);
});

test("reachability still controls Discord status", async () => {
	const calls: Array<Record<string, unknown>> = [];
	await updatePresence(
		fakeClient(calls),
		snapshot,
		async () => true,
	);
	assert.equal(calls[0].status, "online");
	assert.match(JSON.stringify(calls[0]), /99\.99%/);
});

test("presence monitor serializes slow heartbeat ticks", async () => {
	const calls: unknown[] = [];
	let scheduled: (() => void) | undefined;
	let sampleCalls = 0;
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
		schedule: (callback) => {
			scheduled = callback;
			return {} as NodeJS.Timeout;
		},
	});
	assert.equal(calls.length, 1);
	scheduled?.();
	scheduled?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sampleCalls, 1);
	releaseSample?.();
	await new Promise((resolve) => setImmediate(resolve));
	scheduled?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sampleCalls, 2);
});
