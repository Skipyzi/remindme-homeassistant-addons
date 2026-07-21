import "dotenv/config";
import express, { type Express, type Response } from "express";
import { randomUUID } from "node:crypto";
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
	estimateTokens,
	normalizePhaseMetrics,
	reasoningText,
	routeThinkTags,
	stripReasoningTags,
	type ActiveModelMetadata,
	type PhaseMetrics,
	type ToolCall,
} from "./harness/modelPhases";
import { createSseSender } from "./harness/sse";
import { measureTokenUsage, tokenizerUrl } from "./harness/tokenizer";
import { normalizeEntity, type HassEntity } from "./harness/entities";
import { compactEntity, resolveEntities } from "./harness/entityResolver";
import {
	validateEntityAction,
	type EntityAction,
} from "./harness/entityActions";
import { ConversationStore } from "./harness/conversations";
import { SkillStore, skillPrompt } from "./harness/skills";
import { readSystemStats } from "./harness/systemStats";
import { ArtifactStore, toDocument } from "./harness/artifacts";
import {
	McpServerStore,
	callTool as callMcpTool,
	connect as connectMcp,
	parseToolCallName,
	toOpenAiTool,
} from "./harness/mcp";
import {
	describeTransportError,
	invalidateManagerToken,
} from "./harness/modelManager";

import { allowedToolNames, toolCallKey } from "./harness/intentRouting";
import {
	getThinkingProfile,
	thinkingProfilesForHardware,
	type ThinkingMode,
} from "./harness/thinkingProfiles";
import {
	userContent,
	validateAttachments,
	type ImageAttachment,
} from "./harness/attachments";
import {
	ModelManagerClient,
	ModelManagerError,
	deriveManagerUrl,
	managerPairingConfigured,
	pairModelManager,
	readManagerToken,
} from "./harness/modelManager";

const app = express();
const port = Number(process.env.HARNESS_PORT || 8090);
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
const homeAssistantUrl = "http://supervisor/core/api";
const instanceId = randomUUID();
const pendingActions = new Map<
	string,
	{
		domain: string;
		service: string;
		entityId: string;
		serviceData: Record<string, unknown>;
		destructive: boolean;
	}
>();
void loadReminders(async () => {});
const conversations = new ConversationStore();
void conversations.load();
const skills = new SkillStore();
void skills.load();
const artifacts = new ArtifactStore();
void artifacts.load();
const mcpServers = new McpServerStore();
void mcpServers.load();
type Send = (event: string, data: unknown) => void;

app.use(express.json({ limit: "64kb" }));
app.get("/api/mcp", (_request, response) => {
	response.json(mcpServers.list());
});
app.post("/api/mcp", async (request, response) => {
	try {
		const created = await mcpServers.create(request.body || {});
		const { authorization, ...safe } = created;
		response.status(201).json({ ...safe, hasAuth: Boolean(authorization) });
	} catch (error) {
		response.status(400).json({
			error: error instanceof Error ? error.message : "Invalid MCP server",
		});
	}
});
app.patch("/api/mcp/:id", async (request, response) => {
	try {
		const updated = await mcpServers.update(request.params.id, request.body || {});
		if (!updated) return response.status(404).json({ error: "Not found" });
		const { authorization, ...safe } = updated;
		response.json({ ...safe, hasAuth: Boolean(authorization) });
	} catch (error) {
		response.status(400).json({
			error: error instanceof Error ? error.message : "Invalid MCP server",
		});
	}
});
app.delete("/api/mcp/:id", async (request, response) => {
	response.status((await mcpServers.delete(request.params.id)) ? 204 : 404).end();
});
/* Handshake and list tools, so a server can be checked before it is trusted
 * with a turn. */
app.post("/api/mcp/:id/test", async (request, response) => {
	const server = mcpServers.get(request.params.id);
	if (!server) return response.status(404).json({ error: "Not found" });
	try {
		const session = await connectMcp(server);
		response.json({
			ok: true,
			serverName: session.serverName,
			tools: session.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
			})),
		});
	} catch (error) {
		response.status(502).json({
			ok: false,
			error: error instanceof Error ? error.message : "Could not reach server",
		});
	}
});
app.get("/api/skills", (_request, response) => {
	response.json(skills.list());
});
app.post("/api/skills", async (request, response) => {
	response.status(201).json(await skills.create(request.body || {}));
});
app.patch("/api/skills/:id", async (request, response) => {
	const updated = await skills.update(request.params.id, request.body || {});
	response
		.status(updated ? 200 : 404)
		.json(updated || { error: "Skill not found" });
});
app.delete("/api/skills/:id", async (request, response) => {
	response.status((await skills.delete(request.params.id)) ? 204 : 404).end();
});
/* Tool catalogue for the /tools command — names, descriptions and parameter
 * keys only, so the UI can list capabilities without restating the schema. */
