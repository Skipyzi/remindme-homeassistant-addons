export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface PhaseMetrics {
	inputTokens: number;
	outputTokens: number;
	encodeTokensPerSecond: number;
	decodeTokensPerSecond: number;
	firstTokenMs: number;
	totalMs: number;
	thinkingTokens: number;
	/** Tokens of tool results fed back into context during this phase. */
	toolResultTokens: number;
	/** True when any token count above is a character-length estimate. */
	estimated: boolean;
}

/**
 * Rough token count for when llama.cpp reports no usage block. Averages ~4
 * characters per token for English; never a substitute for /tokenize, so
 * callers must surface `estimated` alongside it.
 */
export function estimateTokens(text: string): number {
	return text ? Math.ceil(text.length / 4) : 0;
}

export type PhaseKind = "thinking" | "tool" | "answer";

export interface ThinkState {
	active: boolean;
}

export function reasoningText(delta: {
	reasoning_content?: string;
	reasoning?: string;
}): string {
	return delta.reasoning_content || delta.reasoning || "";
}

export function stripReasoningTags(content: string): string {
	return content.replace(/<\/?think>/gi, "");
}

export function routeThinkTags(
	content: string,
	state: ThinkState,
): { reasoning: string; answer: string } {
	let remaining = content;
	let reasoning = "";
	let answer = "";
	while (remaining) {
		if (state.active) {
			const end = remaining.indexOf("</think>");
			if (end < 0) {
				reasoning += remaining;
				break;
			}
			reasoning += remaining.slice(0, end);
			remaining = remaining.slice(end + 8);
			state.active = false;
			continue;
		}
		const start = remaining.indexOf("<think>");
		if (start < 0) {
			answer += remaining;
			break;
		}
		answer += remaining.slice(0, start);
		remaining = remaining.slice(start + 7);
		state.active = true;
	}
	return { reasoning, answer };
}

export interface HarnessEvent {
	phaseId: string;
	iteration: number;
	kind: PhaseKind;
	state?: "active" | "complete" | "failed";
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	result?: unknown;
	metrics?: PhaseMetrics;
}

export function createPhaseId(requestId: string, iteration: number): string {
	return `${requestId}:phase:${iteration}`;
}

export function createToolCall(
	id: string,
	name: string,
	argumentsText: string,
): ToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: argumentsText },
	};
}

export function normalizePhaseMetrics(
	usage: Record<string, number>,
	timings: Record<string, number>,
	firstTokenMs: number,
	totalMs: number,
	texts: { answer: string; thinking: string },
): PhaseMetrics {
	const reportedInput = usage.prompt_tokens || timings.prompt_n || 0;
	const reportedOutput = usage.completion_tokens || timings.predicted_n || 0;
	// llama.cpp folds reasoning into completion_tokens, so the thinking share is
	// always derived. Prorate it against the reported total when we have one so
	// the badges sum back to `outputTokens` instead of over-counting.
	const answerEstimate = estimateTokens(texts.answer);
	const thinkingEstimate = estimateTokens(texts.thinking);
	const totalEstimate = answerEstimate + thinkingEstimate;
	const thinkingTokens =
		reportedOutput && totalEstimate
			? Math.round(reportedOutput * (thinkingEstimate / totalEstimate))
			: thinkingEstimate;
	return {
		inputTokens: reportedInput,
		outputTokens: reportedOutput || totalEstimate,
		encodeTokensPerSecond: timings.prompt_per_second || 0,
		decodeTokensPerSecond: timings.predicted_per_second || 0,
		firstTokenMs,
		totalMs,
		thinkingTokens,
		toolResultTokens: 0,
		estimated: !reportedOutput || !reportedInput,
	};
}
