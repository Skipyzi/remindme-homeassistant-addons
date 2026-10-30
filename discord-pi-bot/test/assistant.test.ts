import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiSettings } from "../src/ai/settings.ts";
import { SpendLedger } from "../src/ai/spend.ts";
import type { Provider, Session, Step, ToolCall, ToolOutcome, TurnRequest } from "../src/ai/types.ts";
import { HomeApi } from "../src/agent/home.ts";
import { Assistant, historyForModel, trimHistory, withoutNotes } from "../src/assistant/agent.ts";
import { ConfirmationStore } from "../src/assistant/confirmations.ts";
import { ActivityLog } from "../src/assistant/activity.ts";
import { ThreadStore } from "../src/assistant/threads.ts";
import { buildTools, newEffects, runTool, type Effects, type ToolContext } from "../src/assistant/tools.ts";

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

const effects = (): Effects => newEffects();

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

function settings(provider: Provider | undefined, budget = 2, others: Record<string, Provider> = {}): AiSettings {
	return {
		provider: () => provider,
		runner: () => undefined,
		// A thread's own model: one of `others`, by model name; anything else gets the default.
		pick: (choice?: { model: string }) => (choice && others[choice.model] ? { provider: others[choice.model], problem: "" } : { provider, problem: provider ? "" : "No Claude API key is set." }),
		problem: () => (provider ? "" : "No Claude API key is set."),
		dailyBudget: () => budget,
		effort: () => "low",
	} as unknown as AiSettings;
}

function ledger() {
	return new SpendLedger(join(mkdtempSync(join(tmpdir(), "spend-")), "spend.json"));
}

