import type { ToolCall, ToolOutcome, ToolSpec } from "../ai/types";
import type { Artifact } from "../harness/artifacts";
import type { EntityCard } from "../harness/entities";
import type { VaultNote } from "../harness/vault";
import { describeWhen } from "../harness/reminderParser";
import { findCandidates } from "../agent/candidates";
import {
	HOME_COMMANDS,
	describeCommand,
	planCommand,
	stateText,
	type HomeApi,
	type HomeCommand,
} from "../agent/home";
import type { Confirmation, ConfirmationStore } from "./confirmations";

export const DOCUMENT_KINDS = ["markdown", "html", "svg", "code", "glsl", "wgsl", "three", "lua"] as const;

export interface McpTool {
	/** Wire name, `mcp__<server>__<tool>`. */
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** Everything the tools reach outside themselves, injected so tests can fake it. */
export interface ToolContext {
	home?: HomeApi;
	confirmations: ConfirmationStore;
	reminders: {
		add(message: string, at: Date): Promise<{ id: string }>;
		list(): Promise<Array<{ id: string; message: string; time: Date }>>;
		cancel(id: string): Promise<boolean>;
	};
	vault?: {
		list(filter: { search?: string }): VaultNote[];
		write(path: string, patch: { body: string; frontmatter: Record<string, string | string[]> }): Promise<VaultNote>;
	};
	/** Client-side search, offered only when the provider can't search itself. */
	webSearch?(query: string): Promise<unknown>;
	readPage?(url: string): Promise<{ title: string; url: string; text: string }>;
	parcels?: {
		track(number: string, label: string): Promise<{ text: string; card: unknown } | { error: string }>;
		list(): { text: string; cards: unknown[] };
	};
	artifacts?: {
		get(id: string): Artifact | undefined;
		create(values: Partial<Artifact>): Promise<Artifact>;
		update(id: string, values: Partial<Artifact>): Promise<Artifact | undefined>;
	};
	mcp?: {
		tools(): Promise<McpTool[]>;
		call(name: string, args: Record<string, unknown>): Promise<unknown>;
	};
}

/** What a turn's tools produced besides text for the model. */
export interface Effects {
	cards: Map<string, EntityCard>;
	confirms: Confirmation[];
	artifacts: Artifact[];
}

export interface ToolRun extends ToolOutcome {
	/** Rich payload for the console's tool row (an artifact, parcels). */
	view?: unknown;
}

export interface AssistantTool {
	spec: ToolSpec;
	run(input: Record<string, unknown>, effects: Effects): Promise<ToolRun>;
}

/* ── Input checks ─────────────────────────────────────────────────────── */

class InputError extends Error {}

function text(input: Record<string, unknown>, key: string, max: number, required = true): string {
	const value = input[key];
	if (value === undefined || value === null || value === "") {
		if (required) throw new InputError(`${key} is required`);
		return "";
	}
	if (typeof value !== "string") throw new InputError(`${key} must be text`);
	return value.trim().slice(0, max);
}

function list(input: Record<string, unknown>, key: string, max: number): string[] {
	const value = input[key];
	const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return items
		.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
		.map((item) => item.trim())
		.slice(0, max);
}

function json(value: unknown, max = 6_000): string {
	const out = JSON.stringify(value);
	return out.length > max ? `${out.slice(0, max)}…(cut)` : out;
}

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: "object", properties, required, additionalProperties: false };
}

/* ── Devices ──────────────────────────────────────────────────────────── */

/** What a device can be told to do, from its domain and capabilities. */
export function commandsFor(card: EntityCard): HomeCommand[] {
	const allowed = new Set<HomeCommand>();
	const domain = card.domain;
	if (["light", "switch", "fan", "media_player", "humidifier", "input_boolean"].includes(domain)) {
		allowed.add("turn_on");
		allowed.add("turn_off");
		allowed.add("toggle");
	}
	if (["scene", "script"].includes(domain)) allowed.add("turn_on");
	if (domain === "light") {
		if (card.capabilities.brightness) allowed.add("set_brightness");
		if (card.capabilities.color) allowed.add("set_color");
		if (card.capabilities.colorTemperature) allowed.add("set_color_temperature");
	}
	if (domain === "climate") {
		for (const command of ["set_temperature", "set_hvac_mode", "turn_on", "turn_off"] as const) allowed.add(command);
	}
	if (domain === "cover" || domain === "valve") {
		allowed.add("open");
		allowed.add("close");
		if (card.capabilities.position) allowed.add("set_position");
	}
	if (domain === "lock") {
		allowed.add("lock");
		allowed.add("unlock");
	}
	if (domain === "fan") allowed.add("set_fan_speed");
	if (domain === "media_player") {
		for (const command of ["play", "pause", "next_track", "set_volume"] as const) allowed.add(command);
	}
	if (domain === "vacuum") {
		allowed.add("start");
		allowed.add("return_home");
	}
	return HOME_COMMANDS.filter((command) => allowed.has(command));
}

