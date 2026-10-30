/**
 * The provider-neutral shape of one assistant turn. Claude and OpenAI (by
 * API key or the ChatGPT sign-in) each translate this into their own API;
 * the agent above them only ever sees these types.
 */

export type ProviderId = "claude" | "openai" | "chatgpt";

export type Effort = "low" | "medium" | "high";

export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema of the input object. */
	parameters: Record<string, unknown>;
}

export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolOutcome {
	/** What the model reads back. Plain text or JSON text. */
	content: string;
	isError?: boolean;
}

export interface ImageInput {
	mediaType: "image/jpeg" | "image/png" | "image/webp";
	/** Base64 without the data: prefix. */
	data: string;
}

export interface PriorTurn {
	role: "user" | "assistant";
	text: string;
	/** When it was sent (ISO), so "in 90 minutes" in an old message counts from then. */
	at?: string;
	/** What the tools did in that answer: "Reminder for tomorrow at 00:56 (Fri 30 Oct): …". */
	did?: string[];
}

export interface TurnRequest {
	/** Standing instructions: the same on every turn, so providers can cache them. */
	system: string;
	/** What changes per turn: the time, recalled notes, the open document. */
	context: string;
	/** Earlier turns, as plain text. */
	history: PriorTurn[];
	prompt: string;
	images?: ImageInput[];
	tools: ToolSpec[];
	/** Let the provider search the web itself, where it can. */
	webSearch: boolean;
	effort: Effort;
	maxTokens: number;
	signal?: AbortSignal;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: Usage, more: Usage): Usage {
	return {
		inputTokens: total.inputTokens + more.inputTokens,
		outputTokens: total.outputTokens + more.outputTokens,
		cacheReadTokens: total.cacheReadTokens + more.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + more.cacheWriteTokens,
	};
}

export interface StreamEvents {
	text?(delta: string): void;
	thinking?(delta: string): void;
	/** The provider searched the web on its own (Claude, OpenAI). */
	searched?(query: string): void;
}

/** One model call: what it said, and which tools it wants run. */
export interface Step {
	text: string;
	calls: ToolCall[];
	stop: "end" | "tools" | "refused" | "max_tokens";
	usage: Usage;
	/** The model that actually answered (a refusal fallback can change it). */
	model: string;
}

/**
 * A conversation in a provider's own format. `next` makes one model call;
 * `answer` hands the tool results back. Both only ever append, so the
 * provider's cache and Claude's thinking blocks stay valid for the turn.
 */
export interface Session {
	next(events: StreamEvents): Promise<Step>;
	answer(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): void;
}

export interface Provider {
	id: ProviderId;
	/** Shown in the console: "Claude", "OpenAI", "ChatGPT subscription". */
	label: string;
	model: string;
	/** The provider runs web search itself; no client-side search tool needed. */
	nativeWebSearch: boolean;
	vision: boolean;
	start(request: TurnRequest): Session;
	listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly kind: "auth" | "rate_limit" | "unavailable" | "bad_request" | "unknown",
	) {
		super(message);
	}
}
