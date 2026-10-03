import {
	normalizePhaseMetrics,
	reasoningText,
	routeThinkTags,
	stripReasoningTags,
	type ActiveModelMetadata,
	type PhaseMetrics,
} from "../harness/modelPhases";
import { modelEvents, responsesBody, responseText, responseUsage, strictDecisionSchema, unwrapDecision, usesResponses, type ModelResponse } from "../harness/responses";
import { modelFetch } from "../harness/providerRequests";
import { claudeCompletion } from "../harness/claudeAuth";
import { effortForBudget, type ReasoningEffort } from "../harness/thinkingProfiles";

/** Where a request goes. Mirrors `ResolvedEndpoint` without importing the store. */
export interface ModelEndpoint {
	url: URL;
	model: string;
	headers: Record<string, string>;
	/** A plain OpenAI-style server: no llama.cpp extension fields. */
	openaiCompat: boolean;
	label: string;
	authProvider?: "chatgpt" | "claude";
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: unknown };

/**
 * What a failed request means, in words. llama.cpp's router answers
 * "model ... failed to load" when the model's process died while loading,
 * which on a small host is almost always the kernel reclaiming memory.
 */
export function describeEndpointError(label: string, status: number, body: string): string {
	if (/failed to load/i.test(body))
		return "The chat model couldn't be loaded. The Home Assistant host is most likely out of memory: pick a smaller chat model, lower the llama.cpp add-on's context_size, or stop an add-on you don't need.";
	if (/not found/i.test(body) && status === 400)
		return "The llama.cpp add-on doesn't have that model. Choose a chat model under Models.";
	return `${label} endpoint returned HTTP ${status}: ${body.slice(0, 300)}`;
}

export interface DecideResult {
	value: unknown;
	raw: string;
	metrics: PhaseMetrics;
}

/**
 * One grammar-constrained completion. The schema is compiled to a grammar by
 * llama.cpp, so the model cannot emit anything that fails to parse or names
 * an action that does not exist — the failure mode that made small models
 * unusable with free-form tool calling.
 *
 * Reasoning is off and sampling is greedy: this is a classification with
 * arguments, and the same request should always route the same way.
 */
export async function decide(
	endpoint: ModelEndpoint,
	messages: ChatMessage[],
	schema: Record<string, unknown>,
	options: { maxTokens?: number; model?: ActiveModelMetadata; signal?: AbortSignal } = {},
): Promise<DecideResult> {
	if (endpoint.authProvider === "claude") {
		const result = await claudeCompletion(endpoint.model, messages, { schema: strictDecisionSchema(schema), signal: options.signal, modelMetadata: options.model });
		return { value: unwrapDecision(result.structured ?? parseJsonLoose(result.text)), raw: result.text, metrics: result.metrics };
	}
	const started = Date.now();
	const responses = usesResponses(endpoint.url);
	const body: Record<string, unknown> = responses ? {
		...responsesBody(endpoint.model, messages, options.maxTokens ?? 256),
		text: { format: { type: "json_schema", name: "decision", strict: true, schema: strictDecisionSchema(schema) } },
	} : {
		model: endpoint.model,
		messages,
		stream: false,
		temperature: 0,
		max_tokens: options.maxTokens ?? 256,
		response_format: {
			type: "json_schema",
			json_schema: { name: "decision", schema },
		},
	};
	if (!responses && !endpoint.openaiCompat) {
		body.chat_template_kwargs = { enable_thinking: false };
		/*
		 * Not reasoning_format: "none" — combined with a grammar it fails
		 * sampler setup on llama.cpp (b10015: "Failed to initialize samplers").
		 */
		body.reasoning = "off";
		// Keeps the prompt prefix hot in the KV cache between turns.
		body.cache_prompt = true;
	}
	const response = await modelFetch(endpoint, body, options.signal);
	if (!response.ok)
		throw new Error(describeEndpointError(endpoint.label, response.status, await response.text()));
	const data = (await response.json()) as ModelResponse & {
		choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
		usage?: Record<string, number>;
		timings?: Record<string, number>;
	};
	if (responses && data.status === "incomplete") throw new Error("OpenAI decision exceeded the output limit");
	const raw = stripReasoningTags(
		responses ? responseText(data) : String(data.choices?.[0]?.message?.content ?? ""),
	).trim();
	const elapsed = Date.now() - started;
	return {
		value: responses ? unwrapDecision(parseJsonLoose(raw)) : parseJsonLoose(raw),
		raw,
		metrics: normalizePhaseMetrics(
			responses ? responseUsage(data) : data.usage || {},
			data.timings || {},
			elapsed,
			elapsed,
			{ answer: raw, thinking: "" },
			options.model,
		),
	};
}

/**
 * Parse the decision. With a grammar this is plain JSON.parse; the fallbacks
 * exist for endpoints that accept response_format but ignore it, which answer
 * with fenced or chatty JSON.
 */
