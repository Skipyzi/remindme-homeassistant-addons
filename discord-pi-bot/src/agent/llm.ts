import {
	normalizePhaseMetrics,
	reasoningText,
	routeThinkTags,
	stripReasoningTags,
	type ActiveModelMetadata,
	type PhaseMetrics,
} from "../harness/modelPhases";

/** Where a request goes. Mirrors `ResolvedEndpoint` without importing the store. */
export interface ModelEndpoint {
	url: URL;
	model: string;
	headers: Record<string, string>;
	/** A plain OpenAI-style server: no llama.cpp extension fields. */
	openaiCompat: boolean;
	label: string;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: unknown };

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
	const started = Date.now();
	const body: Record<string, unknown> = {
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
	if (!endpoint.openaiCompat) {
		body.chat_template_kwargs = { enable_thinking: false };
		/*
		 * Not reasoning_format: "none" — combined with a grammar it fails
		 * sampler setup on llama.cpp (b10015: "Failed to initialize samplers").
		 */
		body.reasoning = "off";
		// Keeps the prompt prefix hot in the KV cache between turns.
		body.cache_prompt = true;
	}
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: endpoint.headers,
		body: JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok)
		throw new Error(
			`${endpoint.label} endpoint returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
		);
	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
		usage?: Record<string, number>;
		timings?: Record<string, number>;
	};
	const raw = stripReasoningTags(
		String(data.choices?.[0]?.message?.content ?? ""),
	).trim();
	const elapsed = Date.now() - started;
	return {
		value: parseJsonLoose(raw),
		raw,
		metrics: normalizePhaseMetrics(
			data.usage || {},
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
	/** Reasoning on/off and its budget; ignored by OpenAI-compatible endpoints. */
	thinking: boolean;
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
	const started = Date.now();
	const body: Record<string, unknown> = {
		model: endpoint.model,
		messages,
		stream: true,
		max_tokens: options.maxTokens,
	};
	if (!endpoint.openaiCompat) {
		body.chat_template_kwargs = { enable_thinking: options.thinking };
		body.reasoning_format = options.thinking ? "deepseek" : "none";
		body.reasoning = options.thinking ? "on" : "off";
		if (options.reasoningBudget !== undefined)
			body.reasoning_budget = options.reasoningBudget;
		body.cache_prompt = true;
	}
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: endpoint.headers,
		body: JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok)
		throw new Error(
			`${endpoint.label} endpoint returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
		);
	if (!response.body) throw new Error("The endpoint returned no stream");
	let buffer = "";
	let text = "";
	let thinking = "";
	let timings: Record<string, number> = {};
	let usage: Record<string, number> = {};
	let firstTokenAt: number | undefined;
	let finishReason = "";
	const thinkState = { active: false };
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += Buffer.from(chunk).toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
			let payload: {
				usage?: Record<string, number>;
				timings?: Record<string, number>;
				choices?: Array<{
					delta?: { content?: string; reasoning_content?: string; reasoning?: string };
					timings?: Record<string, number>;
					finish_reason?: string | null;
				}>;
			};
			try {
				payload = JSON.parse(line.slice(6));
			} catch {
				continue;
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
	}
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
		},
	};
}