/* Host telemetry for the rail. Polled, so it is deliberately cheap: reading
 * one sysfs file and differencing CPU counters. */
app.get("/api/artifacts", (_request, response) => {
	response.json(artifacts.list());
});
app.get("/api/artifacts/:id", (request, response) => {
	const artifact = artifacts.get(request.params.id);
	response.status(artifact ? 200 : 404).json(artifact || { error: "Not found" });
});
app.delete("/api/artifacts/:id", async (request, response) => {
	response.status((await artifacts.delete(request.params.id)) ? 204 : 404).end();
});
/*
 * The rendered document, served for the sandboxed frame.
 *
 * Delivered on its own URL rather than through srcdoc so the browser applies
 * the response CSP, and marked to be framed only by this add-on. The frame
 * carries sandbox="allow-scripts" without allow-same-origin, so this document
 * runs in an opaque origin with no reach into the console or the Home
 * Assistant session.
 */
app.get("/api/artifacts/:id/document", (request, response) => {
	const artifact = artifacts.get(request.params.id);
	if (!artifact || !toDocument(artifact))
		return response.status(404).type("text/plain").send("Not found");
	response
		.status(200)
		.set({
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; frame-ancestors 'self'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
		})
		.send(toDocument(artifact));
});
app.get("/api/system", async (_request, response) => {
	response.set("Cache-Control", "no-store").json(await readSystemStats());
});
app.get("/api/tools", (_request, response) => {
	response.json(
		tools.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description,
			parameters: Object.keys(
				(tool.function.parameters as { properties?: Record<string, unknown> })
					?.properties || {},
			),
		})),
	);
});
app.get("/api/conversations", (request, response) => {
	response.json(
		conversations.list(
			typeof request.query.search === "string" ? request.query.search : "",
		),
	);
});
app.post("/api/conversations", async (_request, response) => {
	response.status(201).json(await conversations.create());
});
app.patch("/api/conversations/:id", async (request, response) => {
	const updated = await conversations.update(
		request.params.id,
		request.body || {},
	);
	response
		.status(updated ? 200 : 404)
		.json(updated || { error: "Conversation not found" });
});
app.delete("/api/conversations/:id", async (request, response) => {
	const deleted = await conversations.delete(request.params.id);
	response.status(deleted ? 204 : 404).end();
});
app.post("/api/tokenize", async (request, response) => {
	const prompt =
		typeof request.body?.prompt === "string" ? request.body.prompt : "";
	const messages = Array.isArray(request.body?.messages)
		? request.body.messages.slice(-100)
		: [];
	try {
		const usage = await measureTokenUsage(
			tokenizerUrl(getLocalLlmUrl()),
			prompt.slice(0, 32_000),
			messages,
			Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
		);
		response.json(usage);
	} catch (error) {
		response.status(503).json({
			exact: false,
			error: error instanceof Error ? error.message : "Tokenizer unavailable",
		});
	}
});
/**
 * Probe each layer between the harness and the model manager and report them
 * separately, so "unreachable" can be attributed rather than guessed at.
 *
 * The manager owns port 8080 and reverse-proxies anything that is not
 * /manager/v1/* to llama-server, so working inference already proves the
 * manager process is up — which is why these are reported apart.
 */
