import os from "node:os";
import type { Artifact } from "../harness/artifacts";
import { userContent, type ImageAttachment } from "../harness/attachments";
import { fitHistory, type HistoryTurn } from "../harness/history";
import {
	createPhaseId,
	estimateTokens,
	type ActiveModelMetadata,
	type PhaseMetrics,
} from "../harness/modelPhases";
import { getThinkingProfile, type ThinkingMode } from "../harness/thinkingProfiles";
import type { VaultNote } from "../harness/vault";
import {
	asksToRemember,
	decisionSchema,
	looksLikeCommand,
	validateDecision,
	type ActionContext,
	type Decision,
	type DocumentKind,
	type McpToolRef,
} from "./actions";
import { candidatesForTurn, findCandidates, type Candidate } from "./candidates";
import { conversationBudget, resolveFollowup, type ResolvedRequest } from "./context";
import { execute, type ExecutorDeps } from "./execute";
import { fastPathEligible, readIntentReply } from "./home";
import { decide, streamText, type ChatMessage, type ModelEndpoint } from "./llm";
import {
	SPEAKER_RULES,
	decideMessages,
	documentEditMessages,
	documentWriteMessages,
} from "./prompts";

export type Send = (event: string, data: unknown) => void;

export interface TurnDeps extends ExecutorDeps {
	endpoint(): ModelEndpoint;
	activeModel(): Promise<ActiveModelMetadata>;
	contextSize: number;
	/** Persona plus skills: the editable voice of every spoken answer. */
	systemPrompt(): string;
	recall?(prompt: string): VaultNote[];
	mcpTools?(): Promise<McpToolRef[]>;
	artifacts?: {
		get(id: string): Artifact | undefined;
		create(values: Partial<Artifact>): Promise<Artifact>;
		update(id: string, values: Partial<Artifact>): Promise<Artifact | undefined>;
	};
	features: { reminders: boolean; parcels: boolean };
}

export interface TurnInput {
	prompt: string;
	thinkingMode: ThinkingMode;
	requestId: string;
	attachments?: ImageAttachment[];
	history?: HistoryTurn[];
	openArtifactId?: string;
	signal?: AbortSignal;
}

/* Headroom for the chat template's own framing on top of the counted parts. */
const CONTEXT_SAFETY_MARGIN = 512;
const IMAGE_TOKEN_ALLOWANCE = 1024;

/**
 * One chat turn, in four steps, each of which can end it:
 *
 *   1. Home Assistant's own intent engine, for plain device commands.
 *   2. One grammar-constrained decision: which single action, with what.
 *   3. The action, carried out in code.
 *   4. A spoken answer — only when there is something to put into words.
 *
 * The model never sees a tool list and never emits a tool call. It fills in
 * a form whose every field is checked, and when it talks it has nothing to
 * call — which is what made small models reliable here.
 */
