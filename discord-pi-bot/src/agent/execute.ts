import type { EntityCard } from "../harness/entities";
import type { ValidatedEntityAction } from "../harness/entityActions";
import type { VaultNote } from "../harness/vault";
import { describeWhen, parseReminder } from "../harness/reminderParser";
import type { Decision } from "./actions";
import type { Candidate } from "./candidates";
import {
	describeCommand,
	joinNames,
	planCommand,
	stateText,
	type HomeApi,
} from "./home";

/** Everything the executor reaches outside itself, injected so tests can fake it. */
export interface ExecutorDeps {
	home?: HomeApi;
	holdAction(action: ValidatedEntityAction): string;
	holdReminder(reminder: { message: string; at: string }): string;
	listReminders(): Promise<Array<{ id: string; message: string; time: Date }>>;
	webSearch?(query: string): Promise<unknown>;
	vault?: {
		list(filter: { search?: string }): VaultNote[];
		write(
			path: string,
			patch: { body: string; frontmatter: Record<string, string | string[]> },
		): Promise<VaultNote>;
	};
	parcels?: {
		track(number: string, label: string): Promise<{ text: string; card: unknown } | { error: string }>;
		list(): { text: string; cards: unknown[] };
	};
	callMcp?(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface Confirmation {
	confirmation_required: true;
	token: string;
	destructive?: boolean;
	kind?: "reminder";
	message: string;
	[key: string]: unknown;
}

/**
 * What one action produced. Exactly one of `answer` and `facts` is normally
 * set: an answer ends the turn as written, facts go to the speaker to be put
 * into words.
 */
export interface Outcome {
	/** The receipt shown in the tool row's disclosure. */
	result: unknown;
	/** Rich payload for the row (artifact, memory, parcels). */
	view?: unknown;
	/** Entity cards that ride with the answer. */
	cards?: EntityCard[];
	/** Confirmation cards, one tool row each. */
	confirms?: Array<{ label: string; confirm: Confirmation }>;
	answer?: string;
	facts?: string;
}

function slug(text: string): string {
	return (
		String(text || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A search or tool result as compact text for the speaker, bounded. */
function factsFrom(value: unknown, max = 3_000): string {
	if (typeof value === "string") return clip(value, max);
	return clip(JSON.stringify(value, null, 1), max);
}

async function homeControl(
	decision: Extract<Decision, { action: "home_control" }>,
	candidates: Candidate[],
	deps: ExecutorDeps,
): Promise<Outcome> {
	if (!deps.home) return { result: { error: "Home Assistant is not connected" }, answer: "Home Assistant isn't connected to this add-on." };
	const byLabel = new Map(candidates.map((candidate) => [candidate.label, candidate.card]));
	const done: EntityCard[] = [];
	const confirms: Outcome["confirms"] = [];
	const problems: string[] = [];
	for (const label of decision.targets) {
		const card = byLabel.get(label);
		if (!card) {
			problems.push(`I couldn't find "${label}".`);
			continue;
		}
		let plan: ValidatedEntityAction;
		try {
			plan = planCommand(card, decision.command, decision.value);
		} catch (error) {
			problems.push(error instanceof Error ? `${error.message}.` : `Can't do that with ${card.name}.`);
			continue;
		}
		if (plan.requiresConfirmation) {
			const confirmation: Confirmation = {
				confirmation_required: true,
				token: deps.holdAction(plan),
				destructive: plan.destructive,
				message: `Confirm: ${describeCommand(decision.command, decision.value)} ${card.name}`,
			};
			confirms.push({ label: card.name, confirm: confirmation });
			continue;
		}
		try {
			await deps.home.service(plan);
			done.push(card);
		} catch (error) {
			problems.push(`${card.name}: ${error instanceof Error ? error.message : "the call failed"}.`);
		}
	}
	// Read back what actually happened rather than announcing what was asked.
	const refreshed = (
		await Promise.all(done.map((card) => deps.home!.card(card.entityId)))
	).filter((card): card is EntityCard => Boolean(card));
	const lines: string[] = [];
	if (refreshed.length === 1) lines.push(`${refreshed[0].name} is ${stateText(refreshed[0])}.`);
	else if (refreshed.length)
		lines.push(...refreshed.map((card) => `- ${card.name}: ${stateText(card)}`));
	else if (done.length)
		lines.push(`Done: ${describeCommand(decision.command, decision.value)} ${joinNames(done.map((card) => card.name))}.`);
	if (confirms.length)
		lines.push(
			confirms.length === 1
				? `Tap confirm to ${confirms[0].confirm.message.replace(/^Confirm: /, "")}.`
				: "Tap confirm on each action below.",
		);
	lines.push(...problems);
	return {
		result: {
			command: decision.command,
			value: decision.value,
			done: done.map((card) => card.entityId),
			awaiting_confirmation: confirms.map((entry) => entry.label),
			problems,
		},
		cards: refreshed,
		confirms,
		answer: lines.join("\n") || "Nothing to do.",
	};
}

async function homeStatus(
	decision: Extract<Decision, { action: "home_status" }>,
	candidates: Candidate[],
	deps: ExecutorDeps,
): Promise<Outcome> {
	const byLabel = new Map(candidates.map((candidate) => [candidate.label, candidate.card]));
	const cards = decision.targets
		.map((label) => byLabel.get(label))
		.filter((card): card is EntityCard => Boolean(card));
	if (!cards.length) return { result: { error: "No matching device" }, answer: "I couldn't find that device." };
	const lines =
		cards.length === 1
			? [`${cards[0].name} is ${stateText(cards[0])}.`]
			: cards.map((card) => `- ${card.name}: ${stateText(card)}`);
	return {
		result: cards.map((card) => ({ id: card.entityId, name: card.name, state: stateText(card) })),
		cards,
		answer: lines.join("\n"),
	};
}

/** Run one decided action. `document_*` and `reply` are the speaker's, not handled here. */
export async function execute(
	decision: Decision,
	candidates: Candidate[],
	deps: ExecutorDeps,
): Promise<Outcome> {
	switch (decision.action) {
		case "home_control":
			return homeControl(decision, candidates, deps);
		case "home_status":
			return homeStatus(decision, candidates, deps);
		case "reminder_add": {
			const parsed = parseReminder(decision.request);
			if (!parsed.at)
				return {
					result: { error: "No time found", message: parsed.message },
					answer: `When should I remind you${parsed.message ? ` to ${parsed.message}` : ""}?`,
				};
			const at = parsed.at.toISOString();
			const when = describeWhen(parsed.at);
			const confirm: Confirmation = {
				confirmation_required: true,
				kind: "reminder",
				token: deps.holdReminder({ message: parsed.message, at }),
				message: parsed.message,
				at,
				when,
				assumedEvening: parsed.assumedEvening,
			};
			return {
				result: confirm,
				confirms: [],
				answer: `Reminder ready: "${parsed.message}" ${when}. Tap confirm to set it.`,
			};
		}
		case "reminder_list": {
			const reminders = await deps.listReminders();
			if (!reminders.length) return { result: [], answer: "You have no reminders set." };
			const sorted = [...reminders].sort((a, b) => a.time.getTime() - b.time.getTime());
			return {
				result: sorted.map((item) => ({ id: item.id, message: item.message, time: item.time.toISOString() })),
				answer: sorted.map((item) => `- ${item.message} — ${describeWhen(item.time)}`).join("\n"),
			};
		}
		case "web_search": {
			if (!deps.webSearch)
				return { result: { error: "No web search configured" }, answer: "Web search isn't set up. Add a SearXNG URL or an Exa key in the add-on options." };
			const found = await deps.webSearch(decision.query);
			if (found && typeof found === "object" && "error" in found)
				return { result: found, answer: `The web search failed: ${(found as { error: string }).error}` };
			return { result: found, facts: factsFrom(found) };
		}
		case "memory_recall": {
			const notes = deps.vault?.list({ search: decision.query }).slice(0, 5) || [];
			const summary = notes.map((note) => ({ path: note.path, title: note.title }));
			if (!notes.length)
				return { result: { matches: [] }, facts: `No saved notes match "${decision.query}".` };
			return {
				result: summary,
				view: { memory: summary },
				facts: notes
					.slice(0, 3)
					.map((note) => `## ${note.title} (${note.path})\n${clip(note.body.trim(), 700)}`)
					.join("\n\n"),
			};
		}
		case "memory_save": {
			if (!deps.vault) return { result: { error: "No vault" }, answer: "Memory isn't available." };
			const note = await deps.vault.write(`memory/user/${slug(decision.title)}`, {
				body: decision.fact,
				frontmatter: { title: decision.title, type: "user", tags: ["memory"] },
			});
			const summary = { path: note.path, title: note.title };
			return { result: { saved: true, ...summary }, view: { memory: [summary] }, answer: `Saved to memory: **${note.title}**.` };
		}
		case "parcel_track": {
			if (!deps.parcels) return { result: { error: "Parcel tracking is off" }, answer: "Parcel tracking is off. Set the TrackingMore API key in the add-on options." };
			const tracked = await deps.parcels.track(decision.tracking_number, decision.label || "");
			if ("error" in tracked) return { result: tracked, answer: tracked.error };
			return { result: tracked.card, view: { parcels: [tracked.card] }, answer: tracked.text };
		}
		case "parcel_list": {
			if (!deps.parcels) return { result: { error: "Parcel tracking is off" }, answer: "Parcel tracking is off. Set the TrackingMore API key in the add-on options." };
			const listed = deps.parcels.list();
			return { result: listed.cards, view: { parcels: listed.cards }, answer: listed.text };
		}
		case "mcp": {
			if (!deps.callMcp) return { result: { error: "MCP unavailable" }, answer: "That tool isn't available." };
			try {
				const value = await deps.callMcp(decision.tool, decision.arguments);
				return { result: value, facts: factsFrom(value) };
			} catch (error) {
				const message = error instanceof Error ? error.message : "MCP call failed";
				return { result: { error: message }, answer: `The tool call failed: ${message}` };
			}
		}
		default:
			return { result: {} };
	}
}