function describeCard(card: EntityCard) {
	const commands = commandsFor(card);
	return {
		entity_id: card.entityId,
		name: card.name,
		...(card.area ? { area: card.area } : {}),
		state: stateText(card),
		...(card.batteryLevel !== undefined ? { battery: `${card.batteryLevel}%` } : {}),
		...(commands.length ? { commands } : {}),
	};
}

const quietDomains = new Set(["update", "button", "number", "select", "text", "event", "device_tracker", "zone", "sun", "tts", "stt", "conversation", "image", "camera", "automation"]);

function deviceTools(ctx: ToolContext): AssistantTool[] {
	const home = ctx.home;
	if (!home) return [];
	return [
		{
			spec: {
				name: "house_overview",
				description:
					"A summary of the whole home right now: lights on, media playing, indoor temperatures and humidity, open doors and windows, people home, low batteries and devices that are offline. Use it for 'how is the house' questions and before writing a brief.",
				parameters: object({}),
			},
			async run() {
				const cards = await home.cards();
				const live = cards.filter((card) => card.available);
				const named = (items: EntityCard[], limit = 15) => items.slice(0, limit).map((card) => card.name);
				const readings = live
					.filter((card) => card.domain === "sensor" && (card.deviceClass === "temperature" || card.deviceClass === "humidity"))
					.slice(0, 20)
					.map((card) => ({ name: card.name, area: card.area, value: stateText(card) }));
				const openings = live.filter(
					(card) => card.domain === "binary_sensor" && card.state === "on" && ["door", "window", "opening", "garage_door"].includes(card.deviceClass || ""),
				);
				const batteries = live
					.filter((card) => card.deviceClass === "battery" && card.numericState !== undefined && card.numericState <= 20)
					.map((card) => ({ name: card.name, level: `${card.numericState}%` }));
				const offline = cards.filter(
					(card) => !card.available && !quietDomains.has(card.domain) && card.domain !== "sensor" && card.domain !== "binary_sensor",
				);
				const weather = live.find((card) => card.domain === "weather");
				return {
					content: json({
						lights_on: named(live.filter((card) => card.domain === "light" && card.state === "on")),
						media_playing: live
							.filter((card) => card.domain === "media_player" && card.state === "playing")
							.map((card) => ({ name: card.name, title: card.attributes?.media_title })),
						climate: live.filter((card) => card.domain === "climate").map(describeCard),
						readings,
						open_doors_and_windows: named(openings),
						people: live.filter((card) => card.domain === "person").map((card) => ({ name: card.name, state: card.state })),
						low_batteries: batteries,
						offline_devices: named(offline, 20),
						updates_waiting: live.filter((card) => card.domain === "update" && card.state === "on").length,
						weather_now: weather ? stateText(weather) : undefined,
					}),
				};
			},
		},
		{
			spec: {
				name: "find_devices",
				description:
					"Find devices and sensors by name, room or kind, with their current state and the commands each accepts. Always use this to get an exact entity_id before control_devices.",
				parameters: object({
					query: { type: "string", description: "Words naming the device, room or kind, e.g. 'desk lamp', 'kitchen lights', 'temperature bedroom'." },
					domain: { type: "string", description: "Only this kind, e.g. light, switch, sensor, media_player, climate." },
					area: { type: "string", description: "Only devices in this room." },
				}),
			},
			async run(input, effects) {
				const query = text(input, "query", 120, false);
				const domain = text(input, "domain", 40, false).toLowerCase();
				const area = text(input, "area", 60, false).toLowerCase();
				let cards = await home.cards();
				if (domain) cards = cards.filter((card) => card.domain === domain);
				if (area) cards = cards.filter((card) => (card.area || "").toLowerCase().includes(area));
				const found = query
					? findCandidates(cards, query, { limit: 20 }).map((candidate) => candidate.card)
					: cards.filter((card) => !quietDomains.has(card.domain)).slice(0, 40);
				if (found.length <= 6) for (const card of found) effects.cards.set(card.entityId, card);
				return {
					content: found.length
						? json(found.map(describeCard))
						: "No matching devices. Try other words, or a room or kind on its own.",
				};
			},
		},
		{
			spec: {
				name: "control_devices",
				description:
					"Send one command to one or more devices. Values: brightness/volume/position/fan speed in percent ('40', '+10'); colour as a name or #rrggbb; colour temperature as warm, neutral, cool, daylight or kelvin; temperature in degrees; hvac mode such as heat or off. Locks, doors, covers and alarms are held for the user to confirm.",
				parameters: object(
					{
						entity_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
						command: { type: "string", enum: [...HOME_COMMANDS] },
						value: { type: "string", description: "The amount, colour or mode the command needs." },
					},
					["entity_ids", "command"],
				),
			},
			async run(input, effects) {
				const ids = list(input, "entity_ids", 10);
				const command = text(input, "command", 40) as HomeCommand;
				if (!HOME_COMMANDS.includes(command)) throw new InputError(`Unknown command ${command}`);
				const value = text(input, "value", 40, false) || undefined;
				if (!ids.length) throw new InputError("entity_ids is required");
				const done: string[] = [];
				const waiting: string[] = [];
				const problems: string[] = [];
				for (const id of ids) {
					const card = await home.card(id);
					if (!card) {
						problems.push(`${id}: no such device; use find_devices for the exact id`);
						continue;
					}
					try {
						const plan = planCommand(card, command, value);
						if (plan.requiresConfirmation) {
							const label = `${describeCommand(command, value)} ${card.name}`.replace(/^./, (first) => first.toUpperCase());
							effects.confirms.push(ctx.confirmations.hold(plan, label));
							waiting.push(card.name);
							continue;
						}
						await home.service(plan);
						done.push(id);
					} catch (error) {
						problems.push(`${card.name}: ${error instanceof Error ? error.message : "the call failed"}`);
					}
				}
				// Read back what actually happened rather than announcing what was asked.
				const after = (await Promise.all(done.map((id) => home.card(id)))).filter((card): card is EntityCard => Boolean(card));
				for (const card of after) effects.cards.set(card.entityId, card);
				return {
					content: json({
						done: after.map((card) => ({ name: card.name, state: stateText(card) })),
						...(waiting.length ? { waiting_for_user_to_confirm: waiting } : {}),
						...(problems.length ? { problems } : {}),
					}),
					isError: !done.length && !waiting.length,
				};
			},
		},
		{
			spec: {
				name: "calendar_events",
				description:
					"Events from the user's calendars (work shifts, waste collection days, appointments) between two dates. Defaults to today and the next two days.",
				parameters: object({
					from: { type: "string", description: "Start date or date-time, ISO 8601. Defaults to the start of today." },
					to: { type: "string", description: "End date or date-time, ISO 8601. Defaults to three days after the start." },
				}),
			},
			async run(input) {
				const fromText = text(input, "from", 40, false);
				const toText = text(input, "to", 40, false);
				const start = fromText ? new Date(fromText) : new Date(new Date().setHours(0, 0, 0, 0));
				const end = toText ? new Date(toText) : new Date(start.getTime() + 3 * 86_400_000);
				if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new InputError("from and to must be ISO dates");
				if (end <= start) throw new InputError("to must be after from");
				if (end.getTime() - start.getTime() > 62 * 86_400_000) throw new InputError("Ask for two months at most");
				const events = await home.calendarEvents(start, end);
				return { content: events.length ? json(events.slice(0, 60)) : "No events in that range." };
			},
		},
		{
			spec: {
				name: "weather_forecast",
				description: "The weather forecast for home, daily or hourly.",
				parameters: object({ kind: { type: "string", enum: ["daily", "hourly"] } }),
			},
			async run(input) {
				const kind = text(input, "kind", 10, false) === "hourly" ? "hourly" : "daily";
				const weather = (await home.cards()).find((card) => card.domain === "weather" && card.available);
				if (!weather) return { content: "Home Assistant has no weather entity.", isError: true };
				const response = await home.serviceResponse("weather", "get_forecasts", { entity_id: weather.entityId, type: kind });
				const forecast = ((response[weather.entityId] as { forecast?: Array<Record<string, unknown>> })?.forecast || [])
					.slice(0, kind === "daily" ? 6 : 16)
					.map((entry) => ({
						at: entry.datetime,
						condition: entry.condition,
						temperature: entry.temperature,
						low: entry.templow,
						precipitation: entry.precipitation,
						precipitation_probability: entry.precipitation_probability,
						wind_speed: entry.wind_speed,
					}));
				return { content: json({ now: stateText(weather), unit: weather.attributes?.temperature_unit, forecast }) };
			},
		},
		...todoTools(home),
	];
}

