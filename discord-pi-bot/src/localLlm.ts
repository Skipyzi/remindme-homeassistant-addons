import { config } from "./config";

function getLocalLlmUrl(): URL {
	try {
		const url = new URL(config.localLlmUrl);
		const allowedHosts = new Set([
			"localhost",
			"127.0.0.1",
			"::1",
			"local-llama-cpp",
		]);
		if (!allowedHosts.has(url.hostname) || url.protocol !== "http:") {
			throw new Error(
				"URL must use HTTP and target the local llama.cpp service",
			);
		}
		return url;
	} catch (error) {
		console.error("Invalid LOCAL_LLM_URL:", error);
		throw new Error("Invalid LOCAL_LLM_URL");
	}
}

export async function askLocalLlm(prompt: string): Promise<string> {
	const localLlmUrl = getLocalLlmUrl();
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		config.localLlmTimeoutMs,
	);
	try {
		const response = await fetch(localLlmUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
			body: JSON.stringify({
				model: config.localLlmModel,
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
