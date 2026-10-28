import OpenAI from "openai";
import {
	ProviderError,
	type Provider,
	type Session,
	type Step,
	type StreamEvents,
	type ToolCall,
	type ToolOutcome,
	type TurnRequest,
} from "./types";

/* Models that reason before answering and take `reasoning.effort`. */
const reasoningModels = /^(o\d|gpt-[5-9])/;

export function openAiError(error: unknown, name: string): unknown {
	if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError)
		return new ProviderError(`${name} rejected the API key.`, "auth");
	if (error instanceof OpenAI.RateLimitError)
		return new ProviderError(`${name} is rate limiting this key, or its credit has run out.`, "rate_limit");
	if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError)
		return new ProviderError(`${name} refused the request: ${error.message}`, "bad_request");
	if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.InternalServerError)
		return new ProviderError(`${name} can't be reached right now.`, "unavailable");
	return error;
}

function parseArguments(text: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text || "{}");
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/**
 * OpenAI through the Responses API. Each round after the first continues the
 * stored response by id, so only the new tool results are sent.
 */
class OpenAiSession implements Session {
	private previousId?: string;
	private input: OpenAI.Responses.ResponseInputItem[];
	private readonly tools: OpenAI.Responses.Tool[];

	constructor(
		private readonly client: OpenAI,
		private readonly model: string,
		private readonly request: TurnRequest,
	) {
		this.tools = request.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: false,
		}));
		if (request.webSearch) this.tools.push({ type: "web_search" });
		const images = request.images || [];
		this.input = [
			...request.history
				.filter((turn) => turn.text.trim())
				.map((turn): OpenAI.Responses.EasyInputMessage => ({ role: turn.role, content: turn.text })),
			{
				role: "user",
				content: images.length
					? [
							{ type: "input_text", text: request.prompt },
							...images.map((image) => ({
								type: "input_image" as const,
								image_url: `data:${image.mediaType};base64,${image.data}`,
								detail: "auto" as const,
							})),
						]
					: request.prompt,
			},
		];
	}

	async next(events: StreamEvents): Promise<Step> {
		const reasoning = reasoningModels.test(this.model);
		let response: OpenAI.Responses.Response | undefined;
		try {
			const stream = await this.client.responses.create(
				{
					model: this.model,
					// Instructions are not carried over from the previous response.
					instructions: [this.request.system, this.request.context].filter(Boolean).join("\n\n"),
					input: this.input,
					previous_response_id: this.previousId,
					tools: this.tools,
					max_output_tokens: this.request.maxTokens,
					store: true,
					stream: true,
					// No reasoning summary: OpenAI refuses it for organisations it hasn't verified.
					...(reasoning ? { reasoning: { effort: this.request.effort } } : {}),
				},
				{ signal: this.request.signal },
			);
			for await (const event of stream) {
				if (event.type === "response.output_text.delta") events.text?.(event.delta);
				else if (event.type === "response.reasoning_summary_text.delta") events.thinking?.(event.delta);
				else if (event.type === "response.completed" || event.type === "response.incomplete")
					response = event.response;
				else if (event.type === "response.failed")
					throw new ProviderError(event.response.error?.message || "OpenAI could not answer.", "unknown");
				else if (event.type === "error")
					throw new ProviderError(event.message || "OpenAI could not answer.", "unknown");
			}
		} catch (error) {
			throw openAiError(error, "OpenAI");
		}
		if (!response) throw new ProviderError("OpenAI ended the answer without a result.", "unknown");
		const cached = response.usage?.input_tokens_details?.cached_tokens || 0;
		const usage = {
			inputTokens: (response.usage?.input_tokens || 0) - cached,
			outputTokens: response.usage?.output_tokens || 0,
			cacheReadTokens: cached,
			cacheWriteTokens: 0,
		};
		let text = "";
		let refused = false;
		const calls: ToolCall[] = [];
		for (const item of response.output) {
			if (item.type === "message")
				for (const part of item.content) {
					if (part.type === "output_text") text += part.text;
					else if (part.type === "refusal") {
						refused = true;
						text += part.refusal;
					}
				}
			else if (item.type === "function_call")
				calls.push({ id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
			else if (item.type === "web_search_call") {
				const action = (item as { action?: { query?: unknown } }).action;
				if (typeof action?.query === "string") events.searched?.(action.query);
			}
		}
		const base = { text, usage, model: response.model || this.model };
		if (refused) return { ...base, calls: [], stop: "refused" };
		if (response.status === "incomplete") return { ...base, calls: [], stop: "max_tokens" };
		if (calls.length) {
			this.previousId = response.id;
			this.input = [];
			return { ...base, calls, stop: "tools" };
		}
		return { ...base, calls: [], stop: "end" };
	}

	answer(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): void {
		this.input = results.map(({ call, outcome }) => ({
			type: "function_call_output",
			call_id: call.id,
			output: outcome.isError ? `Error: ${outcome.content}` : outcome.content || "(no output)",
		}));
	}
}

export class OpenAiProvider implements Provider {
	readonly id = "openai" as const;
	readonly label = "OpenAI";
	readonly nativeWebSearch = true;
	readonly vision = true;
	private readonly client: OpenAI;

	constructor(
		apiKey: string,
		readonly model: string,
		options: { baseURL?: string; fetch?: typeof fetch } = {},
	) {
		this.client = new OpenAI({ apiKey, ...options, maxRetries: 2 });
	}

	start(request: TurnRequest): Session {
		return new OpenAiSession(this.client, this.model, request);
	}

	async listModels(): Promise<string[]> {
		const ids: string[] = [];
		try {
			for await (const model of this.client.models.list()) ids.push(model.id);
		} catch (error) {
			throw openAiError(error, "OpenAI");
		}
		// Only the ones that can chat; the list also holds embeddings, audio and images.
		return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id)).sort();
	}
}
