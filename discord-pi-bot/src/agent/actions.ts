import type { Candidate } from "./candidates";

/**
 * What the model may do in one turn, as a closed set. The model answers the
 * decision call with exactly one of these, and the schema below is compiled
 * into a grammar — so it can pick the wrong action, but it cannot invent one,
 * misspell an argument, or name a device that is not on the shortlist.
 */
export const HOME_COMMANDS = [
	"turn_on",
	"turn_off",
	"toggle",
	"set_brightness",
	"set_color",
	"set_color_temperature",
	"set_temperature",
	"set_hvac_mode",
	"set_position",
	"open",
	"close",
	"lock",
	"unlock",
	"set_fan_speed",
	"play",
	"pause",
	"next_track",
	"set_volume",
	"start",
	"return_home",
] as const;
export type HomeCommand = (typeof HOME_COMMANDS)[number];

export const DOCUMENT_KINDS = [
	"html",
	"svg",
	"markdown",
	"code",
	"glsl",
	"wgsl",
	"three",
	"lua",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type Decision =
	| { action: "reply" }
	| { action: "home_control"; targets: string[]; command: HomeCommand; value?: string }
	| { action: "home_status"; targets: string[] }
	| { action: "reminder_add"; request: string }
	| { action: "reminder_list" }
	| { action: "web_search"; query: string }
	| { action: "memory_recall"; query: string }
	| { action: "memory_save"; title: string; fact: string }
	| { action: "parcel_track"; tracking_number: string; label?: string }
	| { action: "parcel_list" }
	| { action: "document_write"; title: string; kind: DocumentKind }
	| { action: "document_edit"; instruction: string }
	| { action: "mcp"; tool: string; arguments: Record<string, unknown> };

export type ActionName = Decision["action"];

export interface McpToolRef {
	/** Wire name, `mcp__<server>__<tool>`. */
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** What exists this turn. Unavailable actions are simply absent from the schema. */
export interface ActionContext {
	home: boolean;
	/**
	 * Device-changing actions are on offer only when the wording commands
	 * something (see `looksLikeCommand`). Reading state stays open to the
	 * model; flipping a switch is never a guess.
	 */
	homeControl: boolean;
	candidates: Candidate[];
	reminders: boolean;
	web: boolean;
	memory: boolean;
	/** Saving is offered only when the user asked to remember something. */
	memoryWrite: boolean;
	parcels: boolean;
	documents: boolean;
	openDocument?: { id: string; title: string; kind: string };
	mcpTools: McpToolRef[];
}

/**
 * Which commands make sense for the shortlisted devices. Offering "set_color"
 * when only a thermostat is on the list is an invitation to a wrong call.
 */
export function commandsFor(candidates: Candidate[]): HomeCommand[] {
	if (!candidates.length) return [...HOME_COMMANDS];
	const allowed = new Set<HomeCommand>();
	for (const { card } of candidates) {
		const domain = card.domain;
		if (["light", "switch", "fan", "media_player", "humidifier"].includes(domain)) {
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
			allowed.add("set_temperature");
			allowed.add("set_hvac_mode");
			allowed.add("turn_on");
			allowed.add("turn_off");
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
			allowed.add("play");
			allowed.add("pause");
			allowed.add("next_track");
			allowed.add("set_volume");
		}
		if (domain === "vacuum") {
			allowed.add("start");
			allowed.add("return_home");
		}
	}
	return HOME_COMMANDS.filter((command) => allowed.has(command));
}

function branch(
	action: ActionName,
	properties: Record<string, unknown> = {},
	required: string[] = [],
): Record<string, unknown> {
	return {
		type: "object",
		properties: { action: { const: action }, ...properties },
		required: ["action", ...required],
		additionalProperties: false,
	};
}

const shortText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

function targetsSchema(candidates: Candidate[]) {
	return {
		type: "array",
		items: candidates.length
			? { type: "string", enum: candidates.map((candidate) => candidate.label) }
			: shortText(60),
		minItems: 1,
		maxItems: Math.max(1, Math.min(8, candidates.length || 3)),
	};
}

/** The actions on offer this turn, in a stable order. */
export function availableActions(context: ActionContext): ActionName[] {
	const names: ActionName[] = ["reply"];
	// A shortlist of sensors has nothing to command; an empty enum is also
	// a schema llama.cpp refuses outright.
	// Device actions need a shortlist to pick from. Without one the model can
	// only invent a name — in practice, one from its examples.
	const shortlisted = context.home && context.candidates.length > 0;
	if (shortlisted && context.homeControl && commandsFor(context.candidates).length)
		names.push("home_control");
	if (shortlisted) names.push("home_status");
	if (context.reminders) names.push("reminder_add", "reminder_list");
	if (context.web) names.push("web_search");
	if (context.memory) names.push("memory_recall");
	if (context.memory && context.memoryWrite) names.push("memory_save");
	if (context.parcels) names.push("parcel_track", "parcel_list");
	if (context.documents) names.push("document_write");
	if (context.documents && context.openDocument) names.push("document_edit");
	if (context.mcpTools.length) names.push("mcp");
	return names;
}

/**
 * The decision schema: one branch per available action. Property order is
 * deliberate — `action` comes first, so the model commits to what it is
 * doing before it fills anything in.
 */
export function decisionSchema(
	context: ActionContext,
	{ includeMcp = true }: { includeMcp?: boolean } = {},
): Record<string, unknown> {
	const branches: Record<string, unknown>[] = [];
	for (const name of availableActions(context)) {
		switch (name) {
			case "reply":
				branches.push(branch("reply"));
				break;
			case "home_control":
				branches.push(
					branch(
						"home_control",
						{
							targets: targetsSchema(context.candidates),
							command: { type: "string", enum: commandsFor(context.candidates) },
							value: shortText(24),
						},
						["targets", "command"],
					),
				);
				break;
			case "home_status":
				branches.push(
					branch("home_status", { targets: targetsSchema(context.candidates) }, ["targets"]),
				);
				break;
			case "reminder_add":
				branches.push(branch("reminder_add", { request: shortText(200) }, ["request"]));
				break;
			case "reminder_list":
			case "parcel_list":
				branches.push(branch(name));
				break;
			case "web_search":
			case "memory_recall":
				branches.push(branch(name, { query: shortText(120) }, ["query"]));
				break;
			case "memory_save":
				branches.push(
					branch("memory_save", { title: shortText(80), fact: shortText(400) }, ["title", "fact"]),
				);
				break;
			case "parcel_track":
				branches.push(
					branch(
						"parcel_track",
						{
							tracking_number: { type: "string", pattern: "^[A-Za-z0-9]{6,40}$" },
							label: shortText(60),
						},
						["tracking_number"],
					),
				);
				break;
			case "document_write":
				branches.push(
					branch(
						"document_write",
						{ title: shortText(80), kind: { type: "string", enum: [...DOCUMENT_KINDS] } },
						["title", "kind"],
					),
				);
				break;
			case "document_edit":
				branches.push(branch("document_edit", { instruction: shortText(300) }, ["instruction"]));
				break;
			case "mcp":
				if (!includeMcp) break;
				for (const tool of context.mcpTools)
					branches.push(
						branch(
							"mcp",
							{
								tool: { const: tool.name },
								arguments: sanitizeToolSchema(tool.inputSchema),
							},
							["tool", "arguments"],
						),
					);
				break;
		}
	}
	return branches.length === 1 ? branches[0] : { anyOf: branches };
}

/**
 * MCP servers publish schemas with keywords a grammar compiler may not know
 * ($schema, titles, formats). Keep the structural part; drop the rest.
 */
export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
	const structural = new Set([
		"type",
		"properties",
		"required",
		"items",
		"enum",
		"const",
		"anyOf",
		"oneOf",
		"minItems",
		"maxItems",
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"additionalProperties",
		"description",
	]);
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (!value || typeof value !== "object") return value;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (key === "properties" && child && typeof child === "object") {
				out.properties = Object.fromEntries(
					Object.entries(child as Record<string, unknown>).map(([name, sub]) => [
						name,
						walk(sub),
					]),
				);
			} else if (structural.has(key)) out[key] = walk(child);
		}
		return out;
	};
	const cleaned = walk(schema);
	return cleaned && typeof cleaned === "object" && (cleaned as { type?: unknown }).type
		? (cleaned as Record<string, unknown>)
		: { type: "object", properties: {} };
}

