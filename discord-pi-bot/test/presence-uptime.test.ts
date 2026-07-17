import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PresenceUptimeTracker } from "../src/presenceUptime.ts";

function testTracker(path: string, clock: { now: number }, sessionId: string) {
	return new PresenceUptimeTracker(path, {
		now: () => clock.now,
		sessionId: () => sessionId,
		logError: () => {},
	});
}

test("first run persists secure state and accrues same-session uptime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "presence-uptime-"));
	const path = join(directory, "uptime.json");
	const clock = { now: 1_000_000 };
	const tracker = testTracker(path, clock, "session-a");
	const initial = await tracker.initialize();
	assert.equal(initial.totalOnlineMs, 0);
	assert.equal(initial.availabilityPercent, 100);
	clock.now += 90_000;
	const sampled = await tracker.sample();
	assert.equal(sampled.totalOnlineMs, 90_000);
	assert.equal(sampled.availabilityPercent, 100);
	const persisted = await new Response(await readFile(path)).json();
	assert.equal(persisted.version, 1);
	assert.equal(persisted.sessionId, "session-a");
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
});

test("restart excludes stopped gap from uptime and includes it in availability", async () => {
	const directory = await mkdtemp(join(tmpdir(), "presence-uptime-"));
	const path = join(directory, "uptime.json");
	const clock = { now: 0 };
	const first = testTracker(path, clock, "session-a");
	await first.initialize();
	clock.now = 60_000;
	await first.sample();
	clock.now = 360_000;
	const second = testTracker(path, clock, "session-b");
	await second.initialize();
	clock.now = 420_000;
	const sampled = await second.sample();
	assert.equal(sampled.totalOnlineMs, 120_000);
	assert.equal(sampled.availabilityPercent, (120_000 / 420_000) * 100);
});

test("backward time never subtracts accumulated uptime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "presence-uptime-"));
	const path = join(directory, "uptime.json");
	const clock = { now: 10_000 };
	const tracker = testTracker(path, clock, "session-a");
	await tracker.initialize();
	clock.now = 5_000;
	assert.equal((await tracker.sample()).totalOnlineMs, 0);
});

test("corrupt and unsupported state is quarantined", async () => {
	for (const contents of [
		"not json",
		JSON.stringify({
			version: 2,
			trackingStartedAt: 2_000,
			totalOnlineMs: 0,
			lastHeartbeatAt: 2_000,
			sessionId: "old",
		}),
	]) {
		const directory = await mkdtemp(join(tmpdir(), "presence-uptime-"));
		const path = join(directory, "uptime.json");
		await writeFile(path, contents);
		const tracker = testTracker(path, { now: 1_000 }, "fresh");
		const snapshot = await tracker.initialize();
		assert.equal(snapshot.totalOnlineMs, 0);
		assert.equal(snapshot.trackingStartedAt, 1_000);
		assert.equal(
			(await readdir(directory)).some((name) => name.includes(".corrupt")),
			true,
		);
	}
});

test("storage errors remain nonfatal and credential-free", async () => {
	const directory = await mkdtemp(join(tmpdir(), "presence-uptime-"));
	const blockedParent = join(directory, "not-a-directory");
	await writeFile(blockedParent, "blocked");
	const messages: string[] = [];
	const tracker = new PresenceUptimeTracker(join(blockedParent, "uptime.json"), {
		now: () => 1_000,
		sessionId: () => "session-secret-not-for-log",
		logError: (message) => messages.push(message),
	});
	const snapshot = await tracker.initialize();
	assert.equal(snapshot.availabilityPercent, 100);
	assert.equal(messages.length > 0, true);
	assert.equal(messages.join(" ").includes("session-secret-not-for-log"), false);
});