function todoTools(home: HomeApi): AssistantTool[] {
	const resolve = async (name: string): Promise<EntityCard> => {
		const lists = (await home.cards()).filter((card) => card.domain === "todo");
		const wanted = name.toLowerCase();
		const match =
			lists.find((card) => card.entityId === name) ||
			lists.find((card) => card.name.toLowerCase() === wanted) ||
			lists.find((card) => card.name.toLowerCase().includes(wanted) || card.entityId.includes(wanted.replace(/\s+/g, "_")));
		if (!match) throw new InputError(`No to-do list called "${name}". Lists: ${lists.map((card) => card.name).join(", ") || "none"}`);
		return match;
	};
	return [
		{
			spec: {
				name: "todo_items",
				description: "The user's to-do lists (chores, shopping). Without a list name, lists every list with how many items are open.",
				parameters: object({
					list: { type: "string", description: "List name or entity_id." },
					include_done: { type: "boolean" },
				}),
			},
			async run(input) {
				const name = text(input, "list", 80, false);
				if (!name) {
					const lists = (await home.cards()).filter((card) => card.domain === "todo");
					return { content: json(lists.map((card) => ({ list: card.name, entity_id: card.entityId, open_items: card.state }))) };
				}
				const target = await resolve(name);
				const status = input.include_done === true ? ["needs_action", "completed"] : ["needs_action"];
				const response = await home.serviceResponse("todo", "get_items", { entity_id: target.entityId, status });
				const items = ((response[target.entityId] as { items?: Array<Record<string, unknown>> })?.items || []).slice(0, 80).map((item) => ({
					item: item.summary,
					status: item.status,
					...(item.due ? { due: item.due } : {}),
					...(item.description ? { notes: item.description } : {}),
				}));
				return { content: json({ list: target.name, items }) };
			},
		},
		{
			spec: {
				name: "todo_add",
				description: "Add an item to a to-do list.",
				parameters: object(
					{
						list: { type: "string" },
						item: { type: "string" },
						due_date: { type: "string", description: "YYYY-MM-DD, optional." },
					},
					["list", "item"],
				),
			},
			async run(input) {
				const target = await resolve(text(input, "list", 80));
				const item = text(input, "item", 200);
				const due = text(input, "due_date", 10, false);
				if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new InputError("due_date must be YYYY-MM-DD");
				await home.callService("todo", "add_item", { entity_id: target.entityId, item, ...(due ? { due_date: due } : {}) });
				return { content: `Added "${item}" to ${target.name}.` };
			},
		},
		{
			spec: {
				name: "todo_complete",
				description: "Mark a to-do item as done. Use the item's exact text from todo_items.",
				parameters: object({ list: { type: "string" }, item: { type: "string" } }, ["list", "item"]),
			},
			async run(input) {
				const target = await resolve(text(input, "list", 80));
				const item = text(input, "item", 200);
				await home.callService("todo", "update_item", { entity_id: target.entityId, item, status: "completed" });
				return { content: `Marked "${item}" done on ${target.name}.` };
			},
		},
	];
}