function stringField(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Check a parsed decision against this turn's context. The grammar already
 * guarantees the shape on llama.cpp; this is the guard for endpoints that
 * ignore response_format, and for anything the grammar cannot express.
 * Anything that fails becomes a plain reply rather than a bad call.
 */
export function validateDecision(value: unknown, context: ActionContext): Decision {
	const reply: Decision = { action: "reply" };
	if (!value || typeof value !== "object") return reply;
	const raw = value as Record<string, unknown>;
	const action = raw.action as ActionName;
	if (!availableActions(context).includes(action)) return reply;
	const labels = new Map(
		context.candidates.map((candidate) => [candidate.label.toLowerCase(), candidate.label]),
	);
	const targets = (): string[] => {
		const list = Array.isArray(raw.targets) ? raw.targets : [raw.targets];
		const cleaned = list
			.map((item) => stringField(item, 80))
			.filter(Boolean)
			.map((item) => (labels.size ? labels.get(item.toLowerCase()) || "" : item))
			.filter(Boolean);
		return [...new Set(cleaned)].slice(0, 8);
	};
	switch (action) {
		case "reply":
		case "reminder_list":
		case "parcel_list":
			return { action };
		case "home_control": {
			const list = targets();
			const offered = commandsFor(context.candidates);
			let command = raw.command as HomeCommand;
			let value = stringField(raw.value, 24);
			/*
			 * Small models sometimes put the verb in the value slot —
			 * {command: "play", value: "pause"}. When the value is itself an
			 * offered command, it is the one the user said.
			 */
			const named = value.toLowerCase().replace(/\s+/g, "_") as HomeCommand;
			if (value && offered.includes(named) && named !== command) {
				command = named;
				value = "";
			}
			if (!list.length || !offered.includes(command)) return reply;
			const decision: Decision = { action, targets: list, command };
			if (value) decision.value = value;
			return decision;
		}
		case "home_status": {
			const list = targets();
			return list.length ? { action, targets: list } : reply;
		}
		case "reminder_add": {
			const request = stringField(raw.request, 200);
			return request ? { action, request } : reply;
		}
		case "web_search":
		case "memory_recall": {
			const query = stringField(raw.query, 120);
			return query ? { action, query } : reply;
		}
		case "memory_save": {
			const fact = stringField(raw.fact, 400);
			const title = stringField(raw.title, 80) || fact.slice(0, 60);
			return fact ? { action, title, fact } : reply;
		}
		case "parcel_track": {
			const number = stringField(raw.tracking_number, 40).replace(/\s+/g, "");
			if (!/^[A-Za-z0-9]{6,40}$/.test(number)) return reply;
			const label = stringField(raw.label, 60);
			return label
				? { action, tracking_number: number, label }
				: { action, tracking_number: number };
		}
		case "document_write": {
			const title = stringField(raw.title, 80) || "Untitled";
			const kind = DOCUMENT_KINDS.includes(raw.kind as DocumentKind)
				? (raw.kind as DocumentKind)
				: "markdown";
			return { action, title, kind };
		}
		case "document_edit": {
			const instruction = stringField(raw.instruction, 300);
			return instruction ? { action, instruction } : reply;
		}
		case "mcp": {
			const tool = context.mcpTools.find((entry) => entry.name === raw.tool);
			if (!tool) return reply;
			const args =
				raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)
					? (raw.arguments as Record<string, unknown>)
					: {};
			return { action, tool: tool.name, arguments: args };
		}
	}
	return reply;
}