app.get("/api/models/diagnostics", async (_request, response) => {
	const managerUrl = process.env.MODEL_MANAGER_URL || "";
	const checks: Array<Record<string, unknown>> = [];

	const enabled = process.env.MODEL_MANAGER_ENABLED === "true";
	checks.push({
		step: "enabled",
		ok: enabled,
		detail: `MODEL_MANAGER_ENABLED=${process.env.MODEL_MANAGER_ENABLED ?? "(unset)"}`,
		// A hint is a remedy, so it only belongs on a failing check.
		hint: enabled
			? undefined
			: "Set 'model_manager_enabled' in the add-on configuration.",
	});
	checks.push({
		step: "url",
		ok: Boolean(managerUrl),
		detail: managerUrl || "(unset)",
	});

	const paired = await managerPairingConfigured(managerTokenPath());
	checks.push({
		step: "paired",
		ok: paired,
		detail: paired ? "token present" : `no token at ${managerTokenPath()}`,
		hint: paired
			? undefined
			: "Read the pairing code from the Local llama.cpp add-on log and enter it in Models.",
	});

	// Unauthenticated probe: a 401 proves the manager is listening and routing.
	if (managerUrl) {
		try {
			const probe = await fetch(`${managerUrl}/status`, {
				signal: AbortSignal.timeout(4000),
			});
			const body = await probe.text().catch(() => "");
			checks.push({
				step: "reachable",
				ok: probe.status === 401 || probe.ok,
				status: probe.status,
				detail:
					probe.status === 401
						? "manager responded 401 — it is running; this is an auth/pairing issue"
						: probe.ok
							? "manager responded without auth (unexpected)"
							: `unexpected status; body starts: ${body.slice(0, 120)}`,
				hint:
					probe.status === 404
						? "404 suggests the Local llama.cpp add-on predates the model manager. Update it."
						: undefined,
			});
		} catch (error) {
			checks.push({
				step: "reachable",
				ok: false,
				detail: describeTransportError(error),
				hint: "Is the Local llama.cpp add-on running, and is port 8080 mapped?",
			});
		}
	}

	// Authenticated call — the one the Models tab actually makes.
	try {
		const status = await (await getModelManagerClient()).request("/status");
		checks.push({ step: "authenticated", ok: true, detail: "status returned", status });
	} catch (error) {
		const code = error instanceof ModelManagerError ? error.code : "unknown";
		const rejected =
			error instanceof ModelManagerError && error.status === 401 && paired;
		checks.push({
			step: "authenticated",
			ok: false,
			code,
			detail:
				error instanceof ModelManagerError
					? error.detail || error.message
					: String(error),
			hint: rejected
				? "The stored token is no longer accepted — the add-ons keep separate /data, so reinstalling Local llama.cpp regenerates its token. Re-pair with a fresh code from its log."
				: undefined,
		});
	}

	response.set("Cache-Control", "no-store").json({
		ok: checks.every((check) => check.ok),
		checks,
	});
});
app.get("/api/models/pairing", async (_request, response) => {
	response.set("Cache-Control", "no-store").json({
		configured: await managerPairingConfigured(managerTokenPath()),
	});
});
app.post("/api/models/pair", async (request, response) => {
	const code =
		typeof request.body?.code === "string"
			? request.body.code.trim().toUpperCase()
			: "";
	try {
		await pairModelManager(modelManagerUrl(), code, managerTokenPath());
		modelManagerClientPromise = undefined;
		response.json({ configured: true });
	} catch (error) {
		sendModelManagerError(response, error);
	}
});
app.get("/api/models", async (_request, response) => {
	await proxyModelManager(response, "/catalog");
});
app.get("/api/models/status", async (_request, response) => {
	await proxyModelManager(response, "/status");
});
app.post("/api/models/preflight", async (request, response) => {
	const body = modelSelectionBody(request.body);
	if (!body)
		return response
			.status(400)
			.json(safeModelError("invalid_model", "Model selection is invalid."));
	await proxyModelManager(response, "/preflight", "POST", body);
});
app.post("/api/models/install", async (request, response) => {
	const body = modelSelectionBody(request.body);
	if (!body)
		return response
			.status(400)
			.json(safeModelError("invalid_model", "Model selection is invalid."));
	await proxyModelManager(response, "/install", "POST", body);
});
app.post("/api/models/cancel", async (_request, response) => {
	await proxyModelManager(response, "/cancel", "POST", {});
});
app.get("/api/models/:id/options.yaml", async (request, response) => {
	const id = request.params.id;
	if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(id))
		return response
			.status(400)
			.json(safeModelError("invalid_model", "Model identifier is invalid."));
	try {
		const result = await (await getModelManagerClient()).requestText(
			`/models/${encodeURIComponent(id)}/options.yaml`,
		);
		response
			.status(200)
			.set({
				"Content-Type": result.contentType,
				"Content-Disposition": `attachment; filename="${id}-options.yaml"`,
				"Cache-Control": "no-store",
			})
			.send(result.body);
	} catch (error) {
		sendModelManagerError(response, error);
	}
});
app.delete("/api/models/:id", async (request, response) => {
	if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(request.params.id))
		return response
			.status(400)
			.json(safeModelError("invalid_model", "Model identifier is invalid."));
	await proxyModelManager(
		response,
		`/models/${encodeURIComponent(request.params.id)}`,
		"DELETE",
	);
});
app.post("/api/models/custom", async (request, response) => {
	const repo =
		typeof request.body?.repo === "string" ? request.body.repo.trim() : "";
	const file =
		typeof request.body?.file === "string" ? request.body.file.trim() : "";
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ||
		!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/.test(file)
	)
		return response
			.status(400)
			.json(
				safeModelError(
					"invalid_custom_model",
					"Enter one Hugging Face repository and GGUF filename.",
				),
			);
	await proxyModelManager(response, "/catalog/custom", "POST", { repo, file });
});
app.put("/api/models/credentials", async (request, response) => {
	const token =
		typeof request.body?.token === "string" ? request.body.token.trim() : "";
	if (!/^hf_[A-Za-z0-9_]{20,}$/.test(token))
		return response
			.status(400)
			.json(
				safeModelError(
					"invalid_token",
					"Enter a valid Hugging Face access token.",
				),
			);
	await proxyModelManager(response, "/credentials/huggingface", "PUT", {
		token,
	});
});
app.get("/api/models/events", async (request, response) => {
	const controller = new AbortController();
	request.on("close", () => controller.abort());
	try {
		const upstream = await (await getModelManagerClient()).openEvents(
			controller.signal,
		);
		response.status(200).set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders();
		const reader = upstream.body?.getReader();
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			response.write(Buffer.from(value));
		}
	} catch (error) {
		if (!response.headersSent) sendModelManagerError(response, error);
	} finally {
		if (!response.writableEnded) response.end();
	}
});
app.get("/api/entities/:id", async (request, response) => {
	const result = await hassRequest(
		`/states/${encodeURIComponent(request.params.id)}`,
	);
	if (!result || typeof result !== "object" || !("entity_id" in result)) {
		response.status(502).json(result);
		return;
	}
	response.json(normalizeEntity(result as HassEntity));
});
/**
 * Numeric history for one entity, used to draw sparklines. Fetched lazily by
 * the card rather than during the turn, so a slow recorder query never blocks
 * the model's reply. Never enters the context window.
 */
