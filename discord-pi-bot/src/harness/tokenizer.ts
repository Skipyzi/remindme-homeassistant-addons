export interface TokenUsage {
	promptTokens: number;
	contextTokens: number;
	contextCapacity: number;
	remainingTokens: number;
	exact: boolean;
}

export function tokenizerUrl(completionsUrl: URL): URL {
	try {
		const result = new URL(completionsUrl.toString());
		result.pathname = result.pathname.replace(/\/v1\/chat\/completions\/?$/, "/tokenize");
		return result;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid llama.cpp completion URL: ${detail}`);
	}
}

export async function tokenizeText(url: URL, content: string): Promise<number> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content, add_special: false }),
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`Tokenizer returned HTTP ${response.status}`);
	const payload = (await response.json()) as { tokens?: unknown[] };
	if (!Array.isArray(payload.tokens)) throw new Error("Tokenizer returned no tokens");
	return payload.tokens.length;
}

export async function measureTokenUsage(
	url: URL,
	prompt: string,
	messages: Array<{ role?: string; content?: string }>,
	contextCapacity: number,
): Promise<TokenUsage> {
	const contextText = messages.map((message) => `${message.role || "user"}: ${message.content || ""}`).join("\n");
	const [promptTokens, contextTokens] = await Promise.all([
		tokenizeText(url, prompt),
		tokenizeText(url, contextText),
	]);
	return {
		promptTokens,
		contextTokens,
		contextCapacity,
		remainingTokens: Math.max(0, contextCapacity - contextTokens - promptTokens),
		exact: true,
	};
}
