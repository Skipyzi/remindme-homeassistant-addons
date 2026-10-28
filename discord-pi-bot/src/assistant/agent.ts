import { openCapability } from "../agents/bridge";
import { RUN } from "../agents/runners";
import type { RunnerThreads } from "../agents/threads";
import type { AiSettings, Runner } from "../ai/settings";
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
import type { ActivityChannel, ActivityLog, Receipt } from "./activity";
import type { EntityCard } from "../harness/entities";
import type { VaultNote } from "../harness/vault";
import type { Confirmation } from "./confirmations";
import { systemPrompt, turnContext, type Channel } from "./prompt";
import { buildTools, newEffects, runTool, type Effects, type ToolContext, type ToolRun } from "./tools";

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
	/** CLI agents: where their tool bridge listens, and their sessions per conversation. */
	agents?: { bridgeUrl: string; threads: RunnerThreads };
	/** The console's ledger: every answer, change and wait is written here. */
	activity?: ActivityLog;
	/** Context every turn should have, such as jobs waiting for the user's answer. */
	standing?(): string | undefined;
	/** What RemindMe remembers about the user, for every turn's context. */
	memory?(): string | undefined;
	/** After a chat turn: look at what the user said for facts worth remembering. */
	learn?(input: AskInput): void;
}

/* A CLI agent runs its own loop; this caps how many tools one turn may call. */
const MAX_RUNNER_TOOL_CALLS = 24;

export interface AskInput {
	prompt: string;
	channel: Channel;
	history?: PriorTurn[];
	images?: ImageInput[];
	openDocument?: Artifact;
	effort?: Effort;
	/** More context for this turn only, such as the facts for a brief. */
	extra?: string;
	/** Which conversation this turn belongs to, so a CLI agent can resume its session. */
	conversationId?: string;
	/** The console thread this turn runs in, so a job started from it takes it over. */
	threadId?: string;
	/** Tools for this turn only, such as a running job's own. */
	tools?: Partial<ToolContext>;
	signal?: AbortSignal;
}

/* What the tools see of the turn they run in. */
function toolContext(deps: AssistantDeps, input: AskInput): ToolContext {
	return { ...deps.tools(), ...input.tools, turn: { channel: input.channel, prompt: input.prompt, threadId: input.threadId } };
}

/* The turn's own context, what RemindMe remembers about the user, and what every chat should know. */
function extraFor(deps: AssistantDeps, input: AskInput): string | undefined {
	const standing = input.channel === "job" ? undefined : deps.standing?.();
	return [input.extra, deps.memory?.(), standing].filter(Boolean).join("\n\n") || undefined;
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
	/** What the tools changed, for the ledger. */
	did: Receipt[];
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
	return { text: problem, problem, confirms: [], cards: [], artifacts: [], did: [], model, usage: emptyUsage(), rounds: 0 };
}

/**
 * The assistant: one turn is a loop of model calls and tool runs until the
 * model answers in words. Which model answers is whatever the settings say
 * right now; the console, Discord, tasks and the brief all come through here.
 */