/**
 * Resolve entities without a model turn. The /entities command uses this, so
 * looking up a light costs no tokens and none of the seconds an inference
 * pass would take on a Pi.
 */
app.get("/api/entities", async (request, response) => {
	const states = await hassRequest("/states");
	if (!Array.isArray(states)) {
		response.status(502).json({ error: "Home Assistant is unavailable" });
		return;
	}
	const cards = resolveEntities(
		states.map((item) => normalizeEntity(item as HassEntity)),
		{
			query: typeof request.query.query === "string" ? request.query.query : "",
			domain: typeof request.query.domain === "string" ? request.query.domain : "",
			limit: 12,
		},
	);
	response.set("Cache-Control", "no-store").json(cards);
});
app.get("/api/entities/:id/history", async (request, response) => {
	const entityId = request.params.id;
	if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
		response.status(400).json({ error: "Invalid entity ID" });
		return;
	}
	const hours = Math.min(
		48,
		Math.max(1, Number(request.query.hours) || 6),
	);
	const start = new Date(Date.now() - hours * 3_600_000).toISOString();
	const result = await hassRequest(
		`/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(
			entityId,
		)}&minimal_response&no_attributes`,
	);
	if (!Array.isArray(result) || !Array.isArray(result[0])) {
		response.json({ points: [], hours });
		return;
	}
	const raw = result[0] as Array<{ state?: string; last_changed?: string }>;
	const points = raw
		.map((entry) => ({ value: Number(entry.state), at: entry.last_changed }))
		.filter((point) => Number.isFinite(point.value));
	/*
	 * Non-numeric states are dropped from `points` but kept here: a binary
	 * sensor's history is "on"/"off", and the card meta wants to count today's
	 * events and find when it last changed the other way.
	 */
	const changes = raw
		.filter((entry) => typeof entry.state === "string" && entry.last_changed)
		.map((entry) => ({ state: entry.state as string, at: entry.last_changed }));
	// Cap the series so a chatty sensor cannot ship thousands of points to a
	// 34px-tall sparkline. Changes are already sparse by nature.
	const stride = Math.max(1, Math.ceil(points.length / 120));
	response.json({
		points: points.filter((_, index) => index % stride === 0),
		changes: changes.slice(-200),
		hours,
	});
});
app.post("/api/entities/action", async (request, response) => {
	const entityId =
		typeof request.body?.entityId === "string" ? request.body.entityId : "";
	const action = request.body?.action as EntityAction;
	try {
		const state = await hassRequest(`/states/${encodeURIComponent(entityId)}`);
		if (!state || typeof state !== "object" || !("entity_id" in state))
			throw new Error("Entity state unavailable");
		const validated = validateEntityAction(
			normalizeEntity(state as HassEntity),
			action,
			request.body?.value,
		);
		if (validated.requiresConfirmation) {
			const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			pendingActions.set(token, validated);
			response.json({
				confirmation_required: true,
				token,
				destructive: validated.destructive,
				message: `Confirm ${validated.service} for ${validated.entityId}`,
			});
			return;
		}
		await hassRequest(
			`/services/${validated.domain}/${validated.service}`,
			"POST",
			{ ...validated.serviceData, entity_id: validated.entityId },
		);
		const refreshed = await hassRequest(
			`/states/${encodeURIComponent(validated.entityId)}`,
		);
		response.json(
			refreshed && typeof refreshed === "object" && "entity_id" in refreshed
				? normalizeEntity(refreshed as HassEntity)
				: refreshed,
		);
	} catch (error) {
		response.status(400).json({
			error: error instanceof Error ? error.message : "Invalid entity action",
		});
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
app.get("/api/status", async (_request, response) => {
	const managed = await managedActiveModel();
	const contextSize =
		managed?.recommendedContext ||
		Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192);
	response.set("Cache-Control", "no-store").json({
		instanceId,
		model: managed?.id || config.localLlmModel || "runtime-unavailable",
		modelName: managed
			? `${managed.family} ${managed.quantization}`.trim()
			: config.localLlmModel || "Runtime unavailable",
		/* Whether the manager is driving the endpoint, distinct from whether
		 * inference works at all. */
		managed: Boolean(managed),
		capabilities: managed?.capabilities || [],
		llmUrl:
			process.env.LOCAL_LLM_URL ||
			"http://homeassistant:8080/v1/chat/completions",
		vision:
			process.env.LOCAL_LLM_VISION === "true" &&
			Boolean(managed?.capabilities.includes("vision")),
		profiles: thinkingProfilesForHardware(os.totalmem(), contextSize),
		hardware: {
			architecture: process.arch,
			cpuCores: os.cpus().length,
			memoryTotal: os.totalmem(),
			memoryFree: os.freemem(),
		},
	});
});
app.get("/", (_request, response) =>
	response
		.set("Cache-Control", "no-cache, must-revalidate")
		.sendFile("harness.html", { root: "public" }),
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
	const thinkingMode = getThinkingProfile(
		typeof request.body?.thinkingMode === "string"
			? request.body.thinkingMode
			: "fast",
		os.totalmem(),
		Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
	).id;
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
		const attachments = validateAttachments(
			request.body?.attachments,
			process.env.LOCAL_LLM_VISION === "true",
		);
		await runAgent(
			prompt,
			thinkingMode,
			send,
			`request-${Date.now()}`,
			attachments,
		);
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
				"Find Home Assistant entities by plain-language name, e.g. 'kitchen light'. Optionally narrow by domain such as light or sensor. Returns the closest matches only.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Plain-language name, room, or partial match.",
					},
					domain: { type: "string" },
				},
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
			name: "create_artifact",
			description:
				"Create a rendered document the user can view: an HTML page, an SVG diagram, a markdown note, or a code file. Use for anything worth keeping or looking at, rather than pasting it into the reply.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string" },
					kind: {
						type: "string",
						enum: ["html", "svg", "markdown", "code"],
					},
					language: { type: "string" },
					content: { type: "string" },
				},
				required: ["title", "kind", "content"],
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
	thinkingMode: ThinkingMode,
	send: Send,
	requestId: string,
	attachments: ImageAttachment[],
): Promise<void> {
	const activeModel = await activeModelMetadata();
	const allowedNames = allowedToolNames(prompt);
	const requestTools: Array<Record<string, unknown>> = tools.filter((tool) =>
		allowedNames.has(tool.function.name),
	);
	/*
	 * Tools from enabled MCP servers join the same loop. Each definition is
	 * paid for out of the context window on every request, which is why this
	 * is gated per server rather than discovering everything reachable.
	 * A server that is down must not take the turn with it.
	 */
	for (const server of mcpServers.enabled()) {
		try {
			const session = await connectMcp(server, 5000);
			for (const tool of session.tools)
				requestTools.push(toOpenAiTool(server.id, tool));
		} catch (error) {
			console.warn(
				`MCP server ${server.name} unavailable:`,
				error instanceof Error ? error.message : error,
			);
		}
	}
	const seenToolCalls = new Set<string>();
	/*
	 * Entity cards surfaced by tools this turn. They attach to the answer
	 * rather than to the tool row: a tool call is a mechanism and belongs in
	 * its disclosure as raw JSON, while the cards ARE the reply.
	 */
	const answerCards: unknown[] = [];
	const messages: Array<Record<string, unknown>> = [
		{
			role: "system",
			// Enabled skills are appended so they bind for the whole turn.
			content:
				"You are RemindMe, a concise general and home assistant. Answer directly. Use tools only when needed. Confirm sensitive home actions." +
				skillPrompt(skills.enabled()),
		},
		{ role: "user", content: userContent(prompt, attachments) },
	];
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const phaseId = createPhaseId(requestId, iteration);
		send("phase_start", {
			phaseId,
			iteration,
			kind: thinkingMode === "fast" ? "answer" : "thinking",
			state: "active",
		});
		/* What this phase's tools fed back into the window. Reported on the
		 * phase so the running context total reflects it, not just the
		 * individual tool rows. */
		let phaseToolTokens = 0;
		const result = await streamModel(
			messages,
			thinkingMode,
			requestTools,
			send,
			phaseId,
			iteration,
			activeModel,
		);
		if (!result.toolCalls.length) {
			send("answer", {
				phaseId,
				iteration,
				text: result.text,
				cards: answerCards,
			});
			send("phase_complete", {
				phaseId,
				iteration,
				kind: "answer",
				state: "complete",
				metrics: result.metrics,
			});
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
			send("tool_start", {
				phaseId,
				iteration,
				kind: "tool",
				state: "active",
				name: call.function.name,
				arguments: args,
				metrics: result.metrics,
			});
			const callKey = toolCallKey(
				call.function.name,
				call.function.arguments || "{}",
			);
			const value: ToolResult = seenToolCalls.has(callKey)
				? { model: { error: "Duplicate tool call suppressed" } }
				: await executeTool(call.function.name, args);
			seenToolCalls.add(callKey);
			const serialized = JSON.stringify(value.model);
			if (Array.isArray(value.view)) answerCards.push(...value.view);
			// What this tool pushes back into the window, tracked separately from
			// the model's own output so context bloat is attributable per call.
			const resultTokens = estimateTokens(serialized);
			phaseToolTokens += resultTokens;
			const toolMetrics = {
				...result.metrics,
				toolResultTokens: resultTokens,
			};
			send("tool", {
				name: call.function.name,
				state: "complete",
				result: value.model,
			});
			send("tool_complete", {
				phaseId,
				iteration,
				kind: "tool",
				state: "complete",
				name: call.function.name,
				result: value.model,
				metrics: toolMetrics,
			});
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: serialized,
			});
		}
		send("phase_complete", {
			phaseId,
			iteration,
			kind: "tool",
			state: "complete",
			metrics: { ...result.metrics, toolResultTokens: phaseToolTokens },
		});
	}
	send("answer", {
		text: "I reached the tool-call limit before completing the request.",
	});
}

