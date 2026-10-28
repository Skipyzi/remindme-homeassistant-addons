import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiSettings } from "../src/ai/settings.ts";
import { SpendLedger } from "../src/ai/spend.ts";
import type { Provider, Session, Step, ToolCall, ToolOutcome, TurnRequest } from "../src/ai/types.ts";
import { HomeApi } from "../src/agent/home.ts";
import { Assistant, trimHistory } from "../src/assistant/agent.ts";
import { ConfirmationStore } from "../src/assistant/confirmations.ts";
import { buildTools, runTool, type Effects, type ToolContext } from "../src/assistant/tools.ts";

/* ── A small Home Assistant ─────────────────────────────────────────── */

type Entity = { entity_id: string; state: string; attributes: Record<string, unknown> };

function fakeHome() {
	const states: Entity[] = [
		{ entity_id: "light.desk", state: "on", attributes: { friendly_name: "Desk lamp", supported_color_modes: ["color_temp", "xy"], brightness: 102 } },
		{ entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen counter", supported_color_modes: ["brightness"] } },
		{ entity_id: "lock.front", state: "locked", attributes: { friendly_name: "Front door" } },
		{ entity_id: "sensor.remote_battery", state: "1", attributes: { friendly_name: "IKEA remote battery", device_class: "battery", unit_of_measurement: "%" } },
		{ entity_id: "sensor.desk_temp", state: "20.3", attributes: { friendly_name: "Desk temperature", device_class: "temperature", unit_of_measurement: "°C" } },
		{ entity_id: "weather.home", state: "rainy", attributes: { friendly_name: "Home", temperature: 11, temperature_unit: "°C" } },
		{ entity_id: "todo.chores", state: "2", attributes: { friendly_name: "Chores" } },
	];
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetcher = (async (url: string | URL, init?: RequestInit) => {
		const path = String(url).replace("http://ha/api", "");
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
		if (path === "/states") return json(states);
		if (path === "/template") return new Response("light.desk\tOffice\n", { status: 200 });
		if (path.startsWith("/states/")) {
			const found = states.find((state) => state.entity_id === decodeURIComponent(path.slice(8)));
			return found ? json(found) : new Response("{}", { status: 404 });
		}
		if (path === "/calendars")
			return json([
				{ entity_id: "calendar.work", name: "Dienstplan" },
				{ entity_id: "calendar.abfall", name: "Abfallkalender" },
			]);
		if (path.startsWith("/calendars/calendar.work"))
			return json([{ summary: "Early shift", start: { dateTime: "2026-10-29T06:00:00+01:00" }, end: { dateTime: "2026-10-29T14:00:00+01:00" } }]);
		if (path.startsWith("/calendars/calendar.abfall")) return json([{ summary: "Blaue Tonne", start: { date: "2026-10-29" }, end: { date: "2026-10-30" } }]);
		if (path.startsWith("/services/")) {
			calls.push({ path, body });
			if (path.startsWith("/services/light/turn_on")) {
				const lamp = states.find((state) => state.entity_id === body.entity_id);
				if (lamp) {
					lamp.state = "on";
					if (typeof body.brightness === "number") lamp.attributes.brightness = body.brightness;
				}
			}
			if (path.startsWith("/services/todo/get_items?return_response"))
				return json({ service_response: { "todo.chores": { items: [{ summary: "Descale kettle", status: "needs_action" }] } } });
			return json([]);
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	return { home: new HomeApi("token", "http://ha/api", fetcher), calls, states };
}

function context(home: HomeApi, overrides: Partial<ToolContext> = {}): ToolContext & { added: Array<{ message: string; at: Date }> } {
	const added: Array<{ message: string; at: Date }> = [];
	return {
		home,
		confirmations: new ConfirmationStore(),
		reminders: {
			async add(message, at) {
				added.push({ message, at });
				return { id: "rem_1" };
			},
			list: async () => [],
			cancel: async () => true,
		},
		...overrides,
		added,
	};
}

const effects = (): Effects => ({ cards: new Map(), confirms: [], artifacts: [] });

/* ── A scripted provider ─────────────────────────────────────────────── */

class ScriptedProvider implements Provider {
	readonly id = "claude" as const;
	readonly label = "Claude";
	readonly model = "claude-opus-5-5";
	readonly nativeWebSearch = true;
	readonly vision = true;
	requests: TurnRequest[] = [];
	answers: Array<Array<{ call: ToolCall; outcome: ToolOutcome }>> = [];
	constructor(private readonly steps: Step[]) {}
	start(request: TurnRequest): Session {
		this.requests.push(request);
		const steps = [...this.steps];
		return {
			next: async (events) => {
				const step = steps.shift()!;
				if (step.text) events.text?.(step.text);
				return step;
			},
			answer: (results) => {
				this.answers.push(results);
			},
		};
	}
	async listModels() {
		return [];
	}
}

const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
const step = (values: Partial<Step>): Step => ({ text: "", calls: [], stop: "end", usage, model: "claude-opus-5-5", ...values });

function settings(provider: Provider | undefined, budget = 2): AiSettings {
	return {
		provider: () => provider,
		runner: () => undefined,
		problem: () => (provider ? "" : "No Claude API key is set."),
		dailyBudget: () => budget,
		effort: () => "low",
	} as unknown as AiSettings;
}

function ledger() {
	return new SpendLedger(join(mkdtempSync(join(tmpdir(), "spend-")), "spend.json"));
}

function assistantWith(provider: Provider | undefined, toolContext: ToolContext, spend = ledger(), budget = 2) {
	return new Assistant({
		settings: settings(provider, budget),
		spend,
		persona: () => "You are RemindMe.",
		tools: () => toolContext,
		searchFallback: () => false,
	});
}

/* ── Tests ───────────────────────────────────────────────────────────── */

test("a turn finds the lamp, dims it, reads it back and answers", async () => {
	const { home, calls } = fakeHome();
	const provider = new ScriptedProvider([
		step({ stop: "tools", calls: [{ id: "1", name: "find_devices", input: { query: "desk lamp" } }] }),
		step({ stop: "tools", calls: [{ id: "2", name: "control_devices", input: { entity_ids: ["light.desk"], command: "set_brightness", value: "60" } }] }),
		step({ text: "Desk lamp is at 60%." }),
	]);
	const events: string[] = [];
	const result = await assistantWith(provider, context(home)).ask(
		{ prompt: "dim the desk lamp to 60", channel: "discord" },
		{
			toolStart: (call) => events.push(`start ${call.name}`),
			toolEnd: (call, outcome) => events.push(`end ${call.name}${outcome.isError ? " error" : ""}`),
		},
	);
	assert.equal(result.text, "Desk lamp is at 60%.");
	assert.equal(result.rounds, 3);
	assert.deepEqual(events, ["start find_devices", "end find_devices", "start control_devices", "end control_devices"]);
	assert.deepEqual(calls, [{ path: "/services/light/turn_on", body: { brightness: 153, entity_id: "light.desk" } }]);
	assert.match(provider.answers[0][0].outcome.content, /"entity_id":"light.desk"/);
	assert.match(provider.answers[1][0].outcome.content, /on at 60%/);
	assert.equal(result.cards[0].entityId, "light.desk");
	assert.ok(result.costUsd! > 0);
	// The request carried the standing instructions and the Discord style.
	assert.match(provider.requests[0].system, /You are RemindMe\./);
	assert.match(provider.requests[0].context, /Discord direct message/);
	assert.ok(provider.requests[0].tools.some((tool) => tool.name === "calendar_events"));
});

test("unlocking waits for a tap instead of happening", async () => {
	const { home, calls } = fakeHome();
	const ctx = context(home);
	const provider = new ScriptedProvider([
		step({ stop: "tools", calls: [{ id: "1", name: "control_devices", input: { entity_ids: ["lock.front"], command: "unlock" } }] }),
		step({ text: "Tap the button to unlock the front door." }),
	]);
	const result = await assistantWith(provider, ctx).ask({ prompt: "unlock the door", channel: "discord" });
	assert.equal(calls.length, 0);
	assert.equal(result.confirms.length, 1);
	assert.equal(result.confirms[0].message, "Unlock Front door");
	assert.equal(result.confirms[0].destructive, true);
	assert.match(provider.answers[0][0].outcome.content, /waiting_for_user_to_confirm/);
	const held = ctx.confirmations.take(result.confirms[0].token);
	assert.equal(held?.action.service, "unlock");
	assert.equal(ctx.confirmations.take(result.confirms[0].token), undefined, "a token works once");
});

test("no key, an exhausted budget, or a picture for a blind model end the turn early", async () => {
	const { home } = fakeHome();
	const none = await assistantWith(undefined, context(home)).ask({ prompt: "hi", channel: "discord" });
	assert.equal(none.problem, "No Claude API key is set.");

	const spend = ledger();
	await spend.record("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
	const broke = await assistantWith(new ScriptedProvider([]), context(home), spend, 2).ask({ prompt: "hi", channel: "discord" });
	assert.match(broke.problem || "", /budget of \$2\.00 is used up/);

	const blind = Object.assign(new ScriptedProvider([]), { vision: false });
	const picture = await assistantWith(blind, context(home)).ask({ prompt: "what is this", channel: "discord", images: [{ mediaType: "image/png", data: "AAAA" }] });
	assert.match(picture.problem || "", /can't look at images/);
});

test("a provider failure becomes a sentence, not a crash", async () => {
	const { home } = fakeHome();
	const provider = new ScriptedProvider([]);
	provider.start = () => ({
		next: async () => {
			throw new Error("socket hang up");
		},
		answer: () => {},
	});
	const result = await assistantWith(provider, context(home)).ask({ prompt: "hi", channel: "console" });
	assert.match(result.text, /Something went wrong talking to Claude: socket hang up/);
});

test("reminders need a future time with an offset", async () => {
	const { home } = fakeHome();
	const ctx = context(home);
	const tools = await buildTools(ctx, { nativeWebSearch: true });
	const past = await runTool(tools, { id: "1", name: "set_reminder", input: { message: "oven", at: "2020-01-01T10:00:00+01:00" } }, effects());
	assert.equal(past.isError, true);
	assert.match(past.content, /already passed/);
	const bad = await runTool(tools, { id: "2", name: "set_reminder", input: { message: "oven" } }, effects());
	assert.match(bad.content, /Invalid input: at is required/);
	const at = new Date(Date.now() + 3_600_000);
	const ok = await runTool(tools, { id: "3", name: "set_reminder", input: { message: "check the oven", at: at.toISOString() } }, effects());
	assert.equal(ok.isError, undefined);
	assert.equal(ctx.added[0].message, "check the oven");
	assert.equal(ctx.added[0].at.getTime(), at.getTime());
});

test("calendars, to-dos and the house overview read Home Assistant", async () => {
	const { home, calls } = fakeHome();
	const tools = await buildTools(context(home), { nativeWebSearch: true });
	const calendar = await runTool(tools, { id: "1", name: "calendar_events", input: { from: "2026-10-28", to: "2026-10-31" } }, effects());
	const events = JSON.parse(calendar.content);
	assert.deepEqual(events.map((event: { summary: string }) => event.summary), ["Blaue Tonne", "Early shift"]);
	assert.equal(events[0].allDay, true);

	const todo = await runTool(tools, { id: "2", name: "todo_items", input: { list: "chores" } }, effects());
	assert.deepEqual(JSON.parse(todo.content), { list: "Chores", items: [{ item: "Descale kettle", status: "needs_action" }] });
	await runTool(tools, { id: "3", name: "todo_add", input: { list: "Chores", item: "Water plants" } }, effects());
	assert.deepEqual(calls.at(-1), { path: "/services/todo/add_item", body: { entity_id: "todo.chores", item: "Water plants" } });

	const overview = JSON.parse((await runTool(tools, { id: "4", name: "house_overview", input: {} }, effects())).content);
	assert.deepEqual(overview.lights_on, ["Desk lamp"]);
	assert.deepEqual(overview.low_batteries, [{ name: "IKEA remote battery", level: "1%" }]);
	assert.equal(overview.weather_now, "rainy, 11°C");
});

test("web search is a tool only when the provider can't search itself", async () => {
	const { home } = fakeHome();
	const search = async () => ({ results: [] });
	const native = await buildTools(context(home, { webSearch: search }), { nativeWebSearch: true });
	const local = await buildTools(context(home, { webSearch: search }), { nativeWebSearch: false });
	assert.ok(!native.some((tool) => tool.spec.name === "web_search"));
	assert.ok(local.some((tool) => tool.spec.name === "web_search"));
	const unknown = await runTool(local, { id: "1", name: "launch_rockets", input: {} }, effects());
	assert.equal(unknown.isError, true);
});

test("history keeps the latest turns that fit", () => {
	const turns = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `turn ${index}` }) as const);
	const kept = trimHistory(turns);
	assert.equal(kept.length, 30);
	assert.equal(kept.at(-1)?.text, "turn 49");
	const long = trimHistory([{ role: "user", text: "x".repeat(39_000) }, { role: "assistant", text: "y".repeat(2_000) }]);
	assert.deepEqual(long.map((turn) => turn.role), ["assistant"]);
});