/** Explicit requests to store something. Saving is never the model's own idea. */
const rememberTerms =
	/\b(remember (?:that|this|my|i|we)|don'?t forget (?:that|my)|note (?:that|down)|keep in mind|save (?:this|that) (?:to|in|as) (?:memory|a note|notes)|add (?:this|that) to (?:memory|my notes)|make a note)\b/i;

export function asksToRemember(prompt: string): boolean {
	return rememberTerms.test(prompt);
}

/**
 * Words that command a device. A 1B model shown a device list will "helpfully"
 * switch something when asked why LEDs flicker; requiring one of these before
 * home_control is even in the grammar removes that failure outright, and the
 * cost — a command phrased with none of them — is a reply instead of an action.
 */
const commandTerms =
	/\b(turn|switch|set|dim|brighten|open|close|shut|lock|unlock|start|stop|pause|resume|play|skip|next|activate|deactivate|enable|disable|toggle|make|put|raise|lower|increase|decrease|change|run|heat|cool|mute|unmute|arm|disarm|boost|bump|crank)\b|\b(on|off|up|down)\b\W*(?:please)?\W*$/i;

const acknowledgementTerms =
	/^\W*(?:ok(?:ay)?|cool|great|perfect|nice|awesome|thanks?|thank you|cheers|brilliant|lovely|good|got it|that(?:'s| is| was)? (?:it|perfect|great|good|right)|it works?|works|worked|that worked)\b/i;

export function looksLikeCommand(
	prompt: string,
	history: Array<{ role: string; content: string }> = [],
): boolean {
	const text = String(prompt || "").trim();
	const wordCount = text.split(/\s+/).length;
	if (acknowledgementTerms.test(text) && wordCount <= 8) return false;
	if (commandTerms.test(text)) return true;
	/*
	 * "and the floor lamp too", "the other one": short, verbless, and only a
	 * command because the previous request was one.
	 */
	const previous = [...history].reverse().find((turn) => turn.role === "user");
	return Boolean(previous) && wordCount <= 8 && commandTerms.test(previous!.content);
}