async function streamModel(
	messages: Array<Record<string, unknown>>,
	thinkingMode: ThinkingMode,
	requestTools: unknown[],
	send: Send,
	phaseId: string,
	iteration: number,
	activeModel: ActiveModelMetadata,
) {
	const started = Date.now();
	const thinkingProfile = getThinkingProfile(
		thinkingMode,
		os.totalmem(),
		Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
	);
	const requestBody: Record<string, unknown> = {
		model: config.localLlmModel,
		messages,
		stream: true,
		max_tokens: thinkingProfile.maxTokens,
		chat_template_kwargs: { enable_thinking: thinkingMode !== "fast" },
		reasoning_format: thinkingMode === "fast" ? "none" : "deepseek",
		reasoning: thinkingMode === "fast" ? "off" : "on",
		reasoning_budget: thinkingProfile.reasoningBudget,
	};
	if (requestTools.length) {
		requestBody.tools = requestTools;
		requestBody.tool_choice = "auto";
	}
	const response = await fetch(getLocalLlmUrl(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(requestBody),
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
	const thinkState = { active: false };
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
						reasoning?: string;
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
			const explicitReasoning = reasoningText(delta);
			const routed = explicitReasoning
				? {
						reasoning: explicitReasoning,
						answer: stripReasoningTags(delta.content || ""),
					}
				: routeThinkTags(delta.content || "", thinkState);
			if (routed.answer) {
				firstTokenAt ??= Date.now();
				text += routed.answer;
				send("token", { text: routed.answer });
				send("answer_delta", {
					phaseId,
					iteration,
					kind: "answer",
					text: routed.answer,
				});
			}
			if (routed.reasoning && thinkingMode !== "fast") {
				firstTokenAt ??= Date.now();
				thinking += routed.reasoning;
				send("thinking", { text: routed.reasoning });
				send("thinking_delta", {
					phaseId,
					iteration,
					kind: "thinking",
					text: routed.reasoning,
				});
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
		{ answer: text, thinking },
		activeModel,
	);
	send("metrics", {
		inputTokens: metrics.inputTokens,
		outputTokens: metrics.outputTokens,
		promptTokensPerSecond: metrics.encodeTokensPerSecond,
		generationTokensPerSecond: metrics.decodeTokensPerSecond,
		firstTokenMs: metrics.firstTokenMs,
		totalMs: metrics.totalMs,
		thinkingTokens: metrics.thinkingTokens,
	});
	send("phase_metrics", {
		phaseId,
		iteration,
		kind: toolCalls.length ? "tool" : "answer",
		metrics,
	});
	return { text, toolCalls: toolCalls.filter(Boolean), metrics };
}

function getLocalLlmUrl(): URL {
	try {
		const url = new URL(
			process.env.LOCAL_LLM_URL ||
				"http://homeassistant:8080/v1/chat/completions",
		);
		// Must match the allowlist in localLlm.ts — both gate the same endpoint.
		if (
			url.protocol !== "http:" ||
			!["homeassistant", "localhost", "127.0.0.1", "::1", "local-llama-cpp"].includes(
				url.hostname,
			)
		)
			throw new Error("LOCAL_LLM_URL must target the local model");
		return url;
	} catch (error) {
		console.error("Invalid LOCAL_LLM_URL:", error);
		throw new Error("Invalid LOCAL_LLM_URL");
	}
}

/**
 * Tool results are split in two: `model` is the trimmed payload that enters the
 * context window, `view` is the rich payload the UI renders as cards. Keeping
 * them separate is what stops an entity listing from eating the whole window.
 */
interface ToolResult {
	model: unknown;
	view?: unknown;
}

async function executeTool(
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const mcp = parseToolCallName(name);
	if (mcp) {
		const server = mcpServers.get(mcp.serverId);
		if (!server || !server.enabled)
			return { model: { error: "That MCP server is not enabled." } };
		try {
			return { model: await callMcpTool(server, mcp.tool, args) };
		} catch (error) {
			return {
				model: {
					error: error instanceof Error ? error.message : "MCP call failed",
				},
			};
		}
	}
	if (name === "get_entity_state") {
		const state = await hassRequest(
			`/states/${encodeURIComponent(String(args.entity_id))}`,
		);
		if (!state || typeof state !== "object" || !("entity_id" in state))
			return { model: state };
		const card = normalizeEntity(state as HassEntity);
		return { model: compactEntity(card), view: [card] };
	}
	if (name === "list_entities") {
		const states = await hassRequest("/states");
		if (!Array.isArray(states)) return { model: states };
		const cards = resolveEntities(
			states.map((item) => normalizeEntity(item as HassEntity)),
			{
				query: typeof args.query === "string" ? args.query : "",
				domain: typeof args.domain === "string" ? args.domain : "",
			},
		);
		if (!cards.length)
			return {
				model: {
					matches: [],
					hint: "No entity matched. Try a broader query or omit it.",
				},
			};
		return { model: cards.map(compactEntity), view: cards };
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
			return { model: { error: "Invalid entity action" } };
		const destructive = service === "unlock" || service === "open_cover";
		pendingActions.set(token, {
			domain,
			service,
			entityId,
			serviceData,
			destructive,
		});
		const confirmation = {
			confirmation_required: true,
			token,
			destructive,
			message: `Confirm ${domain}.${service} for ${entityId}`,
		};
		return { model: confirmation, view: confirmation };
	}
	if (name === "list_reminders") {
		const reminders = getReminders(process.env.OWNER_ID || "").map((item) => ({
			id: item.id,
			message: item.message,
			time: item.time.toISOString(),
		}));
		return { model: reminders, view: reminders };
	}
	if (name === "create_artifact") {
		const artifact = await artifacts.create({
			title: String(args.title || "Untitled"),
			kind: args.kind as never,
			language: args.language ? String(args.language) : undefined,
			content: String(args.content || ""),
		});
		/*
		 * The model gets a receipt, not the document. Echoing the content back
		 * would double its cost in a window it just spent writing it into.
		 */
		return {
			model: {
				created: true,
				id: artifact.id,
				title: artifact.title,
				kind: artifact.kind,
			},
			view: { artifact: { ...artifact, content: undefined } },
		};
	}
	if (name === "web_search") {
		const results = await exaSearch(String(args.query));
		return { model: results };
	}
	return { model: { error: `Unknown tool: ${name}` } };
}

type ManagedActiveModel = {
	id: string;
	family: string;
	file: string;
	quantization: string;
	recommendedContext: number;
	capabilities: string[];
};

async function managedActiveModel(): Promise<ManagedActiveModel | undefined> {
	if (process.env.MODEL_MANAGER_ENABLED !== "true") return undefined;
	try {
		const status = await (await getModelManagerClient()).request<{
			activeModel?: ManagedActiveModel;
		}>("/status", {
			signal: AbortSignal.timeout(2_000),
		});
		return status.activeModel;
	} catch {
		return undefined;
	}
}

/**
 * Identify the model actually serving requests.
 *
 * The model manager is optional — when it is disabled, or reachable but not
 * managing this endpoint, inference still runs against LOCAL_LLM_URL with
 * LOCAL_LLM_MODEL. Reporting "runtime unavailable" in that case was wrong:
 * it described the manager, not the runtime. Fall back to the configured
 * model, which is what the requests are actually sent with.
 */
async function activeModelMetadata(): Promise<ActiveModelMetadata> {
	const active = await managedActiveModel();
	if (active)
		return {
			modelId: active.id,
			modelName: `${active.family} ${active.quantization}`.trim(),
		};
	const configured = config.localLlmModel;
	return configured
		? { modelId: configured, modelName: configured }
		: { modelId: "runtime-unavailable", modelName: "Runtime unavailable" };
}

let modelManagerClientPromise: Promise<ModelManagerClient> | undefined;

type ModelSelectionBody = {
	id: string;
	context?: number;
	override?: boolean;
};

function modelSelectionBody(value: unknown): ModelSelectionBody | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const id = typeof input.id === "string" ? input.id.trim() : "";
	if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(id)) return undefined;
	const result: ModelSelectionBody = { id };
	if (input.context !== undefined) {
		const context = Number(input.context);
		if (!Number.isInteger(context) || context < 1024 || context > 131072)
			return undefined;
		result.context = context;
	}
	if (input.override !== undefined) result.override = input.override === true;
	return result;
}

