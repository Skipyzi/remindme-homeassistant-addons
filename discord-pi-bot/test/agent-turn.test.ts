import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../src/harness/artifacts.ts";
import { HomeApi } from "../src/agent/home.ts";
import { FenceStripper, runTurn, type TurnDeps } from "../src/agent/turn.ts";

const MODEL_URL = "http://homeassistant:8080/v1/chat/completions";

const house = [
	{ entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen Light", supported_color_modes: ["brightness"] } },
	{ entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front Door" } },
];

interface Recorded {
	model: Array<Record<string, unknown>>;
	services: Array<{ path: string; body: unknown }>;
	conversation: string[];
}

/**
 * A fake Home Assistant and a fake llama.cpp. `decisions` are what the
 * grammar-constrained call returns, in order; `speech` is what a streamed
 * answer says. Everything the agent sends is recorded.
 */
function harness(options: {
	decisions?: unknown[];
	speech?: string;
	intent?: unknown;
}) {
	const recorded: Recorded = { model: [], services: [], conversation: [] };
	const decisions = [...(options.decisions || [])];
	const states = structuredClone(house);
	const haFetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		if (url.endsWith("/conversation/process")) {
			recorded.conversation.push(body.text);
			return Response.json(options.intent ?? { response: { response_type: "error", data: { code: "no_intent_match" } } });
		}
		if (url.endsWith("/template")) return new Response("light.kitchen\tKitchen\n");
		if (url.endsWith("/states")) return Response.json(states);
		const one = url.match(/\/states\/(.+)$/);
		if (one) return Response.json(states.find((state) => state.entity_id === decodeURIComponent(one[1])));
		if (url.includes("/services/")) {
			recorded.services.push({ path: url.split("/api")[1], body });
			const target = states.find((state) => state.entity_id === body.entity_id);
			if (target && url.endsWith("/turn_on")) target.state = "on";
			return Response.json([]);
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const modelFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input) !== MODEL_URL) throw new Error(`unexpected fetch ${String(input)}`);
		const body = JSON.parse(String(init?.body));
		recorded.model.push(body);
		if (!body.stream)
			return Response.json({ choices: [{ message: { content: JSON.stringify(decisions.shift() ?? { action: "reply" }) } }] });
		const chunks = (options.speech ?? "Hello!")
			.match(/.{1,6}/gs)!
			.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
		return new Response(`${chunks.join("")}data: [DONE]\n\n`);
	}) as typeof fetch;
	const artifacts: Artifact[] = [];
	const held: unknown[] = [];
	const deps: TurnDeps = {
		endpoint: () => ({ url: new URL(MODEL_URL), model: "test", headers: {}, openaiCompat: false, label: "test" }),
		activeModel: async () => ({}),
		contextSize: 8192,
		systemPrompt: () => "You are a test.",
		home: new HomeApi("token", "http://supervisor/core/api", haFetch),
		holdAction: (action) => {
			held.push(action);
			return "tok-1";
		},
		holdReminder: () => "tok-r",
		listReminders: async () => [],
		artifacts: {
			get: (id) => artifacts.find((artifact) => artifact.id === id),
			create: async (values) => {
				const artifact = { id: `a${artifacts.length}`, title: "", kind: "markdown", content: "", createdAt: "", updatedAt: "", ...values } as Artifact;
				artifacts.push(artifact);
				return artifact;
			},
			update: async (id, values) => Object.assign(artifacts.find((artifact) => artifact.id === id)!, values),
		},
		features: { reminders: true, parcels: false },
	};
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const send = (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> });
	return { deps, recorded, events, send, artifacts, held, modelFetch };
}

async function run(h: ReturnType<typeof harness>, prompt: string, extra: Record<string, unknown> = {}) {
	const original = globalThis.fetch;
	globalThis.fetch = h.modelFetch;
	try {
		await runTurn({ prompt, thinkingMode: "fast", requestId: "r1", ...extra }, h.deps, h.send);
	} finally {
		globalThis.fetch = original;
	}
}

const answerOf = (h: ReturnType<typeof harness>) =>
	h.events.filter((entry) => entry.event === "answer").map((entry) => entry.data.text).join("");

