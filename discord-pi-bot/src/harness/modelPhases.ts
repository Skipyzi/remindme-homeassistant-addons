export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ActiveModelMetadata {
	modelId?: string;
	modelName?: string;
}

export interface PhaseMetrics {
	inputTokens: number;
	outputTokens: number;
	encodeTokensPerSecond: number;
	decodeTokensPerSecond: number;
	firstTokenMs: number;
	totalMs: number;
	thinkingTokens: number;
	modelId?: string;
	modelName?: string;
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
	thinkingTokens: number,
	model: ActiveModelMetadata = {},
): PhaseMetrics {
	return {
		inputTokens: usage.prompt_tokens || timings.prompt_n || 0,
		outputTokens: usage.completion_tokens || timings.predicted_n || 0,
		encodeTokensPerSecond: timings.prompt_per_second || 0,
		decodeTokensPerSecond: timings.predicted_per_second || 0,
		firstTokenMs,
		totalMs,
		thinkingTokens,
		modelId: model.modelId,
		modelName: model.modelName,
	};
}
