import "dotenv/config";
import express from "express";
import { config } from "./config";

const app = express();
const port = Number(process.env.HARNESS_PORT || 8090);
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
const homeAssistantUrl = "http://supervisor/core/api";
type Send = (event: string, data: unknown) => void;
type ToolCall = { id: string; function: { name: string; arguments: string } };

app.use(express.json({ limit: "64kb" }));
app.get("/api/status", (_request, response) => {
	response.json({
		model: config.localLlmModel,
		llmUrl:
			process.env.LOCAL_LLM_URL ||
			"http://homeassistant:8080/v1/chat/completions",
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
	response
		.status(200)
		.set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
	const send: Send = (event, data) =>
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	try {
		await runAgent(prompt, thinkingMode, send);
		send("complete", {});
	} catch (error) {
		console.error("Harness request failed:", error);
		send("error", {
			message: error instanceof Error ? error.message : "Unknown error",
		});
	} finally {
		response.end();
	}
});

const tools = [
	{
		type: "function",
		function: {
			name: "get_entity_state",
			description: "Read a Home Assistant entity state.",
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
			name: "list_entities",
			description: "List Home Assistant entities, optionally filtered by domain such as light or sensor.",
			parameters: {
				type: "object",
				properties: { domain: { type: "string" } },
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

async function runAgent(
	prompt: string,
	thinkingMode: string,
	send: Send,
): Promise<void> {
	const messages: Array<Record<string, unknown>> = [
		{
			role: "system",
			content:
				"You are a Home Assistant assistant. Use tools for current state and web search. Explain actions clearly.",
		},
		{ role: "user", content: prompt },
	];
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const result = await streamModel(messages, thinkingMode, tools, send);
		if (!result.toolCalls.length) {
			send("answer", { text: result.text });
			return;
		}
		messages.push({
			role: "assistant",
			content: result.text,
			tool_calls: result.toolCalls,
		});
		for (const call of result.toolCalls) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(call.function.arguments || "{}");
			} catch {
				send("tool", { name: call.function.name, state: "invalid arguments" });
			}
			send("tool", {
				name: call.function.name,
				state: "running",
				arguments: args,
			});
			const value = await executeTool(call.function.name, args);
			send("tool", { name: call.function.name, state: "complete", result: value });
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(value),
			});
		}
	}
	send("answer", {
		text: "I reached the tool-call limit before completing the request.",
	});
}

async function streamModel(
	messages: Array<Record<string, unknown>>,
	thinkingMode: string,
	requestTools: unknown[],
	send: Send,
) {
	const started = Date.now();
	const response = await fetch(getLocalLlmUrl(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: config.localLlmModel,
			messages,
			tools: requestTools,
			tool_choice: "auto",
			stream: true,
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
	if (!response.body) throw new Error("llama.cpp returned no stream");
	let buffer = "";
	let text = "";
	let thinking = "";
	let timings: Record<string, number> = {};
	let firstTokenAt: number | undefined;
	const toolCalls: ToolCall[] = [];
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += Buffer.from(chunk).toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
			let payload: {
				choices?: Array<{
					delta?: {
						content?: string;
						reasoning_content?: string;
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					timings?: Record<string, number>;
				}>;
			};
			try {
				payload = JSON.parse(line.slice(6));
			} catch {
				continue;
			}
			const choice = payload.choices?.[0];
			if (choice?.timings) timings = { ...timings, ...choice.timings };
			const delta = choice?.delta;
			if (!delta) continue;
			if (delta.content) {
				firstTokenAt ??= Date.now();
				text += delta.content;
				send("token", { text: delta.content });
			}
			if (delta.reasoning_content) {
				firstTokenAt ??= Date.now();
				thinking += delta.reasoning_content;
				send("thinking", { text: delta.reasoning_content });
			}
			for (const call of delta.tool_calls || []) {
				const index = call.index || 0;
				toolCalls[index] ??= {
					id: call.id || `tool-${index}`,
					function: { name: "", arguments: "" },
				};
				if (call.function?.name)
					toolCalls[index].function.name += call.function.name;
				if (call.function?.arguments)
					toolCalls[index].function.arguments += call.function.arguments;
			}
		}
	}
	const elapsed = Date.now() - started;
	send("metrics", {
		inputTokens: timings.prompt_n || 0,
		outputTokens: timings.predicted_n || text.length,
		promptTokensPerSecond: timings.prompt_per_second || 0,
		generationTokensPerSecond: timings.predicted_per_second || 0,
		firstTokenMs: firstTokenAt ? firstTokenAt - started : elapsed,
		totalMs: elapsed,
		thinkingTokens: thinking.length,
	});
	return { text, toolCalls: toolCalls.filter(Boolean) };
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
			throw new Error("LOCAL_LLM_URL must target the local model");
		return url;
	} catch (error) {
		console.error("Invalid LOCAL_LLM_URL:", error);
		throw new Error("Invalid LOCAL_LLM_URL");
	}
}

async function executeTool(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	if (name === "get_entity_state")
		return hassRequest(`/states/${encodeURIComponent(String(args.entity_id))}`);
	if (name === "list_entities") {
		const states = await hassRequest("/states");
		if (!Array.isArray(states)) return states;
		const domain = typeof args.domain === "string" ? args.domain : "";
		return states
			.filter((item) => !domain || String(item.entity_id).startsWith(`${domain}.`))
			.slice(0, 50);
	}
	if (name === "web_search") return exaSearch(String(args.query));
	return { error: `Unknown tool: ${name}` };
}

async function hassRequest(path: string) {
	if (!supervisorToken)
		return { error: "Home Assistant API access is not configured." };
	const response = await fetch(`${homeAssistantUrl}${path}`, {
		headers: { Authorization: `Bearer ${supervisorToken}` },
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
