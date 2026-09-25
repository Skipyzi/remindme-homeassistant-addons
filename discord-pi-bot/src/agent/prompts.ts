import type { ActionContext, ActionName, DocumentKind } from "./actions";
import { availableActions } from "./actions";
import { describeCandidate, type Candidate } from "./candidates";
import type { ChatMessage } from "./llm";
import type { HistoryTurn } from "../harness/history";

const actionHelp: Record<ActionName, string> = {
	reply:
		"reply: talk, explain, answer from general knowledge, do maths, write short text in the chat, or ask the user a question. The default whenever nothing else is clearly needed.",
	home_control:
		'home_control: change devices in the home. targets = names copied from "Devices". command = what to do. value = a number or word when needed, e.g. "30" (percent), "+10", "red", "warm", "21" (degrees), "heat".',
	home_status:
		'home_status: read the current state of devices from "Devices" (on/off, temperature, open/closed, playing).',
	reminder_add:
		"reminder_add: the user asks to be reminded of something. request = their words including the time.",
	reminder_list: "reminder_list: the user asks which reminders are set.",
	web_search:
		"web_search: needs current or outside facts — news, prices, sports results, opening hours, releases, anything recent. query = short search terms.",
	memory_recall:
		"memory_recall: the user asks about something they told you before or saved in their notes.",
	memory_save:
		"memory_save: the user explicitly asks you to remember something. fact = what to remember, in one or two sentences.",
	parcel_track: "parcel_track: the user gives a parcel tracking number to follow.",
	parcel_list: "parcel_list: the user asks where their parcels or packages are.",
	document_write:
		"document_write: the user asks for a page, app, diagram, chart, shader or file to look at. Not for answers that fit in a chat message.",
	document_edit: 'document_edit: change the open document. instruction = the change, in the user\'s words.',
	mcp: "mcp: call one of the external tools listed under \"External tools\" when its purpose matches the request exactly.",
};

/**
 * The routing system prompt. It depends on which actions are on offer, not
 * on the wording of the request, so for the common turns — the same
 * features, no document open, nothing to remember — the prefix is identical
 * and llama.cpp keeps it in its KV cache instead of re-reading ~1k tokens
 * on a Pi for every message.
 */
export function decideSystemPrompt(actions: ActionName[]): string {
	return [
		"You route requests for RemindMe, a home assistant. Pick exactly one action and answer with JSON only.",
		"",
		"Actions:",
		...actions.map((name) => `- ${actionHelp[name]}`),
		"",
		"Rules:",
		'- Use home_control or home_status only when the request is about devices in the home, and only with names listed under "Devices".',
		"- Greetings, thanks, opinions, general knowledge, maths and writing short texts are reply.",
		"- A follow-up like \"and the other one\" or \"make it warmer\" refers to the earlier conversation.",
		"- If unsure, choose reply.",
	].join("\n");
}


function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface DecideInput {
	prompt: string;
	candidates: Candidate[];
	history?: HistoryTurn[];
	openDocument?: ActionContext["openDocument"];
	mcpTools?: ActionContext["mcpTools"];
	home?: boolean;
}

/** The per-request part of the routing prompt: what is on the shortlist, and the ask. */
export function decideUserMessage(input: DecideInput): string {
	const lines: string[] = [];
	const recent = (input.history || []).slice(-4);
	if (recent.length) {
		lines.push("Earlier:");
		for (const turn of recent)
			lines.push(`${turn.role === "user" ? "User" : "Assistant"}: ${clip(turn.content, 160)}`);
		lines.push("");
	}
	if (input.home !== false) {
		lines.push("Devices:");
		if (input.candidates.length) lines.push(...input.candidates.map(describeCandidate));
		else lines.push("- none matched");
		lines.push("");
	}
	if (input.openDocument)
		lines.push(
			`Open document: "${input.openDocument.title}" (${input.openDocument.kind}). document_edit changes it.`,
			"",
		);
	if (input.mcpTools?.length) {
		lines.push("External tools:");
		for (const tool of input.mcpTools) lines.push(`- ${tool.name}: ${clip(tool.description, 140)}`);
		lines.push("");
	}
	lines.push(`Request: ${input.prompt}`);
	return lines.join("\n");
}