function assistantWith(provider: Provider | undefined, toolContext: ToolContext, spend = ledger(), budget = 2, activity?: ActivityLog) {
	return new Assistant({
		settings: settings(provider, budget),
		spend,
		persona: () => "You are RemindMe.",
		tools: () => toolContext,
		searchFallback: () => false,
		activity,
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

test("earlier messages reach the model with when they were sent and what the tools did", async () => {
	const { home } = fakeHome();
	const store = new ThreadStore(join(mkdtempSync(join(tmpdir(), "threads-")), "threads.json"));
	const chat = store.create({ title: "Feature list", origin: "console" });
	const asked = new Date(2026, 9, 29, 23, 26, 56);
	const later = (minutes: number) => new Date(asked.getTime() + minutes * 60_000);
	store.append(chat.id, { role: "user", text: "Well then in 90min remind me", at: asked });
	store.append(chat.id, { role: "assistant", text: "Reminder set for 00:56.", at: later(0.1), receipts: [{ text: "Reminder for tomorrow at 00:56 (Fri 30 Oct): Add the model to each thread." }] });
	store.append(chat.id, { role: "assistant", text: "Your morning brief.", at: later(480) });
	store.append(chat.id, { role: "user", text: "Also location based notifications", at: later(45) });
	const rendered = historyForModel(store.history(chat.id));
	assert.equal(rendered[0].text, "[Thu 29 Oct, 23:26] Well then in 90min remind me", "the user's message says when it was sent");
	assert.equal(
		rendered[1].text,
		"Reminder set for 00:56.\n\nYour morning brief.\n\n[Done with tools: Reminder for tomorrow at 00:56 (Fri 30 Oct): Add the model to each thread.]",
		"a reply right after needs no time, and what its tools did follows it",
	);
	assert.match(historyForModel([{ role: "user", text: "hi", at: asked.toISOString() }, { role: "assistant", text: "Brief", at: later(480).toISOString() }])[1].text, /^\[Fri 30 Oct, 07:26\] Brief$/, "a message RemindMe sent on its own has its time");

	const provider = new ScriptedProvider([step({ text: "[Fri 30 Oct, 00:12] Added it. [[c9]]\n\n[Done with tools: Wrote a document]" })]);
	const result = await assistantWith(provider, context(home)).ask({ prompt: "Also location based notifications", channel: "console", history: store.history(chat.id) });
	assert.equal(provider.requests[0].history[0].text, rendered[0].text, "the provider gets the history with its notes");
	assert.equal(result.text, "Added it.", "notes the model copies into its answer come out again");
	assert.equal(withoutNotes("Plain answer"), "Plain answer");
	assert.match(provider.requests[0].system, /counts from when that message was sent/);
});

test("the prompt names the AI and model that answer", async () => {
	const { home } = fakeHome();
	const provider = new ScriptedProvider([step({ text: "I'm Claude." })]);
	await assistantWith(provider, context(home)).ask({ prompt: "which model are you?", channel: "console" });
	assert.match(provider.requests[0].context, /You are running on Claude, model claude-opus-5-5\./);
});

test("each turn lands in the ledger: what changed, what waits, then the answer", async () => {
	const { home } = fakeHome();
	const activity = new ActivityLog(join(mkdtempSync(join(tmpdir(), "activity-")), "activity.json"));
	const ctx = context(home);
	const provider = new ScriptedProvider([
		step({ stop: "tools", calls: [{ id: "1", name: "control_devices", input: { entity_ids: ["light.desk"], command: "set_brightness", value: "40" } }, { id: "2", name: "control_devices", input: { entity_ids: ["lock.front"], command: "unlock" } }] }),
		step({ text: "Desk lamp is at 40%. Tap to unlock the door." }),
	]);
	const result = await assistantWith(provider, ctx, ledger(), 2, activity).ask({ prompt: "dim the desk lamp and unlock the door", channel: "discord" });
	const entries = activity.recent();
	assert.deepEqual(entries.map((entry) => entry.kind), ["answered", "waiting", "did"]);
	assert.equal(entries[0].question, "dim the desk lamp and unlock the door");
	assert.equal(entries[0].channel, "discord");
	assert.deepEqual(entries[2].receipts, [{ text: "Desk lamp: on at 40%", color: "#ffd23f" }]);
	assert.equal(entries[1].token, result.confirms[0].token);
	activity.resolve(result.confirms[0].token, "confirmed", "Unlock Front door");
	assert.equal(activity.recent()[1].kind, "confirmed");
	assert.equal(activity.recent()[1].token, undefined);
});

test("a calendar event waits for a tap, then goes to the chosen calendar", async () => {
	const { home, calls, states } = fakeHome();
	states.push(
		{ entity_id: "calendar.abfall", state: "off", attributes: { friendly_name: "Abfall Leipzig", supported_features: 0 } },
		{ entity_id: "calendar.icloud_home", state: "off", attributes: { friendly_name: "Home", supported_features: 1 } },
		{ entity_id: "calendar.ordio_work", state: "off", attributes: { friendly_name: "Ordio Work", supported_features: 7 } },
	);
	let chosen: string | undefined;
	const ctx = context(home, { calendar: { newEvents: () => chosen } });
	const tools = await buildTools(ctx, { nativeWebSearch: true });
	const ask = (input: Record<string, unknown>, effects = newEffects()) => runTool(tools, { id: "c", name: "add_calendar_event", input }, effects);

	const unset = await ask({ title: "Dentist", start: "2026-10-30T10:00" });
	assert.equal(unset.isError, true);
	assert.deepEqual(JSON.parse(unset.content).calendars, ["Home", "Ordio Work"], "it asks rather than guessing, and only offers calendars that take events");

	chosen = "calendar.icloud_home";
	const effects = newEffects();
	const held = await ask({ title: "Dentist", start: "2026-10-30T10:00", location: "Praxis Dr. Weber" }, effects);
	assert.deepEqual(JSON.parse(held.content), { waiting_for_user_to_confirm: 'Add "Dentist" to Home: Fri 30 Oct, 10:00–11:00' });
	assert.equal(effects.confirms.length, 1);
	assert.equal(calls.length, 0, "nothing is added before the tap");
	const confirmed = ctx.confirmations.take(effects.confirms[0].token);
	assert.ok(confirmed);
	await home.service(confirmed.action);
	assert.deepEqual(calls.at(-1), {
		path: "/services/calendar/create_event",
		body: { summary: "Dentist", start_date_time: "2026-10-30 10:00:00", end_date_time: "2026-10-30 11:00:00", location: "Praxis Dr. Weber", entity_id: "calendar.icloud_home" },
	});

	const named = newEffects();
	await ask({ title: "Shift swap", start: "2026-11-02", calendar: "ordio work" }, named);
	assert.equal(named.confirms[0].message, 'Add "Shift swap" to Ordio Work: Mon 2 Nov, all day');
	assert.deepEqual(ctx.confirmations.take(named.confirms[0].token)?.action.serviceData, { summary: "Shift swap", start_date: "2026-11-02", end_date: "2026-11-03" });

	const readOnly = await ask({ title: "Bins", start: "2026-11-02", calendar: "Abfall Leipzig" });
	assert.equal(readOnly.isError, true);
	assert.match(readOnly.content, /No calendar called abfall leipzig takes new events/);
	const badTime = await ask({ title: "Dentist", start: "next Friday" });
	assert.match(badTime.content, /^Invalid input: Give the start/);
});

test("chat turns are looked at for things to remember; jobs, briefs and failures aren't", async () => {
	const { home } = fakeHome();
	const learned: string[] = [];
	const assistant = (provider: Provider | undefined) =>
		new Assistant({
			settings: settings(provider, 2),
			spend: ledger(),
			persona: () => "You are RemindMe.",
			tools: () => context(home),
			searchFallback: () => false,
			memory: () => "What you know about the user:\n- Prefers Friday flights.",
			learn: (input) => learned.push(`${input.channel}: ${input.prompt}`),
		});
	const provider = new ScriptedProvider([step({ text: "Noted." }), step({ text: "Hi." }), step({ text: "Job run." })]);
	await assistant(provider).ask({ prompt: "My sister Anna lives in Berlin", channel: "discord" });
	await assistant(provider).ask({ prompt: "I like tea", channel: "console" });
	await assistant(provider).ask({ prompt: "Carry on", channel: "job" });
	await assistant(undefined).ask({ prompt: "My name is Gabor", channel: "console" });
	assert.deepEqual(learned, ["discord: My sister Anna lives in Berlin", "console: I like tea"]);
	assert.match(String(provider.requests[0].context), /Prefers Friday flights/, "what it remembers goes into the turn");
	assert.match(String(provider.requests[2].context), /Prefers Friday flights/, "jobs get it too");
});

test("a thread with a model of its own answers with it; other threads and chores keep the default", async () => {
	const { home } = fakeHome();
	const opus = new ScriptedProvider([step({ text: "Opus here." })]);
	const haiku = new ScriptedProvider([step({ text: "Haiku here." })]);
	const store = new ThreadStore(join(mkdtempSync(join(tmpdir(), "threads-")), "threads.json"));
	const long = store.create({ title: "Find me a flat", origin: "console" });
	const other = store.create({ title: "Lights", origin: "console" });
	store.setModel(long.id, { provider: "claude", model: "claude-haiku-5-5" });
	assert.deepEqual(store.get(long.id)?.model, { provider: "claude", model: "claude-haiku-5-5" });
	const assistant = new Assistant({
		settings: settings(opus, 2, { "claude-haiku-5-5": haiku }),
		spend: ledger(),
		persona: () => "You are RemindMe.",
		tools: () => context(home),
		searchFallback: () => false,
		modelFor: (id) => store.get(id)?.model as { provider: "claude"; model: string } | undefined,
	});
	assert.equal((await assistant.ask({ prompt: "Go on", channel: "job", threadId: long.id })).text, "Haiku here.");
	assert.equal((await assistant.ask({ prompt: "Lamp on", channel: "console", threadId: other.id })).text, "Opus here.");
	assert.equal(haiku.requests.length, 1);
	assert.equal(opus.requests.length, 1);
	// A model for one turn wins over the thread's.
	const sonnet = new ScriptedProvider([step({ text: "Sonnet here." })]);
	const once = new Assistant({ settings: settings(opus, 2, { "claude-haiku-5-5": haiku, "claude-sonnet-5-5": sonnet }), spend: ledger(), persona: () => "", tools: () => context(home), searchFallback: () => false, modelFor: () => ({ provider: "claude", model: "claude-haiku-5-5" }) });
	assert.equal((await once.ask({ prompt: "Hi", channel: "console", threadId: long.id, model: { provider: "claude", model: "claude-sonnet-5-5" } })).text, "Sonnet here.");
	// Back to the default.
	store.setModel(long.id, undefined);
	assert.equal(store.get(long.id)?.model, undefined);
});

test("a tool's card shows under the answer when the answer names it, and nowhere else", async () => {
	const { home } = fakeHome();
	const provider = new ScriptedProvider([
		step({ stop: "tools", calls: [{ id: "1", name: "find_place", input: { query: "Saturn Leipzig Brühl" } }] }),
		step({ text: "Yes, open until 20:00.\n\n[[c1]]" }),
	]);
	const places = {
		async find() {
			return [
				{ name: "Saturn", lat: 51.3436, lon: 12.377, address: "Brühl 1, 04109 Leipzig", status: { text: "Open now, until 20:00", open: true } },
				{ name: "MediaMarkt", lat: 51.33, lon: 12.4 },
			];
		},
	};
	const result = await assistantWith(provider, context(home, { places })).ask({ prompt: "Can I pick them up in town today?", channel: "console" });
	assert.equal(result.text, "Yes, open until 20:00.");
	assert.equal(result.embeds.length, 1);
	assert.equal(result.embeds[0].kind, "place");
	assert.equal((result.embeds[0] as { name: string }).name, "Saturn");
	const toolResult = JSON.stringify(provider.answers[0]);
	assert.match(toolResult, /\\"card\\":\\"c1\\"/);
	assert.match(toolResult, /\\"card\\":\\"c2\\"/);
	assert.match(String(provider.requests[0].system), /\[\[c3\]\]/, "the AI is told how to show cards");
});

test("the user's rules decide what it does on its own, asks first, or leaves alone", async () => {
	const { RuleStore, deviceRule } = await import("../src/assistant/rules.ts");
	const rules = new RuleStore(join(mkdtempSync(join(tmpdir(), "rules-")), "rules.json"));
	await rules.load();
	assert.equal(rules.get("devices"), "auto");
	assert.equal(rules.get("security"), "ask");
	assert.throws(() => rules.set("security", "auto"), /can't be set/, "opening the house is never done unasked");
	assert.throws(() => rules.set("mail", "auto"), /can't be set/);
	assert.equal(rules.context(), undefined, "nothing to say while everything is as it came");
	assert.equal(deviceRule("cover", "garage"), "security");
	assert.equal(deviceRule("cover", "blind"), "covers");
	assert.equal(deviceRule("scene"), "other");

	const { home, calls } = fakeHome();
	const confirmations = new ConfirmationStore();
	const tools = await buildTools(context(home, { confirmations, rules }), { nativeWebSearch: true });
	const run = (name: string, input: Record<string, unknown>, out = effects()) => runTool(tools, { id: name, name, input }, out).then((result) => ({ result, out }));

	rules.set("devices", "ask");
	const asked = await run("control_devices", { entity_ids: ["light.kitchen"], command: "turn_on" });
	assert.deepEqual(JSON.parse(asked.result.content).waiting_for_user_to_confirm, ["Kitchen counter"]);
	assert.equal(calls.length, 0, "nothing happened yet");
	rules.set("devices", "never");
	const off = await run("control_devices", { entity_ids: ["light.kitchen"], command: "turn_on" });
	assert.match(JSON.parse(off.result.content).problems[0], /turned off "Lights, switches, heating and media"/);
	assert.equal(off.result.isError, true);
	const lock = await run("control_devices", { entity_ids: ["lock.front"], command: "unlock" });
	assert.ok(JSON.parse(lock.result.content).waiting_for_user_to_confirm, "the front door still waits for a tap");

	rules.set("todo", "ask");
	const todo = await run("todo_add", { list: "Chores", item: "Descale kettle" });
	assert.equal(JSON.parse(todo.result.content).waiting_for_user_to_confirm, 'Add "Descale kettle" to Chores');
	assert.equal(calls.filter((call) => call.path.includes("add_item")).length, 0);
	await confirmations.take(todo.out.confirms[0].token)!.perform();
	assert.equal(calls.filter((call) => call.path.includes("add_item")).length, 1, "the tap does it");

	assert.match(rules.context()!, /lights, switches, heating and media: never; to-do lists: asks first/);
	rules.set("devices", "auto");
	await rules.flushed();
	const again = new RuleStore((rules as unknown as { path: string }).path);
	await again.load();
	assert.equal(again.get("devices"), "auto", "back to the default isn't stored");
	assert.equal(again.get("todo"), "ask");
});
