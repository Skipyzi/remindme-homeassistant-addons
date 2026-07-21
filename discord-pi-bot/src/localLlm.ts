import { config } from "./config";
import { EndpointStore } from "./harness/endpoints";

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
		config.localLlmTimeoutMs,
	);
	try {
		const response = await fetch(endpoint.url, {
			method: "POST",
			headers: endpoint.headers,
			signal: controller.signal,
			body: JSON.stringify({
				model: endpoint.model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.7,
				stream: false,
			}),
		});
		if (!response.ok)
			throw new Error(`Local LLM returned HTTP ${response.status}`);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object")
			throw new Error("Invalid local LLM response");
		const content = (
			data as { choices?: Array<{ message?: { content?: unknown } }> }
		).choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim())
			throw new Error("Local LLM returned no text");
		return content.trim();
	} finally {
		clearTimeout(timeout);
	}
}