test("a plain command Home Assistant understands never reaches the model", async () => {
	const h = harness({
		intent: {
			response: {
				response_type: "action_done",
				speech: { plain: { speech: "Turned on the light" } },
				data: { success: [{ id: "light.kitchen", name: "Kitchen Light", type: "entity" }] },
			},
		},
	});
	await run(h, "turn on the kitchen light");
	assert.deepEqual(h.recorded.conversation, ["turn on the kitchen light"]);
	assert.equal(h.recorded.model.length, 0);
	assert.equal(answerOf(h), "Turned on the light");
});

test("a device command the model decides is carried out in code, with no second model call", async () => {
	const h = harness({ decisions: [{ action: "home_control", targets: ["Kitchen Light"], command: "turn_on" }] });
	await run(h, "switch the kitchen light on");
	assert.equal(h.recorded.model.length, 1);
	assert.equal(h.recorded.model[0].stream, false);
	assert.ok(h.recorded.model[0].response_format, "the decision is grammar-constrained");
	assert.deepEqual(h.recorded.services, [{ path: "/services/light/turn_on", body: { entity_id: "light.kitchen" } }]);
	assert.equal(answerOf(h), "Kitchen Light is on.");
});

test("unlocking waits on a confirm card and calls nothing", async () => {
	const h = harness({ decisions: [{ action: "home_control", targets: ["Front Door"], command: "unlock" }] });
	await run(h, "unlock the front door");
	assert.equal(h.recorded.conversation.length, 0, "risky wording skips the fast path");
	assert.equal(h.recorded.services.length, 0);
	assert.equal(h.held.length, 1);
	const confirm = h.events.find(
		(entry) => entry.event === "tool_complete" && (entry.data.result as { confirmation_required?: boolean })?.confirmation_required,
	);
	assert.ok(confirm, "a confirmation row is emitted");
	assert.equal((confirm!.data.result as { destructive: boolean }).destructive, true);
});

test("a knowledge question gets a spoken answer and the model is offered no tools", async () => {
	const h = harness({ decisions: [{ action: "reply" }], speech: "Because of PWM dimming." });
	await run(h, "why do LED lights flicker on camera?");
	assert.equal(h.recorded.model.length, 2);
	const schema = JSON.stringify(h.recorded.model[0].response_format);
	assert.ok(!schema.includes('"home_control"'), "no device changes on offer for a question");
	assert.equal(h.recorded.model[1].tools, undefined);
	assert.equal(answerOf(h), "Because of PWM dimming.");
	assert.equal(h.recorded.services.length, 0);
});

test("a document is streamed as plain text, fences stripped, and saved", async () => {
	const h = harness({
		decisions: [{ action: "document_write", title: "Timer", kind: "html" }],
		speech: "```html\n<h1>Timer</h1>\n```",
	});
	await run(h, "make me an html page with a timer");
	assert.equal(h.artifacts.length, 1);
	assert.equal(h.artifacts[0].content, "<h1>Timer</h1>");
	const streamed = h.events
		.filter((entry) => entry.event === "artifact_delta")
		.map((entry) => entry.data.text)
		.join("");
	assert.equal(streamed.trim(), "<h1>Timer</h1>");
	assert.match(String(answerOf(h)), /Wrote \*\*Timer\*\*/);
});

test("a decision the endpoint cannot make degrades to conversation", async () => {
	const h = harness({ speech: "Hi there." });
	const failing = h.modelFetch;
	h.modelFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (!JSON.parse(String(init?.body)).stream) return new Response("bad", { status: 400 });
		return failing(input, init);
	}) as typeof fetch;
	await run(h, "hello");
	assert.equal(answerOf(h), "Hi there.");
});

test("the fence stripper passes unfenced text through untouched", () => {
	const stripper = new FenceStripper();
	const out = ["<svg>", "<rect/>", "</svg>"].map((part) => stripper.push(part)).join("") + stripper.end();
	assert.equal(out, "<svg><rect/></svg>");
});

test("a model that dies while loading is explained, not dumped as JSON", async () => {
	const { describeEndpointError } = await import("../src/agent/llm.ts");
	const message = describeEndpointError(
		"local",
		500,
		'{"error":{"code":500,"message":"model name=qwen3-1.7b-q8 failed to load","type":"server_error"}}',
	);
	assert.match(message, /out of memory/);
	assert.doesNotMatch(message, /\{"error"/);
	assert.match(describeEndpointError("local", 502, "bad gateway"), /HTTP 502/);
});
