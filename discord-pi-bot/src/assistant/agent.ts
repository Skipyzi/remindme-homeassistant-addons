import type { AiSettings } from "../ai/settings";
import type { SpendLedger } from "../ai/spend";
import {
	ProviderError,
	addUsage,
	emptyUsage,
	type Effort,
	type ImageInput,
	type PriorTurn,
	type Step,
	type ToolCall,
	type Usage,
} from "../ai/types";
import type { Artifact } from "../harness/artifacts";
import type { EntityCard } from "../harness/entities";
import type { VaultNote } from "../harness/vault";
import type { Confirmation } from "./confirmations";
import { systemPrompt, turnContext, type Channel } from "./prompt";
import { buildTools, runTool, type Effects, type ToolContext, type ToolRun } from "./tools";

/** Tool rounds per turn. A brief or a "check everything" question needs a few. */
const MAX_ROUNDS = 10;
/* Thinking counts against this too, so it leaves room for both. */
const MAX_TOKENS = 16_000;
/* Plenty for a running chat; older turns cost tokens on every message. */
const MAX_HISTORY_TURNS = 30;
const MAX_HISTORY_CHARS = 40_000;

export interface AssistantDeps {
	settings: AiSettings;
	spend: SpendLedger;
	/** Persona plus enabled skills. */
	persona(): string;
	/** Built per turn so option changes (search, TrackingMore, MCP) apply at once. */
	tools(): ToolContext;
	recall?(prompt: string): VaultNote[];
	/** "Home, Berlin": Home Assistant's location name. */
	home?(): string | undefined;
	searchFallback(): boolean;
}

export interface AskInput {
	prompt: string;
	channel: Channel;
	history?: PriorTurn[];
	images?: ImageInput[];
	openDocument?: Artifact;
	effort?: Effort;
	/** More context for this turn only, such as the facts for a brief. */
	extra?: string;
	signal?: AbortSignal;
}

export interface AskEvents {
	roundStart?(round: number): void;
	roundEnd?(round: number, step: Step): void;
	text?(delta: string, round: number): void;
	thinking?(delta: string, round: number): void;
	toolStart?(call: ToolCall, round: number): void;
	toolEnd?(call: ToolCall, result: ToolRun, round: number): void;
	/** Search the provider ran on its own servers. */
	searched?(query: string, round: number): void;
	confirm?(confirmation: Confirmation, round: number): void;
}

export interface AskResult {
	text: string;
	/** Set when the assistant could not answer at all (no key, over budget, failure). */
	problem?: string;
	confirms: Confirmation[];
	cards: EntityCard[];
	artifacts: Artifact[];
	model: string;
	usage: Usage;
	costUsd?: number;
	rounds: number;
}

/** Keep the most recent turns that fit, oldest dropped first. */
export function trimHistory(history: PriorTurn[]): PriorTurn[] {
	const kept: PriorTurn[] = [];
	let chars = 0;
	for (const turn of [...history].reverse()) {
		if (kept.length >= MAX_HISTORY_TURNS || chars + turn.text.length > MAX_HISTORY_CHARS) break;
		kept.push(turn);
		chars += turn.text.length;
	}
	return kept.reverse();
}

function failure(problem: string, model = ""): AskResult {
	return { text: problem, problem, confirms: [], cards: [], artifacts: [], model, usage: emptyUsage(), rounds: 0 };
}

/**
 * The assistant: one turn is a loop of model calls and tool runs until the
 * model answers in words. Which model answers is whatever the settings say
 * right now; the console, Discord, tasks and the brief all come through here.
 */
export class Assistant {
	constructor(private readonly deps: AssistantDeps) {}

