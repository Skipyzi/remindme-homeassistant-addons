import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Express } from "express";
import type { ToolSpec } from "../ai/types";
import type { ToolRun } from "../assistant/tools";
import { chatgptAuth } from "../subscriptions/chatgptAuth";
import { nativeCodexFetch } from "./native-accounts";

/**
 * What a CLI agent may reach during one turn: RemindMe's tools, and for
 * Codex the ChatGPT model through RemindMe. The agent gets a loopback URL and
 * a random token that dies with the turn — never the Home Assistant or
 * provider credentials.
 */
interface Capability {
	tools: ToolSpec[];
	call(name: string, args: unknown): Promise<ToolRun>;
	signal: AbortSignal;
	/** Codex only: which ChatGPT credentials its model requests use. */
	codexNative?: boolean;
}

const capabilities = new Map<string, Capability>();

export function openCapability(capability: Capability): { token: string; close(): void } {
	const token = randomBytes(32).toString("hex");
	capabilities.set(token, capability);
	return { token, close: () => capabilities.delete(token) };
}

function capabilityFor(header: string | undefined): Capability | undefined {
	const capability = capabilities.get((header || "").replace(/^Bearer /, ""));
	return capability && !capability.signal.aborted ? capability : undefined;
}

/* The ChatGPT subscription takes a smaller request surface than API billing. */
const unsupportedFields = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];

/** A Responses request on the ChatGPT subscription: always streamed, never stored. */
export async function chatgptFetch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
	const request: Record<string, unknown> = { ...body, store: false, stream: true };
	for (const field of unsupportedFields) delete request[field];
	if (Array.isArray(body.input))
		request.input = body.input.map((item) => (item && typeof item === "object" && item.role === "system" ? { ...item, role: "developer" } : item));
	return fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		redirect: "error",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${await chatgptAuth.accessToken()}` },
		body: JSON.stringify(request),
		signal,
	});
}

export function registerBridge(app: Express): void {
	app.post("/internal/agent-tools", async (request, response) => {
		const capability = capabilityFor(request.headers.authorization);
		if (!capability) {
			response.status(403).json({ error: "Capability expired" });
			return;
		}
		if (request.body?.method === "tools/list") {
			response.json({ tools: capability.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
			return;
		}
		if (request.body?.method !== "tools/call") {
			response.status(400).json({ error: "Unsupported tool method" });
			return;
		}
		try {
			const result = await capability.call(String(request.body.params?.name || ""), request.body.params?.arguments);
			response.json({ content: [{ type: "text", text: result.content }], isError: Boolean(result.isError) });
		} catch (error) {
			response.json({ content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }], isError: true });
		}
	});
	// Codex's model requests, answered with the ChatGPT subscription.
	app.post("/internal/agent-inference/v1/responses", async (request, response) => {
		const capability = capabilityFor(request.headers.authorization);
		if (!capability) {
			response.status(403).json({ error: { message: "Capability expired" } });
			return;
		}
		const abort = new AbortController();
		const cancel = () => abort.abort();
		capability.signal.addEventListener("abort", cancel, { once: true });
		response.on("close", () => {
			if (!response.writableFinished) abort.abort();
		});
		try {
			// Advertise only RemindMe's tools, as plain functions; no coding tools.
			const body = {
				...request.body,
				input: Array.isArray(request.body.input) ? request.body.input.filter((item: { type?: string }) => item.type !== "additional_tools") : request.body.input,
				tools: capability.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
			};
			const upstream = capability.codexNative ? await nativeCodexFetch(body, abort.signal) : await chatgptFetch(body, abort.signal);
			response.status(upstream.status).set("Content-Type", upstream.headers.get("content-type") || "application/json");
			if (!upstream.body) response.end();
			else
				await new Promise<void>((resolve, reject) => {
					const stream = Readable.fromWeb(upstream.body as never);
					stream.on("error", reject);
					response.on("finish", resolve);
					response.on("close", resolve);
					stream.pipe(response);
				});
		} catch {
			if (!response.headersSent) response.status(502).json({ error: { message: "Model request failed" } });
			else response.end();
		} finally {
			capability.signal.removeEventListener("abort", cancel);
		}
	});
}
