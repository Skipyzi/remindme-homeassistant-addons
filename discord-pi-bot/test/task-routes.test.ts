import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("task routes create from free text and manage the schedule", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "task-routes-"));
	process.env.TASK_DATA_PATH = join(directory, "tasks.json");
	process.env.VAULT_DATA_PATH = join(directory, "vault");

	const { createHarnessApp } = await import("../src/harness-server.ts");
	const app = createHarnessApp();
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test server address");
	const base = `http://127.0.0.1:${address.port}`;
	context.after(() => server.close());

	// Empty to start.
	assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), []);

	// Create from free text: cadence parsed out, remainder is the prompt.
	const created = await fetch(`${base}/api/tasks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			text: "every day at 8 summarise what happened yesterday",
		}),
	});
	assert.equal(created.status, 201);
	const task = await created.json();
	assert.equal(task.scheduleText, "daily at 08:00");
	assert.equal(task.prompt, "summarise what happened yesterday");
	assert.deepEqual(task.deliver, ["vault", "notify"]);

	// Missing cadence is a 400 with a hint, not a broken task.
	const noWhen = await fetch(`${base}/api/tasks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "just do something vague" }),
	});
	assert.equal(noWhen.status, 400);
	assert.match((await noWhen.json()).error, /schedule/i);

	// Pause it.
	const paused = await fetch(`${base}/api/tasks/${task.id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal((await paused.json()).enabled, false);

	// Reschedule via free text.
	const rescheduled = await fetch(`${base}/api/tasks/${task.id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ scheduleText: "every 6 hours" }),
	});
	assert.equal((await rescheduled.json()).scheduleText, "every 6 hours");

	// Delete.
	const removed = await fetch(`${base}/api/tasks/${task.id}`, {
		method: "DELETE",
	});
	assert.equal(removed.status, 204);
	assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), []);
});
