import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeEntity, type HassEntity } from "../src/harness/entities.ts";
import {
	asksToRemember,
	availableActions,
	decisionSchema,
	looksLikeCommand,
	validateDecision,
	type ActionContext,
} from "../src/agent/actions.ts";
import { candidatesForTurn, findCandidates } from "../src/agent/candidates.ts";
import { decideMessages } from "../src/agent/prompts.ts";

const fixtures = JSON.parse(
	readFileSync(new URL("../eval/fixtures.json", import.meta.url), "utf8"),
) as { house: HassEntity[] };
const cards = fixtures.house.map(normalizeEntity);
const labels = (text: string) => findCandidates(cards, text).map((candidate) => candidate.label);

function context(overrides: Partial<ActionContext> = {}): ActionContext {
	return {
		home: true,
		homeControl: true,
		candidates: [],
		reminders: true,
		web: true,
		memory: true,
		memoryWrite: false,
		parcels: true,
		documents: true,
		mcpTools: [],
		...overrides,
	};
}

test("a named device tops the shortlist, and knobs of the same device stay off it", () => {
	const found = labels("turn on the desk lamp");
	assert.equal(found[0], "Desk Lamp");
	assert.ok(!found.some((label) => /Identify|On Level|Firmware/.test(label)));
});

test("a room plus a kind keeps only that kind, in that room", () => {
	assert.deepEqual(labels("turn off all the lights in the living room").sort(), [
		"Ceiling Light",
		"Floor Lamp",
	]);
});

test("a verbless follow-up inherits the device from the previous request", () => {
	const found = candidatesForTurn(cards, "now turn it off", [
		{ role: "user", content: "turn on the kitchen light" },
		{ role: "assistant", content: "Kitchen Light is on." },
	]).map((candidate) => candidate.label);
	assert.ok(found.includes("Kitchen Light"));
});

test("chit-chat matches no device at all", () => {
	assert.deepEqual(labels("hi, how are you?"), []);
});

test("device changes are only on offer when the wording commands something", () => {
	for (const prompt of [
		"turn on the kitchen light",
		"dim the bedroom to 20%",
		"hallway light on please",
		"unlock the front door",
	])
		assert.equal(looksLikeCommand(prompt), true, prompt);
	for (const prompt of [
		"why do LED lights flicker on camera?",
		"explain how a thermostat works",
		"is the front door locked",
		"what does a smart plug do?",
		"write a limerick about a robot vacuum",
	])
		assert.equal(looksLikeCommand(prompt), false, prompt);
	const history = [
		{ role: "user", content: "turn on the ceiling light" },
		{ role: "assistant", content: "Ceiling Light is on." },
	];
	assert.equal(looksLikeCommand("and the floor lamp too", history), true);
	assert.equal(looksLikeCommand("thanks, that's perfect", history), false);
});

test("home_control is absent from the grammar when the request commands nothing", () => {
	const names = availableActions(context({ homeControl: false }));
	assert.ok(!names.includes("home_control"));
	assert.ok(names.includes("home_status"));
	const schema = JSON.stringify(decisionSchema(context({ homeControl: false })));
	assert.ok(!schema.includes('"home_control"'));
});

test("targets are an enum of the shortlist, so an entity cannot be invented", () => {
	const candidates = findCandidates(cards, "turn on the desk lamp");
	const schema = decisionSchema(context({ candidates })) as {
		anyOf: Array<{ properties: Record<string, { items?: { enum?: string[] }; const?: string }> }>;
	};
	const control = schema.anyOf.find((branch) => branch.properties.action.const === "home_control");
	assert.deepEqual(control?.properties.targets.items?.enum, candidates.map((c) => c.label));
});

test("memory_save exists only when the user asks to remember", () => {
	assert.equal(asksToRemember("remember that my coffee is a flat white"), true);
	assert.equal(asksToRemember("keep in mind I'm allergic to peanuts"), true);
	assert.equal(asksToRemember("remind me to call mum at 6"), false);
	assert.equal(asksToRemember("thanks, that worked"), false);
	assert.ok(!availableActions(context()).includes("memory_save"));
	assert.ok(availableActions(context({ memoryWrite: true })).includes("memory_save"));
});

test("a decision naming something off the shortlist becomes a plain reply", () => {
	const candidates = findCandidates(cards, "turn on the desk lamp");
	const ctx = context({ candidates });
	assert.deepEqual(
		validateDecision({ action: "home_control", targets: ["Garage Door"], command: "open" }, ctx),
		{ action: "reply" },
	);
	assert.deepEqual(validateDecision({ action: "delete_everything" }, ctx), { action: "reply" });
	assert.deepEqual(validateDecision(undefined, ctx), { action: "reply" });
});

test("a verb put in the value slot is read as the command", () => {
	const candidates = findCandidates(cards, "pause the kitchen speaker");
	const decision = validateDecision(
		{ action: "home_control", targets: ["Kitchen Speaker"], command: "play", value: "pause" },
		context({ candidates }),
	);
	assert.deepEqual(decision, { action: "home_control", targets: ["Kitchen Speaker"], command: "pause" });
});

test("the routing prefix does not change with the request, so it stays cached", () => {
	const ctx = context();
	const first = decideMessages(ctx, { prompt: "turn on the desk lamp", candidates: [] });
	const second = decideMessages(ctx, { prompt: "what's the news", candidates: [] });
	assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
	assert.notDeepEqual(first.at(-1), second.at(-1));
});
