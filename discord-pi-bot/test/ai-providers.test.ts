import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { ClaudeProvider } from "../src/ai/claude.ts";
import { CompatibleProvider } from "../src/ai/compatible.ts";
import { OpenAiProvider } from "../src/ai/openai.ts";
import type { TurnRequest } from "../src/ai/types.ts";

/* A stand-in API: answers each request with the next scripted SSE body and
 * records what the SDK sent. */
const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
let script: string[] = [];
let base = "";
const server = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		seen.push({ url: request.url || "", headers: request.headers, body: raw ? JSON.parse(raw) : {} });
		const next = script.shift();
		if (next === undefined) {
			response.writeHead(500).end("{}");
			return;
		}
		if (next.startsWith("{")) {
			response.writeHead(200, { "Content-Type": "application/json" }).end(next);
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(next);
	});
});

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function sse(events: Array<[string, unknown]>): string {
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
	return {
		system: "You are RemindMe.",
		context: "Current local time: now.",
		history: [{ role: "assistant", text: "☀️ Morning brief" }],
		prompt: "Is the desk lamp on?",
		tools: [{ name: "find_devices", description: "Find devices", parameters: { type: "object", properties: { query: { type: "string" } } } }],
		webSearch: true,
		effort: "low",
		maxTokens: 1000,
		...overrides,
	};
}

const claudeToolTurn = sse([
	["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Find it first." } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "find_devices", input: {} } }],
	["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query": "desk lamp"}' } }],
	["content_block_stop", { type: "content_block_stop", index: 1 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
	["message_stop", { type: "message_stop" }],
]);

const claudeAnswer = sse([
	["message_start", { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } }],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Yes, at 40%." } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } }],
	["message_stop", { type: "message_stop" }],
]);

test("Claude: a tool round, then the answer, appended without edits", async () => {
	seen.length = 0;
	script = [claudeToolTurn, claudeAnswer];
	const provider = new ClaudeProvider("test-key", "claude-opus-5-5", { baseURL: base });
	const session = provider.start(request());
	const thinking: string[] = [];
	const first = await session.next({ thinking: (delta) => thinking.push(delta) });
	assert.equal(first.stop, "tools");
	assert.deepEqual(first.calls, [{ id: "toolu_1", name: "find_devices", input: { query: "desk lamp" } }]);
	assert.deepEqual(thinking, ["Find it first."]);
	assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 });
	session.answer([{ call: first.calls[0], outcome: { content: '[{"name":"Desk lamp","state":"on at 40%"}]' } }]);
	const text: string[] = [];
	const second = await session.next({ text: (delta) => text.push(delta) });
	assert.equal(second.stop, "end");
	assert.equal(second.text, "Yes, at 40%.");
	assert.deepEqual(text, ["Yes, at 40%."]);

	const [call1, call2] = seen;
	assert.equal(call1.headers.authorization, "Bearer test-key");
	assert.match(String(call1.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
	assert.equal(call1.body.fallbacks, "default");
	assert.equal(call1.body.model, "claude-opus-5-5");
	assert.deepEqual(call1.body.thinking, { type: "adaptive", display: "summarized" });
	assert.deepEqual(call1.body.output_config, { effort: "low" });
	const tools = call1.body.tools as Array<Record<string, unknown>>;
	assert.equal(tools[0].eager_input_streaming, true);
	assert.ok(tools.some((tool) => tool.type === "web_search_20260209"));
	const system = call1.body.system as Array<Record<string, unknown>>;
	assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
	assert.equal(system[1].text, "Current local time: now.");
	// A chat that opens with the assistant's brief still starts with a user turn.
	const messages1 = call1.body.messages as Array<{ role: string }>;
	assert.equal(messages1[0].role, "user");
	assert.equal(messages1[1].role, "assistant");

	// The second request is the first plus the round: thinking block intact, then the result.
	const messages2 = call2.body.messages as Array<{ role: string; content: unknown }>;
	assert.deepEqual(messages2.slice(0, messages1.length), messages1);
	const replayed = messages2[messages1.length].content as Array<Record<string, unknown>>;
	assert.equal(replayed[0].type, "thinking");
	assert.equal(replayed[0].signature, "sig-1");
	const results = messages2[messages1.length + 1].content as Array<Record<string, unknown>>;
	assert.equal(results[0].type, "tool_result");
	assert.equal(results[0].tool_use_id, "toolu_1");
});

