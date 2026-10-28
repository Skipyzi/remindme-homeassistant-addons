import OpenAI from "openai";
import { openAiError } from "./openai";
import {
	ProviderError,
	type Provider,
	type ProviderId,
	type Session,
	type Step,
	type StreamEvents,
	type ToolCall,
	type ToolOutcome,
	type TurnRequest,
} from "./types";

export const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1";

/* Many models behind these servers cap their output at 8k; more is a 400. */
const MAX_OUTPUT_TOKENS = 8_192;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Thinking text, which compatible servers send under two different names. */
interface ReasoningDelta {
	reasoning_content?: string | null;
	reasoning?: string | null;
}

/**
 * Any server that speaks OpenAI's Chat Completions: OpenCode Go and Zen,
 * OpenRouter, a local server. Tool calls arrive in pieces and are put back
 * together by index.
 */
class CompatibleSession implements Session {
	private readonly messages: ChatMessage[];
	private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];

	constructor(
		private readonly client: OpenAI,
		private readonly model: string,
		private readonly name: string,
		private readonly request: TurnRequest,
	) {
		this.tools = request.tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
		const images = request.images || [];
		this.messages = [
			{ role: "system", content: [request.system, request.context].filter(Boolean).join("\n\n") },
			...request.history
				.filter((turn) => turn.text.trim())
				.map((turn): ChatMessage => ({ role: turn.role, content: turn.text })),
			{
				role: "user",
				content: images.length
					? [
							{ type: "text", text: request.prompt },
							...images.map((image) => ({
								type: "image_url" as const,
								image_url: { url: `data:${image.mediaType};base64,${image.data}` },
							})),
						]
					: request.prompt,
			},
		];
	}

	async next(events: StreamEvents): Promise<Step> {
		let text = "";
		let reasoning = "";
		let finish: string | null = null;
		let model = this.model;
		let usage: OpenAI.Completions.CompletionUsage | undefined;
		const pieces = new Map<number, { id: string; name: string; args: string }>();
		try {
			const stream = await this.client.chat.completions.create(
				{
					model: this.model,
					messages: this.messages,
					...(this.tools.length ? { tools: this.tools } : {}),
					max_tokens: Math.min(this.request.maxTokens, MAX_OUTPUT_TOKENS),
					stream: true,
					stream_options: { include_usage: true },
				},
				{ signal: this.request.signal },
			);
			for await (const chunk of stream) {
				if (chunk.model) model = chunk.model;
				if (chunk.usage) usage = chunk.usage;
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta as typeof choice.delta & ReasoningDelta;
				if (delta.content) {
					text += delta.content;
					events.text?.(delta.content);
				}
				const thought = delta.reasoning_content ?? delta.reasoning;
				if (thought) {
					reasoning += thought;
					events.thinking?.(thought);
				}
				for (const part of delta.tool_calls || []) {
					const entry = pieces.get(part.index) || { id: "", name: "", args: "" };
					if (part.id) entry.id = part.id;
					if (part.function?.name) entry.name += part.function.name;
					if (part.function?.arguments) entry.args += part.function.arguments;
					pieces.set(part.index, entry);
				}
				if (choice.finish_reason) finish = choice.finish_reason;
			}
		} catch (error) {
			throw openAiError(error, this.name);
		}
		const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
		const stepUsage = {
			inputTokens: (usage?.prompt_tokens || 0) - cached,
			outputTokens: usage?.completion_tokens || 0,
			cacheReadTokens: cached,
			cacheWriteTokens: 0,
		};
		const calls: ToolCall[] = [...pieces.entries()]
			.sort(([a], [b]) => a - b)
			.filter(([, entry]) => entry.name)
			.map(([index, entry]) => {
				let input: Record<string, unknown> = {};
				try {
					const parsed = JSON.parse(entry.args || "{}");
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
				} catch {
					input = {};
				}
				return { id: entry.id || `call_${index}`, name: entry.name, input };
			});
		const base = { text, usage: stepUsage, model };
		if (finish === "content_filter") return { ...base, calls: [], stop: "refused" };
		if (finish === "length") return { ...base, calls: [], stop: "max_tokens" };
		if (calls.length) {
			const assistant = {
				role: "assistant" as const,
				content: text || null,
				tool_calls: calls.map((call) => ({
					id: call.id,
					type: "function" as const,
					function: { name: call.name, arguments: JSON.stringify(call.input) },
				})),
				// Reasoning models such as DeepSeek want their thinking back mid-turn.
				...(reasoning ? { reasoning_content: reasoning } : {}),
			};
			this.messages.push(assistant as ChatMessage);
			return { ...base, calls, stop: "tools" };
		}
		return { ...base, calls: [], stop: "end" };
	}

	answer(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): void {
		for (const { call, outcome } of results)
			this.messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: outcome.isError ? `Error: ${outcome.content}` : outcome.content || "(no output)",
			});
	}
}

export class CompatibleProvider implements Provider {
	readonly nativeWebSearch = false;
	/* Not known for an arbitrary model; images are refused rather than failing upstream. */
	readonly vision = false;
	private readonly client: OpenAI;

	constructor(
		readonly id: Extract<ProviderId, "opencode" | "custom">,
		readonly label: string,
		apiKey: string,
		readonly model: string,
		baseURL: string,
		options: { fetch?: typeof fetch } = {},
	) {
		if (!baseURL) throw new ProviderError(`${label} needs a server URL.`, "bad_request");
		this.client = new OpenAI({ apiKey: apiKey || "none", baseURL, ...options, maxRetries: 2 });
	}

	start(request: TurnRequest): Session {
		return new CompatibleSession(this.client, this.model, this.label, request);
	}

	async listModels(): Promise<string[]> {
		const ids: string[] = [];
		try {
			for await (const model of this.client.models.list()) ids.push(model.id);
		} catch (error) {
			throw openAiError(error, this.label);
		}
		return ids.sort();
	}
}
