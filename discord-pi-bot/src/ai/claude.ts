import Anthropic from "@anthropic-ai/sdk";
import {
	ProviderError,
	type Provider,
	type Session,
	type Step,
	type StreamEvents,
	type ToolCall,
	type ToolOutcome,
	type TurnRequest,
	type Usage,
} from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/* Models that take adaptive thinking and `output_config.effort`. */
const adaptiveModels = /^claude-(opus-4-[6-9]|sonnet-4-6|opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/;

/*
 * Models with a server-side refusal fallback: a request a safety classifier
 * declines by mistake is re-run on another model instead of failing.
 * Haiku 5.5 has none.
 */
const fallbackModels = /^claude-(opus-5(-5)?|sonnet-5-5|fable-5(-1)?)$/;

/* Web search with dynamic filtering; other models take the basic version. */
const filteredSearchModels = /^claude-(opus-4-[6-9]|sonnet-4-6|opus-5|sonnet-5|fable-5|mythos-5)/;

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

function providerError(error: unknown): unknown {
	if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
		return new ProviderError("Claude rejected the API key.", "auth");
	if (error instanceof Anthropic.RateLimitError)
		return new ProviderError("Claude is rate limiting this key. Try again in a minute.", "rate_limit");
	if (error instanceof Anthropic.BadRequestError)
		return new ProviderError(`Claude refused the request: ${error.message}`, "bad_request");
	if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError)
		return new ProviderError("Claude can't be reached right now.", "unavailable");
	return error;
}

class ClaudeSession implements Session {
	private readonly messages: MessageParam[];
	private readonly params: Omit<Anthropic.Beta.MessageCreateParamsStreaming, "messages" | "stream">;

	constructor(
		private readonly client: Anthropic,
		private readonly model: string,
		private readonly request: TurnRequest,
	) {
		const adaptive = adaptiveModels.test(model);
		const system: Anthropic.Beta.BetaTextBlockParam[] = [
			// The standing instructions and the tools before them are the cached prefix.
			{ type: "text", text: request.system, cache_control: { type: "ephemeral" } },
		];
		if (request.context.trim()) system.push({ type: "text", text: request.context });
		const tools: Anthropic.Beta.BetaToolUnion[] = request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
			eager_input_streaming: true,
		}));
		if (request.webSearch)
			tools.push(
				filteredSearchModels.test(model)
					? { type: "web_search_20260209", name: "web_search", max_uses: 5 }
					: { type: "web_search_20250305", name: "web_search", max_uses: 5 },
			);
		const fallback = fallbackModels.test(model);
		this.params = {
			model,
			max_tokens: request.maxTokens,
			system,
			tools,
			// Also cache the growing conversation, so each tool round re-reads it cheaply.
			cache_control: { type: "ephemeral" },
			...(adaptive
				? {
						thinking: { type: "adaptive", display: "summarized" },
						output_config: { effort: request.effort },
					}
				: {}),
			...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
		};
		this.messages = [];
		const history = request.history.filter((turn) => turn.text.trim());
		if (history[0]?.role === "assistant")
			this.messages.push({ role: "user", content: "(Earlier in this chat.)" });
		for (const turn of history) this.messages.push({ role: turn.role, content: turn.text });
		const images = (request.images || []).map(
			(image): Anthropic.Beta.BetaImageBlockParam => ({
				type: "image",
				source: { type: "base64", media_type: image.mediaType, data: image.data },
			}),
		);
		this.messages.push({
			role: "user",
			content: images.length ? [...images, { type: "text", text: request.prompt }] : request.prompt,
		});
	}

	private async call(events: StreamEvents): Promise<Message> {
		for (let attempt = 0; ; attempt++) {
			const stream = this.client.beta.messages.stream(
				{ ...this.params, messages: this.messages },
				{ signal: this.request.signal },
			);
			stream.on("text", (delta) => events.text?.(delta));
			stream.on("thinking", (delta) => events.thinking?.(delta));
			try {
				return await stream.finalMessage();
			} catch (error) {
				// Eager tool input that never became valid JSON: re-issue the
				// round, at most twice. Anything from the API itself is final.
				if (error instanceof Anthropic.APIError || this.request.signal?.aborted || attempt >= 2)
					throw providerError(error);
			}
		}
	}

	async next(events: StreamEvents): Promise<Step> {
		const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		let message: Message;
		// A long server-side web search can pause the turn; sending it back resumes it.
		for (let pauses = 0; ; pauses++) {
			message = await this.call(events);
			usage.inputTokens += message.usage.input_tokens;
			usage.outputTokens += message.usage.output_tokens;
			usage.cacheReadTokens += message.usage.cache_read_input_tokens || 0;
			usage.cacheWriteTokens += message.usage.cache_creation_input_tokens || 0;
			const searches = message.usage.server_tool_use?.web_search_requests || 0;
			if (searches) usage.webSearches = (usage.webSearches || 0) + searches;
			for (const block of message.content)
				if (block.type === "server_tool_use" && block.name === "web_search")
					events.searched?.(String((block.input as { query?: unknown })?.query || ""));
			if (message.stop_reason !== "pause_turn" || pauses >= 3) break;
			this.messages.push({ role: "assistant", content: message.content });
		}
		const text = message.content
			.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
			.map((block) => block.text)
			.join("");
		const calls: ToolCall[] = message.content
			.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
			.map((block) => ({
				id: block.id,
				name: block.name,
				input: block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {},
			}));
		const base = { text, usage, model: message.model || this.model };
		if (message.stop_reason === "refusal") return { ...base, calls: [], stop: "refused" };
		// A tool input cut off at the limit can still parse; never run it.
		if (message.stop_reason === "max_tokens") return { ...base, calls: [], stop: "max_tokens" };
		if (calls.length) {
			// Appended unchanged, thinking blocks included: the next round must
			// see exactly what this one produced.
			this.messages.push({ role: "assistant", content: message.content });
			return { ...base, calls, stop: "tools" };
		}
		return { ...base, calls: [], stop: "end" };
	}

	answer(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): void {
		this.messages.push({
			role: "user",
			content: results.map(({ call, outcome }) => ({
				type: "tool_result",
				tool_use_id: call.id,
				content: outcome.content || "(no output)",
				...(outcome.isError ? { is_error: true } : {}),
			})),
		});
	}
}

export class ClaudeProvider implements Provider {
	readonly id = "claude" as const;
	readonly label = "Claude";
	readonly nativeWebSearch = true;
	readonly vision = true;
	private readonly client: Anthropic;

	constructor(
		apiKey: string,
		readonly model = DEFAULT_CLAUDE_MODEL,
		options: { baseURL?: string; fetch?: typeof fetch } = {},
	) {
		this.client = new Anthropic({ apiKey, ...options, maxRetries: 2 });
	}

	start(request: TurnRequest): Session {
		return new ClaudeSession(this.client, this.model, request);
	}

	async listModels(): Promise<string[]> {
		const ids: string[] = [];
		try {
			for await (const model of this.client.models.list()) ids.push(model.id);
		} catch (error) {
			throw providerError(error);
		}
		return ids;
	}
}