test("Claude: Haiku gets no fallback, and a refusal stops the turn", async () => {
	seen.length = 0;
	script = [
		sse([
			["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null }, usage: { output_tokens: 0 } }],
			["message_stop", { type: "message_stop" }],
		]),
	];
	const provider = new ClaudeProvider("k", "claude-haiku-5-5", { baseURL: base });
	const step = await provider.start(request()).next({});
	assert.equal(step.stop, "refused");
	assert.equal(seen[0].body.fallbacks, undefined);
	assert.ok(!String(seen[0].headers["anthropic-beta"] || "").includes("server-side-fallback"));
	const types = (seen[0].body.tools as Array<Record<string, unknown>>).map((tool) => tool.type);
	assert.ok(types.includes("web_search_20250305") && !types.includes("web_search_20260209"), "Haiku gets the basic search tool");
});

test("OpenAI: a function call continues the stored response by id", async () => {
	seen.length = 0;
	const completed = (id: string, output: unknown[]) =>
		sse([
			["response.completed", { type: "response.completed", sequence_number: 1, response: { id, object: "response", created_at: 0, status: "completed", model: "gpt-5.5", output, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 } } }],
		]);
	script = [
		completed("resp_1", [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "find_devices", arguments: '{"query":"lamp"}', status: "completed" }]),
		sse([
			["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "It's on.", sequence_number: 1 }],
		]) + completed("resp_2", [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "It's on.", annotations: [] }] }]),
	];
	const provider = new OpenAiProvider("sk-test", "gpt-5.5", { baseURL: `${base}/v1` });
	const session = provider.start(request());
	const first = await session.next({});
	assert.equal(first.stop, "tools");
	assert.deepEqual(first.calls, [{ id: "call_1", name: "find_devices", input: { query: "lamp" } }]);
	assert.deepEqual(first.usage, { inputTokens: 60, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0 });
	session.answer([{ call: first.calls[0], outcome: { content: "on" } }]);
	const text: string[] = [];
	const second = await session.next({ text: (delta) => text.push(delta) });
	assert.equal(second.text, "It's on.");
	assert.deepEqual(text, ["It's on."]);
	assert.equal(seen[0].headers.authorization, "Bearer sk-test");
	assert.deepEqual(seen[0].body.reasoning, { effort: "low" });
	assert.ok((seen[0].body.tools as Array<{ type: string }>).some((tool) => tool.type === "web_search"));
	assert.equal(seen[1].body.previous_response_id, "resp_1");
	assert.deepEqual(seen[1].body.input, [{ type: "function_call_output", call_id: "call_1", output: "on" }]);
	assert.match(String(seen[1].body.instructions), /You are RemindMe/);
});

test("OpenCode: tool calls arrive in pieces and reasoning goes back", async () => {
	seen.length = 0;
	const chunk = (delta: unknown, finish: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "muse-spark", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	script = [
		chunk({ role: "assistant", reasoning_content: "Look it up." }) +
			chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "find_devices", arguments: '{"que' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"lamp"}' } }] }, "tool_calls") +
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "muse-spark", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\ndata: [DONE]\n\n`,
		chunk({ content: "On, " }) + chunk({ content: "at 40%." }, "stop") + "data: [DONE]\n\n",
	];
	const provider = new CompatibleProvider("opencode", "OpenCode", "oc-key", "muse-spark", `${base}/zen/go/v1`);
	const session = provider.start(request());
	const thinking: string[] = [];
	const first = await session.next({ thinking: (delta) => thinking.push(delta) });
	assert.equal(first.stop, "tools");
	assert.deepEqual(first.calls, [{ id: "call_a", name: "find_devices", input: { query: "lamp" } }]);
	assert.deepEqual(thinking, ["Look it up."]);
	assert.equal(first.usage.inputTokens, 50);
	session.answer([{ call: first.calls[0], outcome: { content: "on" } }]);
	const second = await session.next({});
	assert.equal(second.text, "On, at 40%.");
	assert.equal(seen[0].url, "/zen/go/v1/chat/completions");
	assert.equal(seen[0].headers.authorization, "Bearer oc-key");
	assert.equal(seen[0].body.max_tokens, 1000);
	const messages = seen[1].body.messages as Array<Record<string, unknown>>;
	const assistant = messages.find((message) => message.role === "assistant" && message.tool_calls);
	assert.equal(assistant?.reasoning_content, "Look it up.");
	assert.deepEqual(messages[messages.length - 1], { role: "tool", tool_call_id: "call_a", content: "on" });
	assert.equal((messages[0] as { role: string }).role, "system");
});

test("model lists come from each provider's API", async () => {
	script = [JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }, { id: "text-embedding-3", object: "model" }, { id: "gpt-image-2", object: "model" }], object: "list" })];
	assert.deepEqual(await new OpenAiProvider("k", "x", { baseURL: `${base}/v1` }).listModels(), ["gpt-5.5"]);
	script = [JSON.stringify({ data: [{ id: "glm-5.3-flash" }, { id: "deepseek-v4.1-flash" }], object: "list" })];
	assert.deepEqual(await new CompatibleProvider("opencode", "OpenCode", "k", "x", `${base}/v1`).listModels(), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
});
