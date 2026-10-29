// The CLI agents end to end, without any account: the real Codex CLI against
// a simulated ChatGPT, and a stand-in Claude Code CLI, both reaching
// RemindMe's tools through the real bridge. Run after a build:
//   pnpm test:agents
// No credentials, provider requests or device calls leave this process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const base = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remindme-agents-"));
process.env.AGENT_DATA_DIR = directory;
process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude");
process.env.CLAUDE_CLI_PATH = path.join(base, "test/fixtures/claude-cli.cjs");
process.env.CHATGPT_AUTH_PATH = path.join(directory, "unused-auth.json");

const express = require(path.join(base, "node_modules/express"));
const { registerBridge } = require(path.join(base, "dist/agents/bridge"));
const { RunnerThreads } = require(path.join(base, "dist/agents/threads"));
const { Assistant } = require(path.join(base, "dist/assistant/agent"));
const { ConfirmationStore } = require(path.join(base, "dist/assistant/confirmations"));
const { SpendLedger } = require(path.join(base, "dist/ai/spend"));
const { HomeApi } = require(path.join(base, "dist/agent/home"));
const { chatgptAuth } = require(path.join(base, "dist/subscriptions/chatgptAuth"));
chatgptAuth.accessToken = async () => "fixture-token-never-sent-remotely";

/* A simulated ChatGPT: call house_overview first, then answer from its result. */
const realFetch = global.fetch;
let requests = [];
function chatgpt(body) {
	const answered = (body.input || []).some((item) => item.type === "function_call_output");
	const item = answered
		? { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The fixture house has the desk lamp on.", annotations: [] }] }
		: { type: "function_call", id: "fc_test", call_id: "call_test", name: "house_overview", arguments: "{}", status: "completed" };
	const response = { id: "resp_test", object: "response", created_at: 1, status: "completed", model: "gpt-fixture", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
	const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: answered ? { ...item, content: [] } : { ...item, arguments: "" } }];
	if (answered)
		events.push(
			{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: item.content[0].text },
			{ type: "response.output_text.done", output_index: 0, content_index: 0, text: item.content[0].text },
			{ type: "response.content_part.done", output_index: 0, content_index: 0, part: item.content[0] },
		);
	else events.push({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }, { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" });
	events.push({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response });
	return new Response(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, item_id: "msg_test", sequence_number: index })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
global.fetch = async (input, init) => {
	if (String(input) === "https://api.openai.com/v1/responses") {
		const body = JSON.parse(init.body);
		requests.push(body);
		assert.equal(body.store, false);
		assert.ok(body.tools.some((tool) => tool.name === "house_overview"), "Codex must offer RemindMe's tools to the model");
		assert.ok(!body.tools.some((tool) => /shell|apply_patch|exec/.test(tool.name || tool.type)), "no coding tools");
		return chatgpt(body);
	}
	return realFetch(input, init);
};

/* A small house: one lamp on, read through the real HomeApi. */
const states = [
	{ entity_id: "light.desk", state: "on", attributes: { friendly_name: "Desk lamp", supported_color_modes: ["xy"], brightness: 100 } },
	{ entity_id: "lock.front", state: "locked", attributes: { friendly_name: "Front door" } },
];
const home = new HomeApi("unused", "http://ha/api", async (url) => {
	const route = String(url).replace("http://ha/api", "");
	if (route === "/states") return new Response(JSON.stringify(states));
	if (route === "/template") return new Response("");
	throw new Error(`No physical calls allowed: ${route}`);
});

const app = express();
app.use(express.json({ limit: "2mb" }));
registerBridge(app);

(async () => {
	const server = app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const port = server.address().port;
	let failures = 0;
	try {
		for (const runner of [
			{ id: "claude-code", label: "Claude subscription", model: "sonnet", nativeAuth: false },
			{ id: "codex", label: "Codex", model: "gpt-fixture", nativeAuth: false },
		]) {
			const settings = { runner: () => runner, provider: () => undefined, pick: () => ({ runner, provider: undefined, problem: "" }), problem: () => "", effort: () => "low", dailyBudget: () => 0 };
			const assistant = new Assistant({
				settings,
				spend: new SpendLedger(path.join(directory, "spend.json")),
				persona: () => "You are RemindMe.",
				tools: () => ({ home, confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false } }),
				searchFallback: () => false,
				agents: { bridgeUrl: `http://127.0.0.1:${port}/internal/agent-tools`, threads: new RunnerThreads(path.join(directory, "threads.json")) },
			});
			requests = [];
			try {
				const tools = [];
				const signal = AbortSignal.timeout(60_000);
				const first = await assistant.ask({ prompt: "What's on in the house?", channel: "console", conversationId: `console:${runner.id}`, signal }, { toolEnd: (call) => tools.push(call.name) });
				assert.equal(first.problem, undefined, first.text);
				assert.match(first.text, /fixture house/);
				assert.deepEqual(tools, ["house_overview"], "the agent must actually run a RemindMe tool");
				const second = await assistant.ask({ prompt: "And now?", channel: "console", conversationId: `console:${runner.id}`, signal });
				assert.equal(second.problem, undefined, second.text);
				console.log(JSON.stringify({ runner: runner.id, ok: true, tools, answer: first.text, modelRequests: requests.length }));
			} catch (error) {
				failures++;
				console.log(JSON.stringify({ runner: runner.id, ok: false, error: error.message, modelRequests: requests.length }));
			}
		}
	} finally {
		server.closeAllConnections();
		server.close();
		global.fetch = realFetch;
		fs.rmSync(directory, { recursive: true, force: true });
		process.exitCode = failures ? 1 : 0;
	}
})();
