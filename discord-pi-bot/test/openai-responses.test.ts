import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decide, streamText } from "../src/agent/llm";
import { EndpointStore } from "../src/harness/endpoints";
import { modelEvents, responsesBody, responseText, strictDecisionSchema } from "../src/harness/responses";

const endpoint = { url: new URL("https://api.openai.com/v1/responses"), model: "gpt-6-luna", headers: { Authorization: "Bearer test-only" }, openaiCompat: true, label: "Luna" };

test("Responses decisions use a strict wrapped union and restore optional fields", async (context) => {
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	let request: Record<string, any> = {};
	globalThis.fetch = (async (_url, init) => {
		request = JSON.parse(String(init?.body));
		return Response.json({ status: "completed", output: [
			{ type: "reasoning" },
			{ type: "message", content: [{ type: "output_text", text: '{"decision":{"action":"home_control","value":null}}' }] },
		], usage: { input_tokens: 20, output_tokens: 10 } });
	}) as typeof fetch;
	const schema = { anyOf: [
		{ type: "object", properties: { action: { const: "home_control" }, value: { type: "string" } }, required: ["action"], additionalProperties: false },
		{ type: "object", properties: { action: { const: "reply" } }, required: ["action"], additionalProperties: false },
	] };
	const result = await decide(endpoint, [{ role: "user", content: "Turn the light on" }], schema);
	assert.deepEqual(result.value, { action: "home_control" });
	assert.equal(request.store, false);
	assert.equal(request.max_output_tokens, 256);
	assert.equal(request.reasoning.effort, "none");
	assert.equal(request.temperature, undefined);
	assert.equal(request.messages, undefined);
	assert.equal(request.text.format.strict, true);
	const branch = request.text.format.schema.properties.decision.anyOf[0];
	assert.deepEqual(branch.required, ["action", "value"]);
	assert.deepEqual(branch.properties.value.anyOf[1], { type: "null" });
	assert.equal(result.metrics.inputTokens, 20);
	assert.equal(result.metrics.outputTokens, 10);
	assert.equal(result.metrics.estimated, false);
});

test("Responses streams answers, reasoning summaries and actual token usage", async (context) => {
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	let request: Record<string, any> = {};
	globalThis.fetch = (async (_url, init) => {
		request = JSON.parse(String(init?.body));
		return new Response([
			{ type: "response.created" },
			{ type: "response.reasoning_summary_text.delta", delta: "Checking." },
			{ type: "response.output_text.delta", delta: "Grüße!" },
			{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 50, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } } } },
		].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	}) as typeof fetch;
	let answer = "";
	let thinking = "";
	const result = await streamText(endpoint, [{ role: "user", content: "Hello" }], { maxTokens: 4096, thinking: true, reasoningBudget: 2048 }, {
		answer: (text) => { answer += text; }, thinking: (text) => { thinking += text; },
	});
	assert.equal(answer, "Grüße!");
	assert.equal(thinking, "Checking.");
	assert.equal(request.reasoning.effort, "medium");
	assert.equal(request.reasoning.summary, "auto");
	assert.equal(result.metrics.thinkingTokens, 20);
	assert.equal(result.metrics.outputTokens, 30);
	assert.equal(result.metrics.truncated, false);
});

test("Responses stream failure and disconnect cannot pass as a completed answer", async (context) => {
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	for (const event of [
		{ type: "response.failed", response: { error: { message: "Quota exhausted" } } },
		{ type: "response.output_text.delta", delta: "Partial" },
	]) {
		globalThis.fetch = (async () => new Response(`data: ${JSON.stringify(event)}\n\n`)) as typeof fetch;
		await assert.rejects(streamText(endpoint, [], { maxTokens: 100, thinking: false }, { answer() {}, thinking() {} }), /Quota exhausted|ended before completing/);
	}
});

test("SSE decoder preserves German text when every UTF-8 byte arrives separately", async () => {
	const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Grüße"}}]}\n\n');
	const body = new ReadableStream<Uint8Array>({ start(controller) {
		for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
		controller.close();
	} });
	const events = [];
	for await (const event of modelEvents(body)) events.push(event);
	assert.equal(events[0].choices[0].delta.content, "Grüße");
});

test("Responses image conversion and refusal handling", () => {
	const body = responsesBody("gpt-6-luna", [{ role: "user", content: [
		{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
	] }], 5) as any;
	assert.deepEqual(body.input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,abc" });
	assert.equal(body.max_output_tokens, 16);
	assert.throws(() => responseText({ output: [{ type: "message", content: [{ type: "refusal", refusal: "Declined" }] }] }), /Declined/);
	assert.equal(strictDecisionSchema({ type: "object", properties: {} }).type, "object");
});

test("endpoint keys persist privately and stay out of public responses after restart", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "luna-endpoints-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "endpoints.json");
	const store = new EndpointStore(path);
	const created = await store.create({ name: "Luna", url: String(endpoint.url), model: endpoint.model, apiKey: "secret-test-value" });
	await store.setActive(created.id);
	const restarted = new EndpointStore(path);
	await restarted.load();
	assert.equal(restarted.active()?.model, "gpt-6-luna");
	assert.equal(restarted.resolve({ url: "http://homeassistant:8080/v1/chat/completions", model: "local" }).headers.Authorization, "Bearer secret-test-value");
	assert.equal(JSON.stringify(restarted.config()).includes("secret-test-value"), false);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});