interface Example {
	needs: ActionName[];
	input: DecideInput;
	output: Record<string, unknown>;
}

const exampleCard = (
	name: string,
	domain: string,
	state: string,
	area?: string,
	extra: Record<string, unknown> = {},
) =>
	({
		label: name,
		score: 1,
		card: {
			entityId: `${domain}.${name.toLowerCase().replace(/\W+/g, "_")}`,
			domain,
			name,
			state,
			area,
			available: true,
			capabilities: {},
			...extra,
		},
	}) as unknown as Candidate;

/*
 * Few-shot examples, written in exactly the format of a real request. Half
 * of them are the negative cases — thanks, knowledge questions that mention
 * a device word, a haiku — because "call nothing" is the decision small
 * models get wrong most.
 */
const examples: Example[] = [
	{
		needs: ["home_control"],
		input: {
			prompt: "switch on my desk lamp",
			candidates: [exampleCard("Desk Lamp", "light", "off", "Office")],
		},
		output: { action: "home_control", targets: ["Desk Lamp"], command: "turn_on" },
	},
	{
		needs: ["reply"],
		input: {
			prompt: "why do cheap LED lamps flicker?",
			candidates: [exampleCard("Desk Lamp", "light", "off", "Office")],
		},
		output: { action: "reply" },
	},
	{
		needs: ["home_control"],
		input: {
			prompt: "dim the living room lights to 30%",
			candidates: [
				exampleCard("Ceiling Light", "light", "on", "Living Room", { brightness: 204 }),
				exampleCard("Floor Lamp", "light", "on", "Living Room", { brightness: 255 }),
			],
		},
		output: {
			action: "home_control",
			targets: ["Ceiling Light", "Floor Lamp"],
			command: "set_brightness",
			value: "30",
		},
	},
	{
		needs: ["reply"],
		input: {
			prompt: "what's a healthy humidity level for a bedroom?",
			candidates: [exampleCard("Bedroom Humidity", "sensor", "61", "Bedroom", { unit: "%" })],
		},
		output: { action: "reply" },
	},
	{
		needs: ["home_status"],
		input: {
			prompt: "how warm is it in the bedroom?",
			candidates: [exampleCard("Bedroom Temperature", "sensor", "19.5", "Bedroom", { unit: "°C" })],
		},
		output: { action: "home_status", targets: ["Bedroom Temperature"] },
	},
	{
		needs: ["reply"],
		input: {
			prompt: "thanks, that worked!",
			candidates: [],
			history: [
				{ role: "user", content: "turn on the hallway light" },
				{ role: "assistant", content: "Hallway Light is on." },
			],
		},
		output: { action: "reply" },
	},
	{
		needs: ["home_control"],
		input: {
			prompt: "make it a bit warmer",
			candidates: [exampleCard("Kitchen Light", "light", "on", "Kitchen", { brightness: 255 })],
			history: [
				{ role: "user", content: "turn on the kitchen light" },
				{ role: "assistant", content: "Kitchen Light is on." },
			],
		},
		output: {
			action: "home_control",
			targets: ["Kitchen Light"],
			command: "set_color_temperature",
			value: "warm",
		},
	},
	{
		needs: ["reminder_add"],
		input: { prompt: "remind me to call mum tomorrow at 6pm", candidates: [] },
		output: { action: "reminder_add", request: "call mum tomorrow at 6pm" },
	},
	{
		needs: ["reply"],
		input: { prompt: "write a short haiku about coffee", candidates: [] },
		output: { action: "reply" },
	},
	{
		needs: ["web_search"],
		input: { prompt: "who won the F1 race last weekend?", candidates: [] },
		output: { action: "web_search", query: "F1 race winner last weekend" },
	},
	{
		needs: ["reply"],
		input: { prompt: "what's 15% of 240?", candidates: [] },
		output: { action: "reply" },
	},
	{
		needs: ["memory_recall"],
		input: { prompt: "what did I tell you my wifi guest password was?", candidates: [] },
		output: { action: "memory_recall", query: "wifi guest password" },
	},
	{
		needs: ["memory_save"],
		input: { prompt: "remember that the spare key is under the blue pot", candidates: [] },
		output: { action: "memory_save", title: "Spare key", fact: "The spare key is under the blue pot." },
	},
	{
		needs: ["document_write"],
		input: { prompt: "make me an html page with a countdown to christmas", candidates: [] },
		output: { action: "document_write", title: "Christmas Countdown", kind: "html" },
	},
];

