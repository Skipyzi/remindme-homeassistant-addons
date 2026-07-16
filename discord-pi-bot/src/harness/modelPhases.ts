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
}

export type PhaseKind = "thinking" | "tool" | "answer";

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
	thinkingTokens: number,
): PhaseMetrics {
	return {
		inputTokens: usage.prompt_tokens || timings.prompt_n || 0,
		outputTokens: usage.completion_tokens || timings.predicted_n || 0,
		encodeTokensPerSecond: timings.prompt_per_second || 0,
		decodeTokensPerSecond: timings.predicted_per_second || 0,
		firstTokenMs,
		totalMs,
		thinkingTokens,
	};
}
