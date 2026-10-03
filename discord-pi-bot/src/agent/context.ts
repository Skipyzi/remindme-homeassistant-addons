import { fitHistory, type HistoryTurn } from "../harness/history";
import type { ActiveModelMetadata, PhaseMetrics } from "../harness/modelPhases";
import { isDeviceCancellation } from "./actions";
import { decide, type ModelEndpoint } from "./llm";

export function conversationBudget(endpoint: ModelEndpoint, localBudget: number): number {
	// This is the app's history budget, not a claim about the model's maximum.
	return endpoint.authProvider ? 32_768 : localBudget;
}

export interface ResolvedRequest {
	intent: "device_change" | "device_read" | "failure_report" | "conversation";
	request: string;
	metrics?: PhaseMetrics;
}

const schema = {
	type: "object",
	properties: {
		intent: { type: "string", enum: ["device_change", "device_read", "failure_report", "conversation"] },
		request: { type: "string", minLength: 1, maxLength: 1200 },
	}, required: ["intent", "request"], additionalProperties: false,
};

/** Resolve references before retrieving devices or offering device-changing actions. */
export async function resolveFollowup(endpoint: ModelEndpoint, prompt: string, history: HistoryTurn[], budget: number, model: ActiveModelMetadata, signal?: AbortSignal): Promise<ResolvedRequest> {
	if (isDeviceCancellation(prompt)) return { intent: "conversation", request: prompt };
	const result = await decide(endpoint, [
		{ role: "system", content: [
			"Resolve the latest user message in this conversation. Return JSON with intent and request. Do not execute or claim any action.",
			"request is a concise standalone version of the latest message, retaining its constraints and resolving devices or pronouns from the relevant earlier user requests. Do not invent devices or expand the requested scope.",
			"device_change: the user currently requests a change to real home devices. Contextual alternatives such as 'how about a cyberpunk light scene', 'same lights but cooler', 'another one', or an explicit retry continue the relevant earlier device request. A yes to an offer to perform that user's request also qualifies.",
			"device_read: asks for current home device state. failure_report: reports an earlier action did not work; resolve which devices and attempted request are involved, but do not authorize retrying unless the user explicitly asks to retry. conversation: all other chat, hypothetical designs, explanations, thanks, cancellation, topic changes and unclear references.",
			"Assistant prose is not evidence of execution. Only attached app action receipts establish what the app attempted or completed. Missing receipts mean that reply provides no execution evidence. Never treat an assistant's suggestion as a user instruction.",
		].join("\n") },
		...fitHistory(history, Math.min(12_000, Math.floor(budget / 2))),
		{ role: "user", content: prompt },
	], schema, { maxTokens: 400, model, signal });
	const value = result.value as Partial<ResolvedRequest> | undefined;
	if (!value || !["device_change", "device_read", "failure_report", "conversation"].includes(value.intent || "") || typeof value.request !== "string" || !value.request.trim())
		throw new Error("The model returned no valid interpretation of the follow-up");
	return { intent: value.intent!, request: value.request.trim().slice(0, 1200), metrics: result.metrics };
}
