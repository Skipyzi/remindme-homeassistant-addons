/** Adapt the existing chat messages to OpenAI's Responses API. */
export function usesResponses(url: URL): boolean {
	return /\/responses\/?$/.test(url.pathname);
}

export function responsesBody(
	model: string,
	messages: Array<{ role: string; content: unknown }>,
	maxTokens: number,
	stream = false,
	effort = "none",
): Record<string, unknown> {
	if (effort === "none" && /^(gpt-6-astra|gpt-6\.1-sol)(-|$)/.test(model)) effort = "low";
	return {
		model,
		input: messages.map((message) => ({
			role: message.role,
			content: Array.isArray(message.content)
				? message.content.map((part) => {
					if (part.type === "image_url")
						return { type: "input_image", image_url: part.image_url.url };
					if (part.type === "text")
						return { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text };
					throw new Error("Unsupported Responses message content");
				})
				: message.content,
		})),
		max_output_tokens: Math.max(effort === "none" ? 16 : 2048, maxTokens),
		reasoning: { effort },
		stream,
		store: false,
	};
}

export interface ModelResponse {
	status?: string;
	error?: { message?: string };
	incomplete_details?: { reason?: string };
	output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
	usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

export function responseText(data: ModelResponse): string {
	if (data.status === "failed" || data.error)
		throw new Error(data.error?.message || "OpenAI could not complete the response");
	const content = (data.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []);
	const refusal = content.find((part) => part.type === "refusal");
	if (refusal) throw new Error(refusal.refusal || "OpenAI declined this request");
	return content.filter((part) => part.type === "output_text").map((part) => part.text || "").join("");
}

export function responseUsage(data: ModelResponse): Record<string, number> {
	return {
		prompt_tokens: data.usage?.input_tokens || 0,
		completion_tokens: data.usage?.output_tokens || 0,
		reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens || 0,
	};
}

/** Strict Structured Outputs require all object fields, with nullable optionals. */
export function strictDecisionSchema(schema: Record<string, unknown>): Record<string, unknown> {
	function convert(value: unknown): unknown {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const result = { ...value } as Record<string, unknown>;
		if ("const" in result) {
			result.enum = [result.const];
			result.type ??= typeof result.const;
			delete result.const;
		}
		if (result.oneOf) {
			result.anyOf = result.oneOf;
			delete result.oneOf;
		}
		if (Array.isArray(result.anyOf)) result.anyOf = result.anyOf.map(convert);
		if (result.items) result.items = convert(result.items);
		if (result.type === "object" || result.properties) {
			const required = new Set((result.required as string[]) || []);
			const properties = (result.properties || {}) as Record<string, unknown>;
			result.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [
				key, required.has(key) ? convert(child) : { anyOf: [convert(child), { type: "null" }] },
			]));
			result.required = Object.keys(properties);
			result.additionalProperties = false;
		}
		return result;
	}
	// A union is allowed inside a property, but not at the schema root.
	return { type: "object", properties: { decision: convert(schema) }, required: ["decision"], additionalProperties: false };
}

export function unwrapDecision(value: unknown): unknown {
	const decision = value && typeof value === "object" ? (value as { decision?: unknown }).decision : undefined;
	if (!decision || typeof decision !== "object" || Array.isArray(decision)) return undefined;
	// Restore absent optional fields expected by the existing action validator.
	return Object.fromEntries(Object.entries(decision).filter(([, entry]) => entry !== null));
}

/** SSE decoding must preserve UTF-8 characters split across network chunks. */
export async function* modelEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trimEnd();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trimStart();
			if (!data || data === "[DONE]") continue;
			yield JSON.parse(data);
		}
	}
	buffer += decoder.decode();
	if (buffer.startsWith("data:") && buffer.slice(5).trim() && buffer.slice(5).trim() !== "[DONE]")
		yield JSON.parse(buffer.slice(5).trim());
}