function safeModelError(code: string, message: string, retryable = false) {
	return { code, message, retryable };
}

function managerTokenPath(): string {
	return process.env.MODEL_MANAGER_TOKEN_PATH || "/data/model-manager-token";
}

function modelManagerUrl(): string {
	return (
		process.env.MODEL_MANAGER_URL ||
		deriveManagerUrl(getLocalLlmUrl().toString())
	);
}

async function getModelManagerClient(): Promise<ModelManagerClient> {
	if (process.env.MODEL_MANAGER_ENABLED !== "true")
		throw new ModelManagerError(
			"manager_disabled",
			"Local model management is disabled.",
			503,
		);
	if (!(await managerPairingConfigured(managerTokenPath())))
		throw new ModelManagerError(
			"manager_unpaired",
			"Pair RemindMe with the local model manager first.",
			401,
		);
	if (!modelManagerClientPromise) {
		try {
			modelManagerClientPromise = Promise.resolve(
				new ModelManagerClient(modelManagerUrl(), () =>
					readManagerToken(managerTokenPath()),
				),
			);
		} catch (error) {
			/*
			 * The endpoint allowlist rejected the configured URL. That is a
			 * configuration fault, not a transport one — reporting it as
			 * "unavailable" sends you looking for a network problem that is
			 * not there.
			 */
			throw new ModelManagerError(
				"manager_misconfigured",
				error instanceof Error ? error.message : "Manager endpoint is invalid.",
				500,
				false,
				`MODEL_MANAGER_URL=${process.env.MODEL_MANAGER_URL ?? "(unset)"}`,
			);
		}
	}
	return modelManagerClientPromise;
}

