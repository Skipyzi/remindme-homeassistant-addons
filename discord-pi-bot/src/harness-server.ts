import "dotenv/config";
import express from "express";
import { config } from "./config";

const app = express();
const port = Number(process.env.HARNESS_PORT || 8090);
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
const homeAssistantUrl = "http://supervisor/core/api";

app.use(express.json({ limit: "64kb" }));
app.get("/api/status", (_request, response) => {
	response.json({
		model: config.localLlmModel,
		llmUrl: process.env.LOCAL_LLM_URL || "http://homeassistant:8080/v1/chat/completions",
		vision: false,
		profiles: ["fast", "balanced", "deep"],
	});
});
app.get("/", (_request, response) =>
	response.sendFile("harness.html", { root: "public" }),
);

app.post("/api/chat", async (request, response) => {
	const prompt =
		typeof request.body?.message === "string"
			? request.body.message.trim()
			: "";
	const thinkingMode =
		request.body?.thinkingMode === "deep" ||
		request.body?.thinkingMode === "balanced"
			? request.body.thinkingMode
			: "fast";
	if (!prompt) {
		response.status(400).json({ error: "message is required" });
		return;
	}
	try {
		response.json({ response: await runAgent(prompt, thinkingMode) });
	} catch (error) {
		console.error("Harness request failed:", error);
		const detail = error instanceof Error ? error.message : "Unknown error";
		response.status(500).json({ error: `The local AI request failed: ${detail}` });
	}
});

async function runAgent(prompt: string, thinkingMode: string): Promise<string> {
	const messages: Array<Record<string, unknown>> = [
		{
			role: "system",
			content:
				"You are a Home Assistant assistant. Use tools for current state, web search, and safe actions. Ask for confirmation before changing devices.",
		},
		{ role: "user", content: prompt },
	];
	const tools = [
		{
			type: "function",
			function: {
				name: "get_entity_state",
				description:
					"Read the current state and attributes of a Home Assistant entity.",
				parameters: {
					type: "object",
					properties: { entity_id: { type: "string" } },
					required: ["entity_id"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "web_search",
				description: "Search the public web using Exa.",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		},
	];

	for (let iteration = 0; iteration < 5; iteration += 1) {
		const raw = await askLocalLlmWithTools(messages, tools, thinkingMode);
		const assistant = raw.choices?.[0]?.message;
		if (!assistant) throw new Error("The model returned no message");
		const calls = assistant.tool_calls || [];
		if (!calls.length)
			return assistant.content || "The model returned an empty response.";
		messages.push(assistant);
		for (const call of calls) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(call.function.arguments || "{}");
			} catch {
				args = {};
			}
			const result = await executeTool(call.function.name, args);
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(result),
			});
		}
	}
	return "I reached the tool-call limit before completing the request.";
}

function getLocalLlmUrl(): URL {
	try {
		const url = new URL(
			process.env.LOCAL_LLM_URL ||
				"http://homeassistant:8080/v1/chat/completions",
		);
		if (
			url.protocol !== "http:" ||
			!["homeassistant", "localhost", "127.0.0.1"].includes(url.hostname)
		)
			throw new Error("Local URL required");
		return url;
	} catch {
		throw new Error("Invalid LOCAL_LLM_URL");
	}
}

async function askLocalLlmWithTools(
	messages: Array<Record<string, unknown>>,
	tools: unknown[],
	thinkingMode: string,
) {
	const response = await fetch(getLocalLlmUrl(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: config.localLlmModel,
			messages,
			tools,
			tool_choice: "auto",
			max_tokens:
				thinkingMode === "deep"
					? 1024
					: thinkingMode === "balanced"
						? 512
						: 256,
			chat_template_kwargs: { enable_thinking: thinkingMode !== "fast" },
		}),
	});
	if (!response.ok)
		throw new Error(
			`llama.cpp returned HTTP ${response.status}: ${await response.text()}`,
		);
	return (await response.json()) as {
		choices?: Array<{
			message?: {
				content?: string;
				tool_calls?: Array<{
					id: string;
					function: { name: string; arguments: string };
				}>;
			};
		}>;
	};
}

async function executeTool(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	if (name === "get_entity_state")
		return hassRequest(`/states/${encodeURIComponent(String(args.entity_id))}`);
	if (name === "web_search") return exaSearch(String(args.query));
	if (name === "call_home_assistant_service") {
		if (args.confirmed !== true)
			return {
				error: "User confirmation is required before changing a device.",
			};
		const domain = String(args.domain);
		const service = String(args.service);
		if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service))
			return { error: "Invalid service." };
		return hassRequest(`/services/${domain}/${service}`, "POST", {
			entity_id: String(args.entity_id),
		});
	}
	return { error: `Unknown tool: ${name}` };
}

async function hassRequest(path: string, method = "GET", body?: unknown) {
	if (!supervisorToken)
		return { error: "Home Assistant API access is not configured." };
	const response = await fetch(`${homeAssistantUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${supervisorToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok)
		return { error: `Home Assistant returned HTTP ${response.status}` };
	return response.json();
}

async function exaSearch(query: string) {
	const key = process.env.EXA_API_KEY;
	if (!key) return { error: "Exa is not configured." };
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": key, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			type: "auto",
			numResults: 5,
			contents: { highlights: true },
		}),
	});
	if (!response.ok) return { error: `Exa returned HTTP ${response.status}` };
	return response.json();
}

app.listen(port, () =>
	console.log(`RemindMe harness listening on port ${port}`),
);