/* ── Reminders, notes, web, parcels, documents ────────────────────────── */

function reminderTools(ctx: ToolContext): AssistantTool[] {
	return [
		{
			spec: {
				name: "set_reminder",
				description:
					"Remind the user at a time: a Discord message and a phone notification. Work out the exact local date and time from the current time in the context.",
				parameters: object(
					{
						message: { type: "string", description: "What to remind them of, as they'd want to read it." },
						at: { type: "string", description: "ISO 8601 date-time with the UTC offset, e.g. 2026-10-28T18:30:00+01:00." },
					},
					["message", "at"],
				),
			},
			async run(input) {
				const message = text(input, "message", 300);
				const at = new Date(text(input, "at", 40));
				if (Number.isNaN(at.getTime())) throw new InputError("at must be an ISO 8601 date-time");
				const now = Date.now();
				if (at.getTime() < now - 60_000) throw new InputError("That time has already passed");
				if (at.getTime() > now + 366 * 86_400_000) throw new InputError("Reminders can be at most a year ahead");
				const created = await ctx.reminders.add(message, at);
				return { content: `Reminder ${created.id} set for ${describeWhen(at)}: ${message}` };
			},
		},
		{
			spec: { name: "list_reminders", description: "The reminders still to come.", parameters: object({}) },
			async run() {
				const reminders = await ctx.reminders.list();
				return {
					content: reminders.length
						? json(reminders.map((reminder) => ({ id: reminder.id, message: reminder.message, when: describeWhen(reminder.time), at: reminder.time.toISOString() })))
						: "No reminders are set.",
				};
			},
		},
		{
			spec: {
				name: "cancel_reminder",
				description: "Cancel a reminder by its id from list_reminders.",
				parameters: object({ id: { type: "string" } }, ["id"]),
			},
			async run(input) {
				const id = text(input, "id", 80);
				return (await ctx.reminders.cancel(id))
					? { content: `Cancelled reminder ${id}.` }
					: { content: `No reminder with id ${id}.`, isError: true };
			},
		},
	];
}