export async function runTurn(input: TurnInput, deps: TurnDeps, send: Send): Promise<void> {
	const history = input.history || [];
	const attachments = input.attachments || [];
	const model = await deps.activeModel();
	const endpoint = deps.endpoint();
	const contextSize = conversationBudget(endpoint, deps.contextSize);
	const openArtifact = input.openArtifactId ? deps.artifacts?.get(input.openArtifactId) : undefined;

	/* 1 ── Home Assistant fast path ─────────────────────────────────── */
	if (deps.home && !attachments.length && !openArtifact && !(endpoint.authProvider && history.length) && fastPathEligible(input.prompt)) {
		const phaseId = createPhaseId(input.requestId, 0);
		try {
			const outcome = readIntentReply(await deps.home.converse(input.prompt, input.signal));
			if (outcome) {
				send("phase_start", { phaseId, iteration: 0, kind: "tool", state: "active" });
				send("tool_start", { phaseId, iteration: 0, kind: "tool", state: "active", name: "home_assistant", arguments: { text: input.prompt } });
				send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "complete", name: "home_assistant", result: { handled_by: "Home Assistant", kind: outcome.kind, speech: outcome.speech, entities: outcome.entityIds } });
				const cards = (
					await Promise.all(outcome.entityIds.map((id) => deps.home!.card(id)))
				).filter(Boolean);
				finishWithAnswer(send, phaseId, 0, outcome.speech, cards);
				return;
			}
		} catch (error) {
			// Not handled, or Home Assistant is slow: the model path takes over.
			if (input.signal?.aborted) throw error;
		}
	}

	/* 2 ── Decide ───────────────────────────────────────────────────── */
	const decidePhase = createPhaseId(input.requestId, 0);
	if (!attachments.length) send("phase_start", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "active" });
	let resolved: ResolvedRequest | undefined;
	if (endpoint.authProvider && deps.home && history.length && !attachments.length && !openArtifact) {
		try {
			resolved = await resolveFollowup(endpoint, input.prompt, history, contextSize, model, input.signal);
		} catch (error) {
			if (input.signal?.aborted) throw error;
			console.warn("Follow-up interpretation failed:", error instanceof Error ? error.message : error);
			send("phase_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "failed" });
			finishWithAnswer(send, createPhaseId(input.requestId, 1), 1, "I couldn't resolve that follow-up reliably. Please restate what you'd like me to do. No device changes were made.");
			return;
		}
	}
	const routingPrompt = resolved?.request || input.prompt;
	let candidates: Candidate[] = [];
	if (deps.home) {
		try {
			const cards = await deps.home.cards();
			// The semantic request already resolves references. Merging the
			// previous generic "light scene" would add unrelated lights again.
			candidates = resolved ? findCandidates(cards, routingPrompt) : candidatesForTurn(cards, routingPrompt, history);
		} catch (error) {
			console.warn("Entity lookup failed:", error instanceof Error ? error.message : error);
		}
	}
	let mcpTools: McpToolRef[] = [];
	if (deps.mcpTools) {
		try {
			mcpTools = await deps.mcpTools();
		} catch {
			mcpTools = [];
		}
	}
	const context: ActionContext = {
		home: Boolean(deps.home),
		homeControl: Boolean(deps.home) && (resolved ? resolved.intent === "device_change" : looksLikeCommand(input.prompt, history)),
		candidates,
		reminders: deps.features.reminders,
		web: Boolean(deps.webSearch),
		memory: Boolean(deps.vault),
		memoryWrite: Boolean(deps.vault) && asksToRemember(input.prompt),
		parcels: deps.features.parcels && Boolean(deps.parcels),
		documents: Boolean(deps.artifacts),
		openDocument: openArtifact
			? { id: openArtifact.id, title: openArtifact.title, kind: openArtifact.kind }
			: undefined,
		mcpTools,
	};
	let decision: Decision = { action: "reply" };
	let decideMetrics: PhaseMetrics | undefined;
	/*
	 * An image is a question about the image; routing it through the
	 * text-only decision would only lose it.
	 */
	if (!attachments.length && !(resolved?.intent === "failure_report" && candidates.length)) {
		const messages = decideMessages(context, { prompt: routingPrompt, candidates, history, historyBudget: endpoint.authProvider ? Math.min(12_000, Math.floor(contextSize / 2)) : undefined });
		const attempt = async (includeMcp: boolean) =>
			decide(endpoint, messages, decisionSchema(context, { includeMcp }), {
				maxTokens: context.homeControl ? 400 : 200,
				model,
				signal: input.signal,
			});
		try {
			let result;
			try {
				result = await attempt(true);
			} catch (error) {
				// An MCP schema the grammar compiler rejects must not cost the turn.
				if (!mcpTools.length || input.signal?.aborted) throw error;
				console.warn("Decision with MCP tools failed; retrying without:", error);
				result = await attempt(false);
			}
			decision = validateDecision(result.value, context);
			decideMetrics = result.metrics;
			if (resolved?.metrics) decideMetrics = { ...decideMetrics,
				inputTokens: decideMetrics.inputTokens + resolved.metrics.inputTokens,
				outputTokens: decideMetrics.outputTokens + resolved.metrics.outputTokens,
				totalMs: decideMetrics.totalMs + resolved.metrics.totalMs,
				firstTokenMs: resolved.metrics.firstTokenMs,
			};
		} catch (error) {
			if (input.signal?.aborted) throw error;
			// A decision that cannot be made degrades to plain conversation.
			console.warn("Decision failed; answering directly:", error instanceof Error ? error.message : error);
		}
	}
	if (resolved?.intent === "failure_report" && candidates.length) {
		// A failure report must inspect real state, rather than ask the model
		// to guess whether reading it would be useful or silently retry a change.
		decision = { action: "home_status", targets: candidates.slice(0, 8).map(({ label }) => label) };
		decideMetrics = resolved.metrics;
	}
	if (resolved?.intent === "device_change" && decision.action === "reply") {
		send("phase_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "complete", metrics: decideMetrics });
		finishWithAnswer(send, createPhaseId(input.requestId, 1), 1, "I couldn't produce a valid device action for that request, so no devices were changed. Please clarify the devices or settings you want.");
		return;
	}

	/* 3 ── Act ──────────────────────────────────────────────────────── */
	let facts = "";
	let cards: unknown[] = [];
	if (decision.action === "document_write" || decision.action === "document_edit") {
		await writeDocument(decision, input, deps, send, decidePhase, openArtifact, model);
		send("phase_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "complete", metrics: decideMetrics });
		return;
	}
	if (decision.action !== "reply") {
		const { action, ...args } = decision;
		send("tool_start", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "active", name: action, arguments: args, metrics: decideMetrics });
		let outcome;
		try {
			outcome = await execute(decision, candidates, deps);
		} catch (error) {
			const message = error instanceof Error ? error.message : "The action failed";
			outcome = { result: { error: message }, answer: `That didn't work: ${message}` };
		}
		const resultTokens = estimateTokens(JSON.stringify(outcome.result ?? ""));
		if (resolved?.intent === "failure_report" && decision.action === "home_status") {
			outcome.facts = `Current device state (read only):\n${JSON.stringify(outcome.result)}\nThe user reports an earlier request did not work. Compare these readings with prior app action receipts and requested settings. A successful service receipt only means Home Assistant accepted the call; it does not prove the physical light changed. Report mismatches or uncertainty instead of concluding it succeeded merely because a receipt exists. Do not invent a cause or retry the change.`;
			outcome.answer = undefined;
		}
		send("tool_complete", {
			phaseId: decidePhase,
			iteration: 0,
			kind: "tool",
			state: "complete",
			name: action,
			result: outcome.result,
			view: outcome.view,
			metrics: { ...decideMetrics, toolResultTokens: resultTokens },
		});
		for (const { label, confirm } of outcome.confirms || []) {
			const name = `${action} · ${label}`;
			send("tool_start", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "active", name, arguments: {} });
			send("tool_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "complete", name, result: confirm });
		}
		send("phase_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "complete", metrics: { ...decideMetrics, toolResultTokens: resultTokens } });
		cards = outcome.cards || [];
		if (outcome.answer !== undefined) {
			finishWithAnswer(send, createPhaseId(input.requestId, 1), 1, outcome.answer, cards);
			return;
		}
		facts = outcome.facts ? `[${action} results]\n${outcome.facts}` : "";
	} else if (decideMetrics) {
		send("phase_complete", { phaseId: decidePhase, iteration: 0, kind: "tool", state: "complete", metrics: decideMetrics });
	}

	/* 4 ── Speak ────────────────────────────────────────────────────── */
	await speak(input, deps, send, model, facts, cards, endpoint, contextSize, decision.action);
}

function finishWithAnswer(
	send: Send,
	phaseId: string,
	iteration: number,
	text: string,
	cards: unknown[] = [],
) {
	send("phase_start", { phaseId, iteration, kind: "answer", state: "active" });
	send("answer_delta", { phaseId, iteration, kind: "answer", text });
	send("answer", { phaseId, iteration, text, cards });
	send("phase_complete", { phaseId, iteration, kind: "answer", state: "complete" });
}

function speakerSystemPrompt(deps: TurnDeps, prompt: string): string {
	const recalled = deps.recall?.(prompt) || [];
	const memory = recalled.length
		? "\n\nFrom your long-term memory (the user's notes). Treat as things you already know:\n" +
			recalled
				.map((note) => `- ${note.title}: ${note.body.replace(/\s+/g, " ").trim().slice(0, 160)}`)
				.join("\n")
		: "";
	return deps.systemPrompt() + SPEAKER_RULES + memory;
}

async function speak(
	input: TurnInput,
	deps: TurnDeps,
	send: Send,
	model: ActiveModelMetadata,
	facts: string,
	cards: unknown[],
	endpoint: ModelEndpoint,
	contextSize: number,
	action: Decision["action"],
): Promise<void> {
	const profile = getThinkingProfile(input.thinkingMode, os.totalmem(), contextSize, endpoint);
	const thinking = profile.id !== "none";
	/*
	 * Results go before the question and the instruction into the system
	 * prompt: small models continue whatever came last, so the last line
	 * they read has to be the thing they are answering.
	 */
	const systemPrompt =
		speakerSystemPrompt(deps, input.prompt) +
		`\nCurrent app execution: selected action ${action}. ${action === "mcp" ? "An external tool ran; only its supplied results establish its effects." : "No device-changing action was executed in this turn."} Prior assistant prose is not execution evidence; use only app action receipts and current device readings. If a previous reply claimed to change something without an app receipt, say that no execution result supports that claim. Do not invent missing buttons, confirmation requirements or app failures. Do not discuss this execution note during ordinary conversation.` +
		(facts ? " Answer the user's question from the results given with it. Link web sources you rely on." : "");
	const userText = facts ? `${facts}\n\nQuestion: ${input.prompt}` : input.prompt;
	const attachments = input.attachments || [];
	const reserved =
		estimateTokens(systemPrompt) +
		estimateTokens(userText) +
		attachments.length * IMAGE_TOKEN_ALLOWANCE +
		profile.maxTokens +
		CONTEXT_SAFETY_MARGIN;
	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		...fitHistory(input.history || [], Math.max(0, contextSize - reserved)),
		{ role: "user", content: userContent(userText, attachments) },
	];
	const phaseId = createPhaseId(input.requestId, 1);
	send("phase_start", { phaseId, iteration: 1, kind: thinking ? "thinking" : "answer", state: "active" });
	const result = await streamText(
		endpoint,
		messages,
		{
			maxTokens: profile.maxTokens,
			thinking,
			reasoningBudget: profile.reasoningBudget,
			effort: profile.id,
			model,
			signal: input.signal,
		},
		{
			answer: (text) => send("answer_delta", { phaseId, iteration: 1, kind: "answer", text }),
			thinking: (text) => send("thinking_delta", { phaseId, iteration: 1, kind: "thinking", text }),
		},
	);
	send("phase_metrics", { phaseId, iteration: 1, kind: "answer", metrics: result.metrics });
	send("answer", { phaseId, iteration: 1, text: result.text, cards });
	send("phase_complete", { phaseId, iteration: 1, kind: "answer", state: "complete", metrics: result.metrics });
}

/**
 * Removes a Markdown fence the model wraps a document in, as it streams.
 * The opening line is held back until it is known whether it is a fence; the
 * closing fence is dropped at the end.
 */
export class FenceStripper {
	private head = "";
	private started = false;
	private tail = "";

	push(text: string): string {
		if (!this.started) {
			this.head += text;
			const newline = this.head.indexOf("\n");
			if (newline < 0 && this.head.length < 40) return "";
			this.started = true;
			const first = newline < 0 ? this.head : this.head.slice(0, newline);
			const rest = /^\s*```/.test(first) ? this.head.slice(newline + 1) : this.head;
			this.head = "";
			return this.hold(rest);
		}
		return this.hold(text);
	}

	/* Keep the last few characters back: they may be the closing fence. */
	private hold(text: string): string {
		const combined = this.tail + text;
		const keep = Math.min(combined.length, 8);
		this.tail = combined.slice(combined.length - keep);
		return combined.slice(0, combined.length - keep);
	}

	end(): string {
		const rest = (this.started ? "" : this.head) + this.tail;
		this.tail = "";
		this.head = "";
		return rest.replace(/\n?```\s*$/, "");
	}
}

export function stripFences(text: string): string {
	return text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "");
}

