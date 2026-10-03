import { config } from "./config";
import { EndpointStore } from "./harness/endpoints";
import { responsesBody, responseText, usesResponses, type ModelResponse } from "./harness/responses";
import { modelFetch } from "./harness/providerRequests";
import { claudeCompletion } from "./harness/claudeAuth";

/*
 * The bot process shares the console's endpoint list through the same file,
 * so a reminder parsed at 3am uses whatever endpoint the console is pointed
 * at. Loaded lazily and re-read each call: the console may have switched
 * endpoints since the bot started, and this is called rarely enough that a
 * file read per call costs nothing.
 */
const endpoints = new EndpointStore();

export async function askLocalLlm(prompt: string): Promise<string> {
	await endpoints.load();
	const endpoint = endpoints.resolve({
		url: config.localLlmUrl,
		model: config.localLlmModel,
	});
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		endpoint.authProvider ? Math.max(config.localLlmTimeoutMs, 120_000) : config.localLlmTimeoutMs,
	);
	try {
		if (endpoint.authProvider === "claude") {
			const result = await claudeCompletion(endpoint.model, [{ role: "user", content: prompt }], { signal: controller.signal });
			if (!result.text.trim()) throw new Error("Claude returned no text");
			return result.text.trim();
		}
		const response = await modelFetch(endpoint, usesResponses(endpoint.url) ? responsesBody(endpoint.model, [{ role: "user", content: prompt }], 2048) : {
				model: endpoint.model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.7,
				stream: false,
			}, controller.signal);
		if (!response.ok)
			throw new Error(`${endpoint.label} returned HTTP ${response.status}`);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object")
			throw new Error("Invalid local LLM response");
		const content = usesResponses(endpoint.url) ? responseText(data as ModelResponse) : (
			data as { choices?: Array<{ message?: { content?: unknown } }> }
		).choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim())
			throw new Error(`${endpoint.label} returned no text`);
		return content.trim();
	} finally {
		clearTimeout(timeout);
	}
}