function noteTools(ctx: ToolContext): AssistantTool[] {
	const vault = ctx.vault;
	if (!vault) return [];
	return [
		{
			spec: {
				name: "search_notes",
				description: "Search the user's notes and your saved memories.",
				parameters: object({ query: { type: "string" } }, ["query"]),
			},
			async run(input) {
				const notes = vault.list({ search: text(input, "query", 120) }).slice(0, 5);
				return {
					content: notes.length
						? notes.map((note) => `## ${note.title} (${note.path})\n${clip(note.body.trim(), 800)}`).join("\n\n")
						: "No notes match.",
					view: { memory: notes.map((note) => ({ path: note.path, title: note.title })) },
				};
			},
		},
		{
			spec: {
				name: "save_note",
				description: "Remember a fact about the user for later. Only when they ask you to remember something.",
				parameters: object({ title: { type: "string" }, fact: { type: "string" } }, ["title", "fact"]),
			},
			async run(input) {
				const title = text(input, "title", 80);
				const note = await vault.write(`memory/user/${slug(title)}`, {
					body: text(input, "fact", 1_000),
					frontmatter: { title, type: "user", tags: ["memory"] },
				});
				return { content: `Saved to ${note.path}.`, view: { memory: [{ path: note.path, title: note.title }] } };
			},
		},
	];
}

function webTools(ctx: ToolContext, nativeWebSearch: boolean): AssistantTool[] {
	const tools: AssistantTool[] = [];
	const search = ctx.webSearch;
	if (!nativeWebSearch && search)
		tools.push({
			spec: {
				name: "web_search",
				description: "Search the web. Returns titles, links and snippets; read a page with read_web_page for detail.",
				parameters: object({ query: { type: "string" } }, ["query"]),
			},
			async run(input) {
				const found = await search(text(input, "query", 200));
				const failed = found && typeof found === "object" && "error" in found;
				return { content: json(found), isError: Boolean(failed) };
			},
		});
	const read = ctx.readPage;
	if (read)
		tools.push({
			spec: {
				name: "read_web_page",
				description: "Read the text of a public web page.",
				parameters: object({ url: { type: "string" } }, ["url"]),
			},
			async run(input) {
				const page = await read(text(input, "url", 2_000));
				return { content: json({ title: page.title, url: page.url, text: clip(page.text, 12_000) }, 13_000) };
			},
		});
	return tools;
}