	async ask(input: AskInput, events: AskEvents = {}): Promise<AskResult> {
		const { settings, spend } = this.deps;
		const provider = settings.provider();
		if (!provider) return failure(settings.problem());
		const budget = settings.dailyBudget();
		if (spend.overBudget(budget))
			return failure(
				`Today's AI budget of $${budget.toFixed(2)} is used up, so I'm pausing until midnight. You can raise it in the RemindMe app's options.`,
				provider.model,
			);
		if (input.images?.length && !provider.vision)
			return failure(`${provider.label} with ${provider.model} can't look at images here. Switch to Claude or OpenAI to send pictures.`, provider.model);

		const tools = await buildTools(this.deps.tools(), { nativeWebSearch: provider.nativeWebSearch });
		const session = provider.start({
			system: systemPrompt(this.deps.persona()),
			context: turnContext({
				channel: input.channel,
				home: this.deps.home?.(),
				recalled: this.deps.recall?.(input.prompt),
				openDocument: input.openDocument,
				extra: input.extra,
			}),
			history: trimHistory(input.history || []),
			prompt: input.prompt,
			images: input.images,
			tools: tools.map((tool) => tool.spec),
			webSearch: provider.nativeWebSearch,
			effort: input.effort || settings.effort(),
			maxTokens: MAX_TOKENS,
			signal: input.signal,
		});

		const effects: Effects = { cards: new Map(), confirms: [], artifacts: [] };
		let usage = emptyUsage();
		let model = provider.model;
		let answer = "";
		let rounds = 0;
		let problem: string | undefined;
		try {
			for (; rounds < MAX_ROUNDS; ) {
				const round = rounds++;
				events.roundStart?.(round);
				const step = await session.next({
					text: (delta) => events.text?.(delta, round),
					thinking: (delta) => events.thinking?.(delta, round),
					searched: (query) => events.searched?.(query, round),
				});
				usage = addUsage(usage, step.usage);
				model = step.model;
				if (step.stop !== "tools") events.roundEnd?.(round, step);
				if (step.stop === "refused") {
					answer = step.text.trim() || "I can't help with that one.";
					break;
				}
				if (step.stop === "max_tokens") {
					answer = `${step.text.trim()}\n\n(I ran out of room for this answer. Ask me to continue, or to be briefer.)`.trim();
					break;
				}
				if (step.stop === "end") {
					answer = step.text.trim();
					break;
				}
				const results = [];
				// One at a time: two commands to the same lamp must land in order.
				for (const call of step.calls) {
					events.toolStart?.(call, round);
					const confirmsBefore = effects.confirms.length;
					const result = await runTool(tools, call, effects);
					events.toolEnd?.(call, result, round);
					for (const confirmation of effects.confirms.slice(confirmsBefore)) events.confirm?.(confirmation, round);
					results.push({ call, outcome: { content: result.content, isError: result.isError } });
				}
				session.answer(results);
				// The round ends once its tools have run, so the console closes it after their rows.
				events.roundEnd?.(round, step);
			}
			if (rounds >= MAX_ROUNDS && !answer)
				answer = "That took more steps than I allow myself in one go. Tell me which part to carry on with.";
		} catch (error) {
			if (input.signal?.aborted) throw error;
			console.error("Assistant turn failed:", error);
			problem = error instanceof ProviderError ? error.message : `Something went wrong talking to ${provider.label}: ${error instanceof Error ? error.message : error}`;
			answer = problem;
		}
		const costUsd = usage.inputTokens || usage.outputTokens ? await spend.record(model, usage) : undefined;
		return {
			text: answer || "Done.",
			problem,
			confirms: effects.confirms,
			cards: [...effects.cards.values()],
			artifacts: effects.artifacts,
			model,
			usage,
			costUsd,
			rounds,
		};
	}

	/** One plain answer without tools or history, for small jobs like reading a reminder request. */
	async quick(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
		const provider = this.deps.settings.provider();
		if (!provider || this.deps.spend.overBudget(this.deps.settings.dailyBudget())) return undefined;
		const session = provider.start({
			system: "Follow the instruction exactly and answer with nothing else.",
			context: turnContext({ channel: "task" }),
			history: [],
			prompt,
			tools: [],
			webSearch: false,
			effort: "low",
			maxTokens: 4_000,
			signal,
		});
		const step = await session.next({});
		await this.deps.spend.record(step.model, step.usage);
		return step.stop === "end" ? step.text.trim() : undefined;
	}
}
