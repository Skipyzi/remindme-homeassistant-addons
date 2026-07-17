import assert from "node:assert/strict";
import test from "node:test";
import { RestartController } from "../src/harness/restart.ts";

test("restart is scheduled only after the request can return", async () => {
	let timer: (() => void) | undefined;
	let calls = 0;
	const controller = new RestartController(
		async () => {
			calls += 1;
		},
		300,
		(callback) => {
			timer = callback;
			return 1;
		},
	);

	const accepted = controller.schedule();
	assert.deepEqual(accepted, { accepted: true });
	assert.equal(calls, 0);
	assert.ok(timer);
	await timer?.();
	assert.equal(calls, 1);
});

test("concurrent restart requests are rejected", () => {
	const controller = new RestartController(
		async () => {},
		300,
		() => 1,
	);
	controller.schedule();
	assert.throws(() => controller.schedule(), /already in progress/i);
});
