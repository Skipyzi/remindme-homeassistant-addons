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

/** A ChatGPT sign-in: the subscription's token, fetched fresh for each request. */
export interface Subscription {
	token(): Promise<string>;
	fetch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
}

/**
 * OpenAI through the Responses API. With an API key each round continues the
 * stored response by id, so only the new tool results are sent. A ChatGPT
 * subscription stores nothing, so every round resends the turn so far,
 * reasoning included in its encrypted form.
 */
class OpenAiSession implements Session {
	private previousId?: string;
	private input: OpenAI.Responses.ResponseInputItem[];
	private readonly tools: OpenAI.Responses.Tool[];

	constructor(
		private readonly client: (() => Promise<OpenAI>),
		private readonly model: string,
		private readonly request: TurnRequest,
		private readonly name: string,
		private readonly stateless: boolean,
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
		/* Some subscription streams leave the output out of the final event. */
		const done = new Map<number, OpenAI.Responses.ResponseOutputItem>();
		try {
			const client = await this.client();
			const stream = await client.responses.create(
				{
					model: this.model,
					// Instructions are not carried over from the previous response.
					instructions: [this.request.system, this.request.context].filter(Boolean).join("\n\n"),
					input: this.input,
					tools: this.tools,
					stream: true,
					...(this.stateless
						? { store: false, include: ["reasoning.encrypted_content"] }
						: { store: true, previous_response_id: this.previousId, max_output_tokens: this.request.maxTokens }),
					// No reasoning summary: OpenAI refuses it for organisations it hasn't verified.
					...(reasoning ? { reasoning: { effort: this.request.effort } } : {}),
				},
				{ signal: this.request.signal },
			);
			for await (const event of stream) {
				if (event.type === "response.output_text.delta") events.text?.(event.delta);
				else if (event.type === "response.reasoning_summary_text.delta") events.thinking?.(event.delta);
				else if (event.type === "response.output_item.done") done.set(event.output_index, event.item);
				else if (event.type === "response.completed" || event.type === "response.incomplete")
					response = event.response;
				else if (event.type === "response.failed")
					throw new ProviderError(event.response.error?.message || `${this.name} could not answer.`, "unknown");
				else if (event.type === "error")
					throw new ProviderError(event.message || `${this.name} could not answer.`, "unknown");
			}
		} catch (error) {
			throw openAiError(error, this.name);
		}
		if (!response) throw new ProviderError(`${this.name} ended the answer without a result.`, "unknown");
		if (!response.output?.length && done.size)
			response.output = [...done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
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
			if (this.stateless)
				// Nothing is stored, so ids would point nowhere: send the items without them.
				this.input.push(
					...response.output.map((item) => {
						const { id: _id, ...rest } = item as typeof item & { id?: string };
						return rest as OpenAI.Responses.ResponseInputItem;
					}),
				);
			else {
				this.previousId = response.id;
				this.input = [];
			}
			return { ...base, calls, stop: "tools" };
		}
		return { ...base, calls: [], stop: "end" };
	}

	answer(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): void {
		const outputs = results.map(({ call, outcome }): OpenAI.Responses.ResponseInputItem => ({
			type: "function_call_output",
			call_id: call.id,
			output: outcome.isError ? `Error: ${outcome.content}` : outcome.content || "(no output)",
		}));
		if (this.stateless) this.input.push(...outputs);
		else this.input = outputs;
	}
}

export class OpenAiProvider implements Provider {
	readonly id: "openai" | "chatgpt";
	readonly label: string;
	readonly nativeWebSearch = true;
	readonly vision = true;
	private readonly client?: OpenAI;

	constructor(
		apiKey: string,
		readonly model: string,
		private readonly options: { baseURL?: string; fetch?: typeof fetch; subscription?: Subscription } = {},
	) {
		this.id = options.subscription ? "chatgpt" : "openai";
		this.label = options.subscription ? "ChatGPT" : "OpenAI";
		if (!options.subscription) this.client = new OpenAI({ apiKey, baseURL: options.baseURL, fetch: options.fetch, maxRetries: 2 });
	}

	/* The subscription's requests go through its own fetch, which trims the body to what it accepts. */
	private async connect(): Promise<OpenAI> {
		const subscription = this.options.subscription;
		if (!subscription) return this.client!;
		return new OpenAI({
			apiKey: await subscription.token(),
			baseURL: this.options.baseURL,
			maxRetries: 2,
			fetch: async (url, init) =>
				String(url).endsWith("/responses")
					? subscription.fetch(JSON.parse(String(init?.body || "{}")), init?.signal || undefined)
					: fetch(url, init),
		});
	}

	start(request: TurnRequest): Session {
		return new OpenAiSession(() => this.connect(), this.model, request, this.label, Boolean(this.options.subscription));
	}

	async listModels(): Promise<string[]> {
		const ids: string[] = [];
		try {
			for await (const model of (await this.connect()).models.list()) ids.push(model.id);
		} catch (error) {
			throw openAiError(error, this.label);
		}
		// Only the ones that can chat; the list also holds embeddings, audio and images.
		return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id)).sort();
	}
}