async function proxyModelManager(
	response: Response,
	path: string,
	method = "GET",
	body?: unknown,
) {
	try {
		const result = await (await getModelManagerClient()).request<unknown>(
			path,
			{
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		if (method === "DELETE") response.status(204).end();
		else response.json(result);
	} catch (error) {
		await forgetRejectedPairing(error);
		sendModelManagerError(response, error);
	}
}

/**
 * A 401 from the manager means the stored token is dead, not that the request
 * was malformed. Drop it so the Models tab falls back to the pairing form and
 * the user can recover with a fresh code.
 */
async function forgetRejectedPairing(error: unknown): Promise<void> {
	if (!(error instanceof ModelManagerError) || error.status !== 401) return;
	if (error.code === "manager_unpaired" || error.code === "manager_disabled")
		return;
	await invalidateManagerToken(managerTokenPath());
	modelManagerClientPromise = undefined;
	console.warn(
		"Model manager rejected the stored token; pairing cleared so it can be re-established.",
	);
}

function sendModelManagerError(response: Response, error: unknown) {
	if (error instanceof ModelManagerError) {
		response.status(error.status).json({
			...safeModelError(error.code, error.message, error.retryable),
			// errno/hostname only — no token, no user data.
			detail: error.detail,
		});
		return;
	}
	// Anything else is a bug rather than a transport fault; say so, and log it
	// instead of pretending the manager is merely unavailable.
	console.error("Model manager request failed unexpectedly:", error);
	response
		.status(503)
		.json(
			safeModelError(
				"manager_unavailable",
				"Local model manager is unavailable.",
				true,
			),
		);
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

/*
 * Revalidate every asset on every load.
 *
 * express.static sends ETag and Last-Modified but no Cache-Control, so
 * browsers fall back to heuristic freshness and can keep serving an old
 * app.js against freshly updated HTML. The result is a half-updated console
 * where the markup calls methods the cached script does not have — every
 * handler on the page fails at once. ETags still make this cheap: unchanged
 * files answer 304.
 */
app.use(
	express.static(resolve(process.cwd(), "public"), {
		etag: true,
		lastModified: true,
		setHeaders: (response) =>
			response.setHeader("Cache-Control", "no-cache, must-revalidate"),
	}),
);
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