export class Assistant {
	/* One CLI agent turn at a time: they share their sign-ins and working folders. */
	private runnerQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: AssistantDeps) {}

	async ask(input: AskInput, events: AskEvents = {}): Promise<AskResult> {
		const result = await this.answer(input, events);
		this.record(input, result);
		if (!result.problem && (input.channel === "console" || input.channel === "discord")) this.deps.learn?.(input);
		return result;
	}

	/*
	 * Into the ledger: what changed, what waits for a tap, and the answer,
	 * a millisecond apart so they list in the order they happened. The
	 * brief is logged when it is sent, so it isn't recorded twice.
	 */
	private record(input: AskInput, result: AskResult): void {
		const activity = this.deps.activity;
		if (!activity || input.channel === "brief") return;
		const channel: ActivityChannel = input.channel;
		// A job's runs aren't answers to anyone; its thread and its messages say what it did.
		const start = Date.now();
		if (result.did.length) activity.add({ kind: "did", channel, text: result.did.map((item) => item.text).join("; "), receipts: result.did, at: new Date(start) });
		for (const confirmation of result.confirms)
			activity.add({ kind: "waiting", channel, text: confirmation.message, token: confirmation.token, at: new Date(start + 1) });
		if (channel === "job") return;
		activity.add({
			kind: result.problem ? "failed" : "answered",
			channel,
			question: input.prompt,
			text: result.text,
			at: new Date(start + 2),
		});
	}

	private async answer(input: AskInput, events: AskEvents): Promise<AskResult> {
		const { settings, spend } = this.deps;
		const runner = settings.runner();
		if (runner) {
			const turn = this.runnerQueue.then(() => this.askRunner(runner, input, events));
			this.runnerQueue = turn.catch(() => {});
			return turn;
		}
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

		const tools = await buildTools(toolContext(this.deps, input), { nativeWebSearch: provider.nativeWebSearch });
		const session = provider.start({
			system: systemPrompt(this.deps.persona()),
			context: turnContext({
				channel: input.channel,
				home: this.deps.home?.(),
				recalled: this.deps.recall?.(input.prompt),
				openDocument: input.openDocument,
				extra: extraFor(this.deps, input),
				servedBy: `${provider.label}, model ${provider.model}`,
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

		const effects: Effects = newEffects();
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
			did: effects.did,
			model,
			usage,
			costUsd,
			rounds,
		};
	}

	/**
	 * A turn on a CLI agent (Claude Code, Codex). The agent runs
	 * its own loop and reaches RemindMe's tools through the bridge; tool rows
	 * and confirmations still come back through the same events. Usage is
	 * billed to the subscription, so nothing is added to the daily spend.
	 */
	private async askRunner(runner: Runner, input: AskInput, events: AskEvents): Promise<AskResult> {
		const agents = this.deps.agents;
		if (!agents) return failure(`${runner.label} isn't available here.`);
		if (input.images?.length) return failure(`${runner.label} can't look at images here. Switch to Claude, OpenAI or ChatGPT to send pictures.`, runner.model);
		const tools = await buildTools(toolContext(this.deps, input), { nativeWebSearch: false });
		const effects: Effects = newEffects();
		const abort = new AbortController();
		const cancel = () => abort.abort();
		input.signal?.addEventListener("abort", cancel, { once: true });
		let calls = 0;
		let answer = "";
		// One way into the tools, whether the agent comes over the bridge (Claude Code)
		// or calls in-process (Codex).
		const call = async (name: string, args: unknown): Promise<ToolRun> => {
			if (++calls > MAX_RUNNER_TOOL_CALLS) {
				abort.abort();
				return { content: "The agent reached the tool-call limit for one turn.", isError: true };
			}
			const toolCall = { id: `${runner.id}-${calls}`, name, input: args && typeof args === "object" ? (args as Record<string, unknown>) : {} };
			events.toolStart?.(toolCall, 0);
			const confirmsBefore = effects.confirms.length;
			const result = await runTool(tools, toolCall, effects);
			events.toolEnd?.(toolCall, result, 0);
			for (const confirmation of effects.confirms.slice(confirmsBefore)) events.confirm?.(confirmation, 0);
			return result;
		};
		const capability = openCapability({ tools: tools.map((tool) => tool.spec), signal: abort.signal, codexNative: runner.nativeAuth, call });
		const conversation = input.conversationId;
		const ephemeral: { id?: string } = {};
		events.roundStart?.(0);
		try {
			await RUN[runner.id]({
				runner: runner.id,
				model: runner.model,
				nativeAuth: runner.nativeAuth,
				system: `${systemPrompt(this.deps.persona())}\n\nNo terminal, files, coding tools or other agents are available: only the tools given here.\n\n${turnContext({
					channel: input.channel,
					home: this.deps.home?.(),
					recalled: this.deps.recall?.(input.prompt),
					openDocument: input.openDocument,
					extra: extraFor(this.deps, input),
					servedBy: `${runner.label}, model ${runner.model}`,
				})}`,
				prompt: input.prompt,
				history: trimHistory(input.history || []),
				effort: input.effort || this.deps.settings.effort(),
				thread: conversation
					? { get: () => agents.threads.get(conversation, runner.id), set: (id) => agents.threads.set(conversation, runner.id, id) }
					: { get: () => ephemeral.id, set: (id) => (ephemeral.id = id) },
				tools: tools.map((tool) => tool.spec),
				call,
				bridge: { url: agents.bridgeUrl, token: capability.token },
				signal: abort.signal,
				delta: (text) => {
					answer += text;
					events.text?.(text, 0);
				},
			});
		} catch (error) {
			if (input.signal?.aborted) throw error;
			console.error(`${runner.label} turn failed:`, error);
			const problem = `${runner.label} couldn't finish: ${error instanceof Error ? error.message : error}`;
			return { ...failure(problem, runner.model), confirms: effects.confirms, cards: [...effects.cards.values()], artifacts: effects.artifacts, did: effects.did };
		} finally {
			capability.close();
			abort.abort();
			input.signal?.removeEventListener("abort", cancel);
		}
		return {
			text: answer.trim() || "Done.",
			confirms: effects.confirms,
			cards: [...effects.cards.values()],
			artifacts: effects.artifacts,
			did: effects.did,
			model: `${runner.label} · ${runner.model}`,
			usage: emptyUsage(),
			rounds: 1,
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
