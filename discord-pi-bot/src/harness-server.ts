import "dotenv/config";
import express, { type Express } from "express";
import os from "node:os";
import { resolve } from "node:path";
import { config } from "./config";
import {
	deleteReminder,
	getReminders,
	loadReminders,
} from "./utils/reminderManager";
import {
	createPhaseId,
	createToolCall,
	normalizePhaseMetrics,
	type PhaseMetrics,
	type ToolCall,
} from "./harness/modelPhases";
import { createSseSender } from "./harness/sse";
import { measureTokenUsage, tokenizerUrl } from "./harness/tokenizer";
import { normalizeEntity, type HassEntity } from "./harness/entities";
import { validateEntityAction, type EntityAction } from "./harness/entityActions";
import { ConversationStore } from "./harness/conversations";
import { publicSettings, recommendHardwareProfile, validateLocalModelUrl } from "./harness/settings";
import { userContent, validateAttachments, type ImageAttachment } from "./harness/attachments";

const app = express();
const port = Number(process.env.HARNESS_PORT || 8090);
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
const homeAssistantUrl = "http://supervisor/core/api";
const supervisorUrl = "http://supervisor";
const pendingActions = new Map<
	string,
	{
		domain: string;
		service: string;
		entityId: string;
		serviceData: Record<string, unknown>;
	}
>();
void loadReminders(async () => {});
const conversations = new ConversationStore();
void conversations.load();
type Send = (event: string, data: unknown) => void;

