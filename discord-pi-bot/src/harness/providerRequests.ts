import { chatgptAuth } from "./chatgptAuth";
import { modelEvents } from "./responses";

export interface AuthenticatedEndpoint {
	url: URL; headers: Record<string, string>; authProvider?: "chatgpt" | "claude";
}

/** Subscription credentials are sent only to the provider's fixed API URL. */
export async function modelFetch(endpoint: AuthenticatedEndpoint, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
	if (!endpoint.authProvider) return fetch(endpoint.url, { method: "POST", headers: endpoint.headers, body: JSON.stringify(body), signal });
	if (endpoint.authProvider !== "chatgpt" || endpoint.url.toString() !== "https://api.openai.com/v1/responses")
		throw new Error("Subscription credentials cannot be used with a custom URL.");
	const response = await fetch(endpoint.url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await chatgptAuth.accessToken()}` }, body: JSON.stringify({ ...body, store: false, stream: true }), signal });
	if (!response.ok || body.stream) return response;
	if (!response.body) throw new Error("ChatGPT returned no response stream");
	// ChatGPT plan usage requires streaming even for short routing decisions.
	for await (const event of modelEvents(response.body)) {
		if (event.type === "error" || event.type === "response.failed")
			throw new Error(event.message || event.response?.error?.message || "ChatGPT request failed");
		if (event.type === "response.incomplete") throw new Error("ChatGPT reached the output limit before completing the request");
		if (event.type === "response.completed") return Response.json(event.response);
	}
	throw new Error("ChatGPT stream ended before completing the response");
}
