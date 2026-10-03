import { chatgptAuth } from "./chatgptAuth";
import { modelEvents, responseText, type ModelResponse } from "./responses";

// The subscription endpoint supports a smaller request surface than API billing.
const unsupportedFields = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];

export interface AuthenticatedEndpoint {
	url: URL; headers: Record<string, string>; authProvider?: "chatgpt" | "claude";
}

/** Subscription credentials are sent only to the provider's fixed API URL. */
export async function modelFetch(endpoint: AuthenticatedEndpoint, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
	if (!endpoint.authProvider) return fetch(endpoint.url, { method: "POST", headers: endpoint.headers, body: JSON.stringify(body), signal });
	if (endpoint.authProvider !== "chatgpt" || endpoint.url.toString() !== "https://api.openai.com/v1/responses")
		throw new Error("Subscription credentials cannot be used with a custom URL.");
	const request = { ...body, store: false, stream: true };
	for (const field of unsupportedFields) delete (request as Record<string, unknown>)[field];
	if (Array.isArray(body.input)) (request as Record<string, unknown>).input = body.input.map((item) =>
		item && typeof item === "object" && item.role === "system" ? { ...item, role: "developer" } : item);
	const response = await fetch(endpoint.url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await chatgptAuth.accessToken()}` }, body: JSON.stringify(request), signal });
	if (!response.ok || body.stream) return response;
	if (!response.body) throw new Error("ChatGPT returned no response stream");
	// ChatGPT plan usage requires streaming even for short routing decisions.
	const items = new Map<number, NonNullable<ModelResponse["output"]>[number]>();
	const text = new Map<number, string>();
	for await (const event of modelEvents(response.body)) {
		if (event.type === "response.output_item.done") items.set(event.output_index ?? 0, event.item);
		if (event.type === "response.output_text.delta") {
			const index = event.output_index ?? 0;
			text.set(index, (text.get(index) || "") + (event.delta || ""));
		}
		if (event.type === "error" || event.type === "response.failed")
			throw new Error(event.message || event.response?.error?.message || "ChatGPT request failed");
		if (event.type === "response.incomplete") throw new Error("ChatGPT reached the output limit before completing the request");
		if (event.type === "response.completed") {
			const completed = event.response as ModelResponse;
			// Some subscription streams omit output from the terminal event.
			// Preserve completed items, or reconstruct text already received.
			if (!completed.output?.length) completed.output = [...new Set([...items.keys(), ...text.keys()])].sort((a, b) => a - b).map((index) =>
				items.get(index) || { type: "message", content: [{ type: "output_text", text: text.get(index) || "" }] });
			responseText(completed); // Surface refusals and provider errors to callers.
			return Response.json(completed);
		}
	}
	throw new Error("ChatGPT stream ended before completing the response");
}