async function writeDocument(
	decision: Extract<Decision, { action: "document_write" | "document_edit" }>,
	input: TurnInput,
	deps: TurnDeps,
	send: Send,
	phaseId: string,
	openArtifact: Artifact | undefined,
	model: ActiveModelMetadata,
): Promise<void> {
	const artifacts = deps.artifacts!;
	const editing = decision.action === "document_edit" && openArtifact;
	const kind = (editing ? openArtifact.kind : (decision as { kind: DocumentKind }).kind) as DocumentKind;
	const title = editing ? openArtifact.title : (decision as { title: string }).title;
	const { action, ...args } = decision;
	send("tool_start", { phaseId, iteration: 0, kind: "tool", state: "active", name: action, arguments: args });
	const draftId = `draft-${input.requestId}`;
	send("artifact_draft", { id: draftId, title, kind });
	const messages = editing
		? documentEditMessages(kind, openArtifact.content, (decision as { instruction: string }).instruction)
		: documentWriteMessages(kind, title, input.prompt);
	const stripper = new FenceStripper();
	// Documents need room: most of the window, less what the prompt took.
	const maxTokens = Math.max(
		1024,
		deps.contextSize - estimateTokens(JSON.stringify(messages)) - CONTEXT_SAFETY_MARGIN,
	);
	const result = await streamText(
		deps.endpoint(),
		messages,
		{ maxTokens, thinking: false, model, signal: input.signal },
		{
			answer: (text) => {
				const clean = stripper.push(text);
				if (clean) send("artifact_delta", { id: draftId, text: clean });
			},
			thinking: () => {},
		},
	);
	const rest = stripper.end();
	if (rest) send("artifact_delta", { id: draftId, text: rest });
	const content = stripFences(result.text).trim();
	if (!content) {
		send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "complete", name: action, result: { error: "The model wrote nothing" } });
		finishWithAnswer(send, createPhaseId(input.requestId, 1), 1, "The model didn't produce a document. Try again, or rephrase the request.");
		return;
	}
	const saved = editing
		? await artifacts.update(openArtifact.id, { content })
		: await artifacts.create({ title, kind, content });
	send("tool_complete", {
		phaseId,
		iteration: 0,
		kind: "tool",
		state: "complete",
		name: action,
		result: { saved: true, id: saved?.id, title, kind, truncated: result.metrics.truncated || undefined },
		view: saved ? { artifact: { ...saved, content: undefined } } : undefined,
		metrics: result.metrics,
	});
	const note = result.metrics.truncated ? " It hit the length limit, so the end may be cut off." : "";
	finishWithAnswer(
		send,
		createPhaseId(input.requestId, 1),
		1,
		`${editing ? "Updated" : "Wrote"} **${title}**.${note}`,
	);
}