/** The complete message list for one routing call. */
export function decideMessages(context: ActionContext, input: DecideInput): ChatMessage[] {
	const actions = availableActions(context);
	const shots = examples.filter((example) =>
		example.needs.every((name) => actions.includes(name)),
	);
	const messages: ChatMessage[] = [{ role: "system", content: decideSystemPrompt(actions) }];
	for (const shot of shots) {
		messages.push({
			role: "user",
			content: decideUserMessage({ ...shot.input, home: context.home }),
		});
		messages.push({ role: "assistant", content: JSON.stringify(shot.output) });
	}
	messages.push({
		role: "user",
		content: decideUserMessage({
			...input,
			home: context.home,
			openDocument: context.openDocument,
			mcpTools: context.mcpTools,
		}),
	});
	return messages;
}

/* ── Speaking ────────────────────────────────────────────────────────── */

/**
 * The standing note under the persona for every free-text answer. The model
 * has no tools while speaking, so it must not claim an action happened
 * unless a result says so.
 */
export const SPEAKER_RULES =
	" Device actions, reminders, searches and notes are carried out by the app, not by you: never claim something was switched, set, saved or looked up unless a result in this conversation says so. Keep answers short unless asked for detail.";

const kindGuide: Record<DocumentKind, string> = {
	html: "A complete, self-contained HTML page with inline CSS and JavaScript.",
	svg: "A single standalone <svg> element with a viewBox.",
	markdown: "A Markdown document.",
	code: "Source code only.",
	glsl:
		"A WebGL2 fragment shader. Write either a Shadertoy-style 'void mainImage(out vec4 fragColor, in vec2 fragCoord)' or a plain 'void main()'. iResolution, iTime, iTimeDelta, iFrame and iMouse are declared for you; do not write a #version line.",
	wgsl:
		"A WebGPU shader defining '@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f'. The vertex stage and a uniform block 'U' with resolution, time, timeDelta, mouse and frame are supplied.",
	three:
		"three.js scene code only, using the supplied THREE, scene, camera and renderer. Optionally define update(delta, elapsed) to animate. Do not create a renderer or a resize handler.",
	lua: "A Lua program; print() writes to the frame.",
};

export function documentSystemPrompt(kind: DocumentKind): string {
	return `You write documents for a viewer. ${kindGuide[kind]} Output only the document source itself — no explanation before or after it, and no Markdown code fences.`;
}

export function documentWriteMessages(
	kind: DocumentKind,
	title: string,
	prompt: string,
): ChatMessage[] {
	return [
		{ role: "system", content: documentSystemPrompt(kind) },
		{ role: "user", content: `Write "${title}".\n\nRequest: ${prompt}` },
	];
}

export function documentEditMessages(
	kind: DocumentKind,
	content: string,
	instruction: string,
): ChatMessage[] {
	return [
		{ role: "system", content: documentSystemPrompt(kind) },
		{
			role: "user",
			content: `Current document:\n${content}\n\nChange requested: ${instruction}\n\nOutput the complete updated document.`,
		},
	];
}

const actionParameters: Record<ActionName, string[]> = {
	reply: [],
	home_control: ["targets", "command", "value"],
	home_status: ["targets"],
	reminder_add: ["request"],
	reminder_list: [],
	web_search: ["query"],
	memory_recall: ["query"],
	memory_save: ["title", "fact"],
	parcel_track: ["tracking_number", "label"],
	parcel_list: [],
	document_write: ["title", "kind"],
	document_edit: ["instruction"],
	mcp: ["tool", "arguments"],
};

/** The action catalog as the console's /tools listing shows it. */
export function describeActions(): Array<{ name: string; description: string; parameters: string[] }> {
	return (Object.keys(actionHelp) as ActionName[]).map((name) => ({
		name,
		description: actionHelp[name].replace(/^[a-z_]+: /, ""),
		parameters: actionParameters[name],
	}));
}