export function parseJsonLoose(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced) {
			try {
				return JSON.parse(fenced[1]);
			} catch {
				/* fall through */
			}
		}
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				/* fall through */
			}
		}
		return undefined;
	}
}

export interface StreamOptions {
	maxTokens: number;
	/** Reasoning on/off for local runtimes and streamed summaries. */
	thinking: boolean;
	/** Explicit cloud effort. Older callers can still supply a local token budget. */
	effort?: ReasoningEffort;
	reasoningBudget?: number;
	model?: ActiveModelMetadata;
	signal?: AbortSignal;
}

export interface StreamHandlers {
	answer(text: string): void;
	thinking(text: string): void;
}

export interface StreamResult {
	text: string;
	thinking: string;
	metrics: PhaseMetrics;
}

/**
 * Free-text generation with no tools on offer. The model only ever writes
 * prose (or a document) here — every decision that needed structure was
 * already made by `decide`, so there is nothing for it to call by accident.
 */
export async function streamText(
	endpoint: ModelEndpoint,
	messages: ChatMessage[],
	options: StreamOptions,
	handlers: StreamHandlers,
): Promise<StreamResult> {
	const effort = options.effort ?? effortForBudget(options.thinking, options.reasoningBudget);
	if (endpoint.authProvider === "claude") {
		return claudeCompletion(endpoint.model, messages, { effort, thinking: options.thinking, signal: options.signal, modelMetadata: options.model }, handlers);
	}
	const started = Date.now();
	const responses = usesResponses(endpoint.url);
	const body: Record<string, unknown> = responses ? {
		...responsesBody(endpoint.model, messages, options.maxTokens, true, effort),
	} : {
		model: endpoint.model,
		messages,
		stream: true,
		max_tokens: options.maxTokens,
	};
	if (responses && options.thinking)
		body.reasoning = { ...(body.reasoning as object), summary: "auto" };
	if (!responses && !endpoint.openaiCompat) {
		body.chat_template_kwargs = { enable_thinking: options.thinking };
		body.reasoning_format = options.thinking ? "deepseek" : "none";
		body.reasoning = options.thinking ? "on" : "off";
		if (options.reasoningBudget !== undefined)
			body.reasoning_budget = options.reasoningBudget;
		body.cache_prompt = true;
	}
	const response = await modelFetch(endpoint, body, options.signal);
	if (!response.ok)
		throw new Error(describeEndpointError(endpoint.label, response.status, await response.text()));
	if (!response.body) throw new Error("The endpoint returned no stream");
	let text = "";
	let thinking = "";
	let timings: Record<string, number> = {};
	let usage: Record<string, number> = {};
	let firstTokenAt: number | undefined;
	let finishReason = "";
	const thinkState = { active: false };
	let completed = false;
	for await (let payload of modelEvents(response.body)) {
		if (responses) {
			if (payload.type === "error" || payload.type === "response.failed")
				throw new Error(payload.message || payload.response?.error?.message || "OpenAI stream failed");
			if (payload.type === "response.completed" || payload.type === "response.incomplete") {
				if (payload.type === "response.incomplete" && endpoint.authProvider === "chatgpt")
					throw new Error("ChatGPT reached the output limit before completing the request");
				completed = true;
				usage = responseUsage(payload.response);
				finishReason = payload.type === "response.incomplete" ? "length" : "stop";
				continue;
			}
			if (payload.type === "response.refusal.delta") throw new Error("OpenAI declined this request");
			if (payload.type === "response.output_text.delta")
				payload = { choices: [{ delta: { content: payload.delta } }] };
			else if (payload.type === "response.reasoning_summary_text.delta")
				payload = { choices: [{ delta: { reasoning: payload.delta } }] };
			else continue;
		}
		const choice = payload.choices?.[0];
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		if (payload.timings) timings = { ...timings, ...payload.timings };
		if (payload.usage) usage = { ...usage, ...payload.usage };
		if (choice?.timings) timings = { ...timings, ...choice.timings };
		const delta = choice?.delta;
		if (!delta) continue;
		const explicit = reasoningText(delta);
		const routed = explicit
			? { reasoning: explicit, answer: stripReasoningTags(delta.content || "") }
			: routeThinkTags(delta.content || "", thinkState);
		if (routed.answer) {
			firstTokenAt ??= Date.now();
			text += routed.answer;
			handlers.answer(routed.answer);
		}
		if (routed.reasoning && options.thinking) {
			firstTokenAt ??= Date.now();
			thinking += routed.reasoning;
			handlers.thinking(routed.reasoning);
		}
	}
	if (responses && !completed) throw new Error("OpenAI stream ended before completing the response");
	const elapsed = Date.now() - started;
	return {
		text,
		thinking,
		metrics: {
			...normalizePhaseMetrics(
				usage,
				timings,
				firstTokenAt ? firstTokenAt - started : elapsed,
				elapsed,
				{ answer: text, thinking },
				options.model,
			),
			truncated: finishReason === "length",
			...(responses ? { thinkingTokens: usage.reasoning_tokens || 0 } : {}),
		},
	};
}