app.use(express.json({ limit: "64kb" }));
app.get("/api/conversations", (request, response) => {
	response.json(conversations.list(typeof request.query.search === "string" ? request.query.search : ""));
});
app.post("/api/conversations", async (_request, response) => {
	response.status(201).json(await conversations.create());
});
app.patch("/api/conversations/:id", async (request, response) => {
	const updated = await conversations.update(request.params.id, request.body || {});
	response.status(updated ? 200 : 404).json(updated || { error: "Conversation not found" });
});
app.delete("/api/conversations/:id", async (request, response) => {
	const deleted = await conversations.delete(request.params.id);
	response.status(deleted ? 204 : 404).end();
});
app.post("/api/tokenize", async (request, response) => {
	const prompt = typeof request.body?.prompt === "string" ? request.body.prompt : "";
	const messages = Array.isArray(request.body?.messages) ? request.body.messages.slice(-100) : [];
	try {
		const usage = await measureTokenUsage(
			tokenizerUrl(getLocalLlmUrl()),
			prompt.slice(0, 32_000),
			messages,
			Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
		);
		response.json(usage);
	} catch (error) {
		response.status(503).json({ exact: false, error: error instanceof Error ? error.message : "Tokenizer unavailable" });
	}
});
app.get("/api/settings", (_request, response) => {
	response.json({ ...publicSettings(process.env), hardwareProfile: recommendHardwareProfile(os.totalmem(), os.cpus().length) });
});
app.post("/api/settings", async (request, response) => {
	const values = request.body || {};
	const options: Record<string, unknown> = {};
	try {
		if (typeof values.localLlmUrl === "string") options.local_llm_url = validateLocalModelUrl(values.localLlmUrl);
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Invalid model endpoint" });
		return;
	}
	if (typeof values.model === "string") options.local_llm_model = values.model;
	if (typeof values.exaApiKey === "string" && values.exaApiKey)
		options.exa_api_key = values.exaApiKey;
	if (typeof values.notifyTarget === "string") options.ha_notify_target = values.notifyTarget.replace(/^notify\./, "");
	if (!Object.keys(options).length) {
		response.status(400).json({ error: "No settings supplied" });
		return;
	}
	try {
		const result = await supervisorRequest("/addons/self/options", "POST", {
			options,
		});
		response.json({ saved: true, result });
	} catch (error) {
		response.status(502).json({
			error: error instanceof Error ? error.message : "Unable to save settings",
		});
	}
});
app.get("/api/entities/:id", async (request, response) => {
	const result = await hassRequest(`/states/${encodeURIComponent(request.params.id)}`);
	if (!result || typeof result !== "object" || !("entity_id" in result)) {
		response.status(502).json(result);
		return;
	}
	response.json(normalizeEntity(result as HassEntity));
});
app.post("/api/entities/action", async (request, response) => {
	const entityId = typeof request.body?.entityId === "string" ? request.body.entityId : "";
	const action = request.body?.action as EntityAction;
	try {
		const state = await hassRequest(`/states/${encodeURIComponent(entityId)}`);
		if (!state || typeof state !== "object" || !("entity_id" in state)) throw new Error("Entity state unavailable");
		const validated = validateEntityAction(normalizeEntity(state as HassEntity), action, request.body?.value);
		if (validated.requiresConfirmation) {
			const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			pendingActions.set(token, validated);
			response.json({ confirmation_required: true, token, message: `Confirm ${validated.service} for ${validated.entityId}` });
			return;
		}
		await hassRequest(`/services/${validated.domain}/${validated.service}`, "POST", { ...validated.serviceData, entity_id: validated.entityId });
		const refreshed = await hassRequest(`/states/${encodeURIComponent(validated.entityId)}`);
		response.json(refreshed && typeof refreshed === "object" && "entity_id" in refreshed ? normalizeEntity(refreshed as HassEntity) : refreshed);
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Invalid entity action" });
	}
});
app.get("/api/reminders", (_request, response) => {
	response.json(
		getReminders(process.env.OWNER_ID || "").map((item) => ({
			id: item.id,
			message: item.message,
			time: item.time.toISOString(),
		})),
	);
});
app.delete("/api/reminders/:id", (_request, response) => {
	const deleted = deleteReminder(
		_request.params.id,
		process.env.OWNER_ID || "",
	);
	response.status(deleted ? 204 : 404).end();
});
app.get("/api/status", (_request, response) => {
	response.json({
		model: config.localLlmModel,
		llmUrl:
			process.env.LOCAL_LLM_URL ||
			"http://homeassistant:8080/v1/chat/completions",
		vision: process.env.LOCAL_LLM_VISION === "true",
		profiles: ["fast", "balanced", "deep"],
		hardware: {
			architecture: process.arch,
			cpuCores: os.cpus().length,
			memoryTotal: os.totalmem(),
			memoryFree: os.freemem(),
		},
	});
});
app.get("/", (_request, response) =>
	response.sendFile("harness.html", { root: "public" }),
);
app.post("/api/confirm", async (request, response) => {
	const token =
		typeof request.body?.token === "string" ? request.body.token : "";
	const action = pendingActions.get(token);
	if (!action) {
		response.status(404).json({ error: "Action expired or not found" });
		return;
	}
	pendingActions.delete(token);
	response.json(
		await hassRequest(`/services/${action.domain}/${action.service}`, "POST", {
			...action.serviceData,
			entity_id: action.entityId,
		}),
	);
});

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
	response.status(200).set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	const send = createSseSender(response);
	try {
		const attachments = validateAttachments(request.body?.attachments, process.env.LOCAL_LLM_VISION === "true");
		await runAgent(prompt, thinkingMode, send, `request-${Date.now()}`, attachments);
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
			description:
				"List Home Assistant entities, optionally filtered by domain such as light or sensor.",
			parameters: {
				type: "object",
				properties: { domain: { type: "string" } },
			},
		},
	},
	{
		type: "function",
		function: {
			name: "control_entity",
			description:
				"Prepare a Home Assistant device action. A user confirmation is always required.",
			parameters: {
				type: "object",
				properties: {
					domain: { type: "string" },
					service: { type: "string" },
					entity_id: { type: "string" },
					service_data: { type: "object" },
				},
				required: ["domain", "service", "entity_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_reminders",
			description: "List reminders belonging to the configured Discord owner.",
			parameters: { type: "object", properties: {} },
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
	requestId: string,
	attachments: ImageAttachment[],
): Promise<void> {
	const messages: Array<Record<string, unknown>> = [
		{
			role: "system",
			content:
				"You are a Home Assistant assistant. Use tools for current state and web search. Explain actions clearly.",
		},
		{ role: "user", content: userContent(prompt, attachments) },
	];
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const phaseId = createPhaseId(requestId, iteration);
		send("phase_start", { phaseId, iteration, kind: "thinking", state: "active" });
		const result = await streamModel(messages, thinkingMode, tools, send, phaseId, iteration);
		if (!result.toolCalls.length) {
			send("answer", { text: result.text });
			send("phase_complete", { phaseId, iteration, kind: "answer", state: "complete", metrics: result.metrics });
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
			send("tool_start", { phaseId, iteration, kind: "tool", state: "active", name: call.function.name, arguments: args, metrics: result.metrics });
			const value = await executeTool(call.function.name, args);
			send("tool", {
				name: call.function.name,
				state: "complete",
				result: value,
			});
			send("tool_complete", { phaseId, iteration, kind: "tool", state: "complete", name: call.function.name, result: value, metrics: result.metrics });
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(value),
			});
		}
		send("phase_complete", { phaseId, iteration, kind: "tool", state: "complete", metrics: result.metrics });
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
	phaseId: string,
	iteration: number,
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
	let usage: Record<string, number> = {};
	let firstTokenAt: number | undefined;
	const toolCalls: ToolCall[] = [];
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += Buffer.from(chunk).toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
			let payload: {
				usage?: Record<string, number>;
				timings?: Record<string, number>;
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
			if (payload.timings) timings = { ...timings, ...payload.timings };
			if (payload.usage) usage = { ...usage, ...payload.usage };
			if (choice?.timings) timings = { ...timings, ...choice.timings };
			const delta = choice?.delta;
			if (!delta) continue;
			if (delta.content) {
				firstTokenAt ??= Date.now();
				text += delta.content;
				send("token", { text: delta.content });
				send("answer_delta", { phaseId, iteration, kind: "answer", text: delta.content });
			}
			if (delta.reasoning_content) {
				firstTokenAt ??= Date.now();
				thinking += delta.reasoning_content;
				send("thinking", { text: delta.reasoning_content });
				send("thinking_delta", { phaseId, iteration, kind: "thinking", text: delta.reasoning_content });
			}
			for (const call of delta.tool_calls || []) {
				const index = call.index || 0;
				toolCalls[index] ??= createToolCall(call.id || `tool-${index}`, "", "");
				if (call.function?.name)
					toolCalls[index].function.name += call.function.name;
				if (call.function?.arguments)
					toolCalls[index].function.arguments += call.function.arguments;
			}
		}
	}
	const elapsed = Date.now() - started;
	const metrics: PhaseMetrics = normalizePhaseMetrics(
		usage,
		timings,
		firstTokenAt ? firstTokenAt - started : elapsed,
		elapsed,
		thinking.length,
	);
	if (!metrics.outputTokens) metrics.outputTokens = text.length;
	send("metrics", {
		inputTokens: metrics.inputTokens,
		outputTokens: metrics.outputTokens,
		promptTokensPerSecond: metrics.encodeTokensPerSecond,
		generationTokensPerSecond: metrics.decodeTokensPerSecond,
		firstTokenMs: metrics.firstTokenMs,
		totalMs: metrics.totalMs,
		thinkingTokens: metrics.thinkingTokens,
	});
	send("phase_metrics", { phaseId, iteration, kind: toolCalls.length ? "tool" : "answer", metrics });
	return { text, toolCalls: toolCalls.filter(Boolean), metrics };
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
			.filter(
				(item) => !domain || String(item.entity_id).startsWith(`${domain}.`),
			)
			.slice(0, 50)
			.map((item) => normalizeEntity(item as HassEntity));
	}
	if (name === "control_entity") {
		const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const domain = String(args.domain);
		const service = String(args.service);
		const entityId = String(args.entity_id);
		const serviceData =
			args.service_data &&
			typeof args.service_data === "object" &&
			!Array.isArray(args.service_data)
				? (args.service_data as Record<string, unknown>)
				: {};
		if (
			!/^[a-z0-9_]+$/.test(domain) ||
			!/^[a-z0-9_]+$/.test(service) ||
			!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)
		)
			return { error: "Invalid entity action" };
		pendingActions.set(token, { domain, service, entityId, serviceData });
		return {
			confirmation_required: true,
			token,
			message: `Confirm ${domain}.${service} for ${entityId}`,
		};
	}
	if (name === "list_reminders")
		return getReminders(process.env.OWNER_ID || "").map((item) => ({
			id: item.id,
			message: item.message,
			time: item.time.toISOString(),
		}));
	if (name === "web_search") return exaSearch(String(args.query));
	return { error: `Unknown tool: ${name}` };
}

async function supervisorRequest(path: string, method = "GET", body?: unknown) {
	if (!supervisorToken)
		throw new Error("Supervisor API access is not configured");
	const response = await fetch(`${supervisorUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${supervisorToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok)
		throw new Error(
			`Supervisor returned HTTP ${response.status}: ${await response.text()}`,
		);
	return response.json();
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

app.use(express.static(resolve(process.cwd(), "public")));
app.use((_request, response) => {
	response.status(404).type("text/plain").send("Not found");
});

export function createHarnessApp(): Express {
	return app;
}

if (require.main === module) {
	app.listen(port, () =>
		console.log(`RemindMe harness listening on port ${port}`),
	);
}