function parcelTools(ctx: ToolContext): AssistantTool[] {
	const parcels = ctx.parcels;
	if (!parcels) return [];
	return [
		{
			spec: {
				name: "track_parcel",
				description: "Start tracking a parcel by its tracking number. Status changes are messaged to the user.",
				parameters: object({ tracking_number: { type: "string" }, label: { type: "string" } }, ["tracking_number"]),
			},
			async run(input) {
				const number = text(input, "tracking_number", 40).replace(/\s+/g, "");
				if (!/^[A-Za-z0-9]{6,40}$/.test(number)) throw new InputError("That doesn't look like a tracking number");
				const result = await parcels.track(number, text(input, "label", 60, false));
				if ("error" in result) return { content: result.error, isError: true };
				return { content: result.text, view: { parcels: [result.card] } };
			},
		},
		{
			spec: { name: "list_parcels", description: "Parcels being tracked and where they are.", parameters: object({}) },
			async run() {
				const listed = parcels.list();
				return { content: listed.text, view: { parcels: listed.cards } };
			},
		},
	];
}

function documentTools(ctx: ToolContext): AssistantTool[] {
	const artifacts = ctx.artifacts;
	if (!artifacts) return [];
	return [
		{
			spec: {
				name: "write_document",
				description:
					"Save a document the user can open in the RemindMe console: notes, a page, an SVG, code, a shader. Write the whole content.",
				parameters: object(
					{
						title: { type: "string" },
						kind: { type: "string", enum: [...DOCUMENT_KINDS] },
						content: { type: "string" },
					},
					["title", "kind", "content"],
				),
			},
			async run(input, effects) {
				const kind = text(input, "kind", 20) as (typeof DOCUMENT_KINDS)[number];
				if (!DOCUMENT_KINDS.includes(kind)) throw new InputError("Unknown document kind");
				const saved = await artifacts.create({ title: text(input, "title", 80), kind, content: text(input, "content", 400_000) });
				effects.artifacts.push(saved);
				return { content: `Saved document ${saved.id}: ${saved.title}`, view: { artifact: { ...saved, content: undefined } } };
			},
		},
		{
			spec: {
				name: "edit_document",
				description: "Replace the content of an existing document, such as the one open in the console. Write the whole new content.",
				parameters: object({ id: { type: "string" }, content: { type: "string" } }, ["id", "content"]),
			},
			async run(input, effects) {
				const id = text(input, "id", 80);
				if (!artifacts.get(id)) return { content: `No document ${id}.`, isError: true };
				const saved = await artifacts.update(id, { content: text(input, "content", 400_000) });
				if (!saved) return { content: `No document ${id}.`, isError: true };
				effects.artifacts.push(saved);
				return { content: `Updated ${saved.title}.`, view: { artifact: { ...saved, content: undefined } } };
			},
		},
	];
}

/* Model APIs allow only these characters in tool names, up to 64. */
const toolName = /^[a-zA-Z0-9_-]{1,64}$/;

async function mcpTools(ctx: ToolContext): Promise<AssistantTool[]> {
	const mcp = ctx.mcp;
	if (!mcp) return [];
	let tools: McpTool[] = [];
	try {
		tools = await mcp.tools();
	} catch (error) {
		console.warn("MCP tools unavailable:", error instanceof Error ? error.message : error);
	}
	return tools
		.filter((tool) => toolName.test(tool.name))
		.map((tool) => ({
			spec: {
				name: tool.name,
				description: clip(tool.description || tool.name, 1_000),
				parameters:
					tool.inputSchema && typeof tool.inputSchema === "object" && tool.inputSchema.type === "object"
						? tool.inputSchema
						: { type: "object", properties: {} },
			},
			async run(input) {
				return { content: json(await mcp.call(tool.name, input), 12_000) };
			},
		}));
}

/** The tools for one turn. Each is present only when what it needs is configured. */
export async function buildTools(ctx: ToolContext, options: { nativeWebSearch: boolean }): Promise<AssistantTool[]> {
	return [
		...deviceTools(ctx),
		...reminderTools(ctx),
		...noteTools(ctx),
		...webTools(ctx, options.nativeWebSearch),
		...parcelTools(ctx),
		...documentTools(ctx),
		...(await mcpTools(ctx)),
	];
}

/** Run one call, turning bad input and failures into a result the model can read. */
export async function runTool(tools: AssistantTool[], call: ToolCall, effects: Effects): Promise<ToolRun> {
	const tool = tools.find((entry) => entry.spec.name === call.name);
	if (!tool) return { content: `There is no tool called ${call.name}.`, isError: true };
	try {
		return await tool.run(call.input || {}, effects);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: error instanceof InputError ? `Invalid input: ${message}` : `Failed: ${message}`, isError: true };
	}
}
