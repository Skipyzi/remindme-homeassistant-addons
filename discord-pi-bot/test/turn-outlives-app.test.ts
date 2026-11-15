import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/*
 * The phone app drops its connection when it goes to the background or
 * closes. The turn must still run to its end and leave its answer in the
 * thread; only Stop ends it.
 */
test("a chat turn outlives the app's connection, and Stop still ends it", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "turn-outlives-"));
	process.env.THREADS_DATA_PATH = join(directory, "threads.json");
	process.env.TASK_DATA_PATH = join(directory, "tasks.json");
	process.env.VAULT_DATA_PATH = join(directory, "vault");

	const harness = await import("../src/harness-server.ts");
	const asks: Array<{ signal?: AbortSignal; finish: (text: string) => void }> = [];
	harness.assistant.ask = ((input: { signal?: AbortSignal }) =>
		new Promise((resolve, reject) => {
			input.signal?.addEventListener("abort", () => reject(new Error("Assistant turn cancelled")), { once: true });
			asks.push({
				signal: input.signal,
				finish: (text) => resolve({ text, confirms: [], cards: [], embeds: [], artifacts: [], did: [], model: "stub", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rounds: 1 }),
			});
		})) as typeof harness.assistant.ask;

	const server = harness.createHarnessApp().listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test server address");
	const base = `http://127.0.0.1:${address.port}`;
	context.after(() => server.close());

	const waitFor = async (check: () => Promise<boolean>) => {
		for (let tries = 0; tries < 100; tries++) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Timed out");
	};
	const thread = async (id: string) => (await fetch(`${base}/api/threads/${id}`)).json();

	/* Send, read until the server names the thread, then drop the connection like a locked phone. */
	const sendAndLeave = async (message: string) => {
		const leave = new AbortController();
		const response = await fetch(`${base}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }), signal: leave.signal });
		const reader = response.body!.getReader();
		let text = "";
		while (!/event: thread\ndata: (.+)\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
		const id = JSON.parse(/event: thread\ndata: (.+)\n/.exec(text)![1]).id as string;
		leave.abort();
		await reader.cancel().catch(() => {});
		return id;
	};

	const first = await sendAndLeave("Start a background task for me");
	await waitFor(async () => asks.length === 1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(asks[0].signal?.aborted, false, "closing the app must not cancel the turn");
	assert.equal((await thread(first)).answering, true);

	// A second message while it still answers is turned away rather than run alongside.
	const twice = await fetch(`${base}/api/threads/${first}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "again" }) });
	assert.equal(twice.status, 409);

	asks[0].finish("Done: the task is running.");
	await waitFor(async () => (await thread(first)).answering === false);
	const answered = await thread(first);
	assert.equal(answered.messages.at(-1).role, "assistant");
	assert.equal(answered.messages.at(-1).text, "Done: the task is running.");

	// Stop is what ends a turn now, even with nobody connected.
	const second = await sendAndLeave("Something long");
	await waitFor(async () => asks.length === 2);
	const stopped = await fetch(`${base}/api/threads/${second}/stop`, { method: "POST" });
	assert.equal(stopped.status, 200);
	await waitFor(async () => (await thread(second)).answering === false);
	assert.equal(asks[1].signal?.aborted, true);
	assert.equal((await thread(second)).messages.at(-1).text, "(Stopped before answering.)");
});
