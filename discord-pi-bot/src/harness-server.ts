import "dotenv/config";
import express, { type Express, type Response } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { resolve } from "node:path";
import { config } from "./config";
import {
	addReminder,
	deleteReminder,
	listReminders,
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
import {
	fitHistory,
	validateHistory,
	type HistoryTurn,
} from "./harness/history";
import { measureTokenUsage, tokenizerUrl } from "./harness/tokenizer";
import { normalizeEntity, type HassEntity } from "./harness/entities";
import { compactEntity, resolveEntities } from "./harness/entityResolver";
import {
	validateEntityAction,
	type EntityAction,
} from "./harness/entityActions";
import { ConversationStore } from "./harness/conversations";
import { SkillStore, skillPrompt } from "./harness/skills";
import { DEFAULT_PERSONA, PersonaStore } from "./harness/persona";
import { VaultStore, type VaultNote } from "./harness/vault";
import {
	TaskStore,
	describeSchedule,
	extractSchedule,
	parseSchedule,
	type ScheduledTask,
} from "./harness/taskStore";
import { readSystemStats } from "./harness/systemStats";
import { ArtifactStore, toDocument } from "./harness/artifacts";
import { applyEdit, isEditFailure, modelView } from "./harness/artifactEdit";
import { partialStringField } from "./harness/streamingJson";
import { EndpointStore, validateEndpointUrl } from "./harness/endpoints";
import { readablePage, ReaderError } from "./harness/reader";
import { parseReminder, describeWhen } from "./harness/reminderParser";
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

import {
	allowedToolNames,
	detectPositiveFeedback,
	toolCallKey,
} from "./harness/intentRouting";
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
const pendingReminders = new Map<string, { message: string; at: string }>();
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
const conversations = new ConversationStore();
void conversations.load();
const skills = new SkillStore();
void skills.load();
const artifacts = new ArtifactStore();
void artifacts.load();
const mcpServers = new McpServerStore();
void mcpServers.load();
const endpoints = new EndpointStore();
void endpoints.load();
/*
 * The Markdown vault at /share/vault, doubling as the model's editable
 * long-term memory. The companion remindme-vault add-on edits the very same
 * files, so a note is one note across the model, the chat, and that editor.
 * Parsed once at boot into an in-memory index; a note the model writes
 * reindexes itself. Notes edited externally are picked up by POST
 * /api/vault/reload — a full reparse is too heavy to run on every read on a Pi,
 * and cross-platform fs.watch is the same unreliable story that made the
 * reminder store poll instead.
 */
const vault = new VaultStore();
void vault.load();
/*
 * Scheduled tasks — standing prompts the harness runs on a cadence. The store
 * and the runner both live here because this process holds the model, the
 * tools, and the vault; only the ping half of delivery crosses back to the bot,
 * as an ordinary one-shot reminder.
 */
const tasks = new TaskStore();
void tasks.load();
/* The editable base system prompt. Persisted so an edit survives restarts; the
 * capability instructions are always appended on top of it. */
const persona = new PersonaStore();
void persona.load();
type Send = (event: string, data: unknown) => void;

/** A filesystem- and link-safe slug from a title. */
function slug(text: string): string {
	return (
		String(text || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}

/**
 * Build the frontmatter patch from a save request. Only supplied fields are
 * returned, so a save that names a body but not tags leaves the note's tags
 * where they were — `VaultStore.write` merges the patch onto what exists.
 */
function noteFrontmatter(
	body: Record<string, unknown> | undefined,
): Record<string, string | string[]> {
	const patch: Record<string, string | string[]> = {};
	if (typeof body?.title === "string" && body.title.trim())
		patch.title = body.title.trim();
	if (typeof body?.type === "string" && body.type.trim())
		patch.type = body.type.trim();
	if (Array.isArray(body?.tags))
		patch.tags = body.tags.map((tag) => String(tag).replace(/^#/, "")).filter(Boolean);
	else if (typeof body?.tags === "string" && body.tags.trim())
		patch.tags = body.tags
			.split(",")
			.map((tag) => tag.trim().replace(/^#/, ""))
			.filter(Boolean);
	return patch;
}

/*
 * The model's curated long-term memory lives in its own folder, sorted by kind,
 * so recall and the /memory view stay focused — the rest of the vault (task
 * reports, journal, project notes) is still reachable by search, just not
 * auto-surfaced. write_memory files here regardless of the path the model gives.
 */
const MEMORY_DIR = "memory";
const MEMORY_KINDS = ["user", "feedback", "project", "reference"];

/** Normalise a write_memory path to `memory/<kind>/<slug>`, kind-sorted. */
function memoryNotePath(rawPath: unknown, type: unknown): string {
	const segments = String(rawPath || "")
		.trim()
		.replace(/\.md$/i, "")
		.replace(/^\/+/, "")
		.replace(new RegExp(`^${MEMORY_DIR}/`, "i"), "")
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
	// Ensure a kind subfolder: honour one the model already used, else the type.
	if (!MEMORY_KINDS.includes(segments[0])) {
		const kind = MEMORY_KINDS.includes(String(type)) ? String(type) : "";
		if (kind) segments.unshift(kind);
	}
	if (!segments.length) segments.push("note");
	return `${MEMORY_DIR}/${segments.join("/")}`;
}

/** A note trimmed to what a list or a tool receipt needs — never the full body. */
function summariseNote(note: VaultNote) {
	return {
		path: note.path,
		title: note.title,
		type: note.type,
		tags: note.tags,
		links: note.links.length,
		backlinks: 0,
		updatedAt: note.updatedAt,
		snippet: note.body.replace(/\s+/g, " ").trim().slice(0, 160),
	};
}

/** The endpoint every request resolves against, custom or the local default. */
function resolveEndpoint() {
	return endpoints.resolve({
		url: process.env.LOCAL_LLM_URL || "http://homeassistant:8080/v1/chat/completions",
		model: config.localLlmModel,
	});
}

/*
 * A chat request carries the conversation so far, and a transcript with a
 * couple of code answers in it clears 64kb without being remarkable. The
 * ceiling still has to exist — this is a Pi, and the window is 8k tokens,
 * so anything past a few hundred kb is a client fault rather than a long
 * conversation. Oversized history is trimmed to the window on arrival;
 * this only bounds what the parser will hold in memory to do it.
 */
app.use(express.json({ limit: "2mb" }));
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
/* Inference endpoints: the switchable list of where the model runs. */
app.get("/api/endpoints", (_request, response) => {
	response.json(endpoints.config());
});
app.post("/api/endpoints", async (request, response) => {
	try {
		response.status(201).json(await endpoints.create(request.body || {}));
	} catch (error) {
		response.status(400).json({
			error: error instanceof Error ? error.message : "Invalid endpoint",
		});
	}
});
app.patch("/api/endpoints/:id", async (request, response) => {
	try {
		const updated = await endpoints.update(request.params.id, request.body || {});
		if (!updated) return response.status(404).json({ error: "Not found" });
		response.json(updated);
	} catch (error) {
		response.status(400).json({
			error: error instanceof Error ? error.message : "Invalid endpoint",
		});
	}
});
app.delete("/api/endpoints/:id", async (request, response) => {
	response.status((await endpoints.delete(request.params.id)) ? 204 : 404).end();
});
/* Empty id in the body restores the local default. */
app.post("/api/endpoints/active", async (request, response) => {
	const id = typeof request.body?.id === "string" ? request.body.id : "";
	if (!(await endpoints.setActive(id)))
		return response.status(404).json({ error: "No such endpoint" });
	response.json(endpoints.config());
});
/*
 * A one-message round trip to prove an endpoint answers before it is
 * trusted with a turn. Tests the record as saved, including its key, so a
 * bad URL or a rejected key is caught here rather than mid-conversation.
 */
app.post("/api/endpoints/:id/test", async (request, response) => {
	const endpoint = endpoints.get(request.params.id);
	if (!endpoint) return response.status(404).json({ error: "Not found" });
	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
		const probe = await fetch(new URL(endpoint.url), {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: endpoint.model,
				messages: [{ role: "user", content: "Reply with the single word: ok" }],
				max_tokens: 5,
				stream: false,
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!probe.ok) {
			const detail = (await probe.text()).slice(0, 200);
			return response.status(502).json({
				ok: false,
				error: `HTTP ${probe.status}: ${detail}`,
			});
		}
		const data = (await probe.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const reply = data.choices?.[0]?.message?.content;
		response.json({
			ok: true,
			reply: typeof reply === "string" ? reply.slice(0, 120) : "(no text)",
		});
	} catch (error) {
		response.status(502).json({
			ok: false,
			error: error instanceof Error ? error.message : "Could not reach endpoint",
		});
	}
});
/* The editable base system prompt. GET returns the prompt in effect plus the
 * default (for a reset); PUT sets it, and an empty value resets to the default. */
app.get("/api/persona", (_request, response) => {
	response.json({
		prompt: persona.get(),
		default: DEFAULT_PERSONA,
		custom: persona.isCustom(),
	});
});
app.put("/api/persona", async (request, response) => {
	await persona.set(String(request.body?.prompt ?? ""));
	response.json({
		prompt: persona.get(),
		default: DEFAULT_PERSONA,
		custom: persona.isCustom(),
	});
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
/*
 * Vault / memory. Note paths carry slashes, so they travel as a `path` query
 * parameter rather than a route segment. Reads serve the in-memory index;
 * writes go straight to disk and reindex, so a note the console saves is a
 * note the remindme-vault add-on opens.
 */
app.get("/api/vault", (request, response) => {
	const notes = vault.list({
		tag: request.query.tag ? String(request.query.tag) : undefined,
		type: request.query.type ? String(request.query.type) : undefined,
		search: request.query.search ? String(request.query.search) : undefined,
	});
	response.json(notes.map(summariseNote));
});
app.get("/api/vault/tags", (_request, response) => {
	response.json(vault.tags());
});
app.get("/api/vault/graph", (request, response) => {
	response.json(vault.graph({ includeTags: request.query.tags === "1" }));
});
app.get("/api/vault/related", (request, response) => {
	const related = vault.related(String(request.query.path || ""));
	response.json({
		backlinks: related.backlinks.map(summariseNote),
		byTag: related.byTag.map(summariseNote),
	});
});
app.get("/api/vault/note", (request, response) => {
	const note = vault.get(String(request.query.path || ""));
	response.status(note ? 200 : 404).json(note || { error: "Note not found" });
});
app.put("/api/vault/note", async (request, response) => {
	const path = String(request.body?.path || "").trim();
	if (!path)
		return response.status(400).json({ error: "A note path is required." });
	try {
		const note = await vault.write(path, {
			body: typeof request.body?.body === "string" ? request.body.body : undefined,
			frontmatter: noteFrontmatter(request.body),
		});
		response.json(note);
	} catch (error) {
		response
			.status(400)
			.json({ error: error instanceof Error ? error.message : "Write failed" });
	}
});
app.delete("/api/vault/note", async (request, response) => {
	const removed = await vault.delete(String(request.query.path || ""));
	response.status(removed ? 204 : 404).end();
});
/* Reparse the whole vault — used after remindme-vault edits it from outside. */
app.post("/api/vault/reload", async (_request, response) => {
	await vault.load();
	response.json({ notes: vault.list().length });
});
/*
 * Scheduled tasks. Create accepts either a structured body or free text — the
 * /task console command sends the latter, "every day at 8 recap yesterday",
 * and the cadence is parsed out here.
 */
app.get("/api/tasks", (_request, response) => {
	response.json(
		tasks.list().map((task) => ({ ...task, scheduleText: describeSchedule(task.schedule) })),
	);
});
app.post("/api/tasks", async (request, response) => {
	const body = request.body || {};
	let name = typeof body.name === "string" ? body.name.trim() : "";
	let prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	let schedule =
		body.schedule && typeof body.schedule === "object" && "kind" in body.schedule
			? body.schedule
			: undefined;
	if (typeof body.text === "string" && body.text.trim()) {
		const parsed = extractSchedule(body.text);
		schedule = schedule || parsed.schedule;
		prompt = prompt || parsed.rest;
	}
	if (!schedule) {
		return response.status(400).json({
			error:
				"No schedule found. Say when, e.g. 'daily at 8', 'every 6 hours', or 'mondays at 9'.",
		});
	}
	if (!prompt) {
		return response
			.status(400)
			.json({ error: "The task needs something to do." });
	}
	if (!name) name = prompt.split(/\s+/).slice(0, 6).join(" ");
	const task = await tasks.create({
		name,
		prompt,
		schedule,
		deliver: Array.isArray(body.deliver) ? body.deliver : undefined,
		channelId: typeof body.channelId === "string" ? body.channelId : undefined,
	});
	response.status(201).json({ ...task, scheduleText: describeSchedule(task.schedule) });
});
app.patch("/api/tasks/:id", async (request, response) => {
	const body = request.body || {};
	// Accept a cadence given as free text as well as a structured object.
	if (typeof body.scheduleText === "string" && body.scheduleText.trim()) {
		const parsed = parseSchedule(body.scheduleText);
		if (parsed) body.schedule = parsed;
	}
	const updated = await tasks.update(request.params.id, body);
	response
		.status(updated ? 200 : 404)
		.json(
			updated
				? { ...updated, scheduleText: describeSchedule(updated.schedule) }
				: { error: "Task not found" },
		);
});
app.delete("/api/tasks/:id", async (request, response) => {
	response.status((await tasks.delete(request.params.id)) ? 204 : 404).end();
});
/*
 * Run a task now, outside its schedule — the "does this actually work" button.
 * It does not disturb the next scheduled fire.
 */
app.post("/api/tasks/:id/run", async (request, response) => {
	const task = tasks.get(request.params.id);
	if (!task) return response.status(404).json({ error: "Task not found" });
	const outcome = await runTaskNow(task);
	// A manual run records its result but leaves the cadence untouched.
	await tasks.recordRun(task.id, { ...outcome, reschedule: false });
	response.json(outcome);
});
/* Tool catalogue for the /tools command — names, descriptions and parameter
 * keys only, so the UI can list capabilities without restating the schema. */
/* Host telemetry for the rail. Polled, so it is deliberately cheap: reading
 * one sysfs file and differencing CPU counters. */
/*
 * Promote content the console already has into an artifact, with no model
 * turn involved.
 *
 * A 1.7B model will not reliably call a tool for "render that as an
 * artifact", and "that" usually refers to a code block already pushed out of
 * a 4-8k window. The transcript still holds it, so the /artifact command
 * lifts the last block straight from there.
 */
app.post("/api/artifacts", async (request, response) => {
	const content = String(request.body?.content || "");
	if (!content.trim())
		return response.status(400).json({ error: "Nothing to put in an artifact" });
	const artifact = await artifacts.create({
		title: String(request.body?.title || "Untitled"),
		kind: request.body?.kind as never,
		language: request.body?.language ? String(request.body.language) : undefined,
		content,
	});
	response.status(201).json({ ...artifact, content: undefined });
});
app.get("/api/artifacts", (_request, response) => {
	response.json(artifacts.list());
});
app.get("/api/artifacts/:id", (request, response) => {
	const artifact = artifacts.get(request.params.id);
	response.status(artifact ? 200 : 404).json(artifact || { error: "Not found" });
});
/*
 * Editing by hand, from the console's source view. The model reaches the
 * same store through edit_artifact and rewrite_artifact; this is the other
 * half of that, so a shader can be nudged a constant at a time without
 * asking a 1.7B to find the line.
 */
app.patch("/api/artifacts/:id", async (request, response) => {
	const content = request.body?.content;
	const title = request.body?.title;
	if (typeof content !== "string" && typeof title !== "string") {
		response.status(400).json({ error: "content or title is required" });
		return;
	}
	const updated = await artifacts.update(request.params.id, {
		...(typeof content === "string" ? { content } : {}),
		...(typeof title === "string" ? { title } : {}),
	});
	if (!updated) {
		response.status(404).json({ error: "Not found" });
		return;
	}
	response.json(updated);
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
/*
 * The Lua interpreter compiles through the Function constructor, so its
 * document needs 'unsafe-eval' where the others do not. This is a smaller
 * grant than it reads as: the frame already runs whatever inline script
 * the model wrote, in an opaque origin with no network, so eval adds no
 * capability it did not already have — the sandbox, not the eval ban, is
 * what contains it. The grant is scoped to the one kind that needs it so
 * an HTML artifact stays on the strict policy.
 */
const SCRIPT_EVAL_KINDS = new Set(["lua"]);
function artifactCsp(kind: string): string {
	const script = SCRIPT_EVAL_KINDS.has(kind)
		? "script-src 'unsafe-inline' 'unsafe-eval'"
		: "script-src 'unsafe-inline'";
	return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; ${script}; frame-ancestors 'self'`;
}
app.get("/api/artifacts/:id/document", (request, response) => {
	const artifact = artifacts.get(request.params.id);
	if (!artifact || !toDocument(artifact))
		return response.status(404).type("text/plain").send("Not found");
	response
		.status(200)
		.set({
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": artifactCsp(artifact.kind),
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
		})
		.send(toDocument(artifact));
});
app.get("/api/system", async (_request, response) => {
	response.set("Cache-Control", "no-store").json(await readSystemStats());
});
/*
 * Reader mode: fetch a page and return its readable text for the console to
 * render in the artifact panel. Fetching arbitrary URLs is an SSRF risk, so
 * readablePage refuses anything resolving to a non-public address — a bad
 * URL is a 400 with a reason, an unexpected failure a 502.
 */
app.get("/api/reader", async (request, response) => {
	const target = String(request.query.url || "");
	if (!target)
		return response.status(400).json({ error: "A url query parameter is required." });
	try {
		const page = await readablePage(target);
		response.set("Cache-Control", "no-store").json(page);
	} catch (error) {
		if (error instanceof ReaderError)
			return response.status(400).json({ error: error.message });
		console.error("Reader failed:", error);
		response.status(502).json({ error: "The page could not be fetched." });
	}
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
	/*
	 * Exact counts come from llama.cpp's /tokenize, which a custom or
	 * OpenAI-style endpoint does not offer. When one is active, say the
	 * count is inexact and let the client fall back to its estimate rather
	 * than tokenising against the wrong model.
	 */
	if (endpoints.active()) {
		response.json({ exact: false });
		return;
	}
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
app.post("/api/models/activate", async (request, response) => {
	const body = modelSelectionBody(request.body);
	if (!body)
		return response
			.status(400)
			.json(safeModelError("invalid_model", "Model selection is invalid."));
	await proxyModelManager(response, "/activate", "POST", body);
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
app.get("/api/reminders", async (_request, response) => {
	const reminders = await listReminders(process.env.OWNER_ID || "");
	response.json(
		reminders.map((item) => ({
			id: item.id,
			message: item.message,
			time: item.time.toISOString(),
		})),
	);
});
app.delete("/api/reminders/:id", async (_request, response) => {
	const deleted = await deleteReminder(
		_request.params.id,
		process.env.OWNER_ID || "",
	);
	response.status(deleted ? 204 : 404).end();
});
app.get("/api/status", async (_request, response) => {
	/*
	 * A custom endpoint runs its own model, so the local model manager's
	 * view does not apply — the badge and profiles come from the endpoint
	 * instead. The manager is only consulted when inference is local.
	 */
	const activeEndpoint = endpoints.active();
	const managed = activeEndpoint ? undefined : await managedActiveModel();
	const contextSize =
		managed?.recommendedContext ||
		Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192);
	response.set("Cache-Control", "no-store").json({
		instanceId,
		model: activeEndpoint?.model || managed?.id || config.localLlmModel || "runtime-unavailable",
		modelName: activeEndpoint
			? `${activeEndpoint.name} · ${activeEndpoint.model}`
			: managed
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
		/* The companion remindme-vault editor's URL, if configured — lets the
		 * console deep-link a note into that add-on. Empty means no link shown. */
		vaultUrl: process.env.VAULT_UI_URL || "",
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
	const reminder = pendingReminders.get(token);
	if (reminder) {
		pendingReminders.delete(token);
		/*
		 * The manager schedules by delay, so the absolute time is converted
		 * here. Delivery is the bot process's job — it owns the Discord client
		 * and the notify target — so this hands off rather than duplicating it.
		 */
		const delayMinutes = Math.max(
			0,
			(new Date(reminder.at).getTime() - Date.now()) / 60_000,
		);
		const created = await addReminder(
			reminder.message,
			delayMinutes,
			process.env.OWNER_ID || "",
			"",
		);
		response.json({
			scheduled: true,
			id: created?.id,
			message: reminder.message,
			at: reminder.at,
		});
		return;
	}
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
			validateHistory(request.body?.history),
			// Which document is on the bench, so edits have a default target.
			typeof request.body?.artifactId === "string"
				? request.body.artifactId
				: "",
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
			name: "create_reminder",
			description:
				"Schedule a reminder. Pass the user's own wording, including the time — 'check the mail at 5' — and it is parsed here. Always confirmed before it is set.",
			parameters: {
				type: "object",
				properties: {
					request: {
						type: "string",
						description: "The reminder in the user's words, with its timing.",
					},
				},
				required: ["request"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "create_artifact",
			description:
				"Create a rendered document the user can view: an HTML page, an SVG diagram, a markdown note, a code file, or a shader that runs on the viewer's GPU. Use for anything worth keeping or looking at, rather than pasting it into the reply.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string" },
					kind: {
						type: "string",
						enum: ["html", "svg", "markdown", "code", "glsl", "wgsl", "three", "lua"],
						description:
							"Use three for a 3D scene: write only scene code against the supplied THREE, scene, camera and renderer, and optionally define update(delta, elapsed) to animate — do not create a renderer or a resize handler. Use lua for a Lua program; print() writes to the frame. Use glsl for a WebGL2 fragment shader: write either a Shadertoy-style 'void mainImage(out vec4 fragColor, in vec2 fragCoord)' or a plain 'void main()'. iResolution, iTime, iTimeDelta, iFrame and iMouse are declared for you; do not write a #version line. Use wgsl for a WebGPU shader: define '@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f'. The vertex stage and a uniform block 'U' with resolution, time, timeDelta, mouse and frame are supplied.",
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
			name: "read_artifact",
			description:
				"Read the current content of an artifact. Use before editing when you are unsure what the document says now.",
			parameters: {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "rewrite_artifact",
			description:
				"Replace the entire content of an existing artifact with a new version. Use when the change affects most of the document, or when you cannot quote the exact text to replace.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string" },
					content: {
						type: "string",
						description: "The complete new document, not a fragment.",
					},
				},
				required: ["id", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "edit_artifact",
			description:
				"Change a small part of an existing artifact by quoting the exact text to replace. Use rewrite_artifact instead when replacing most of the document. Returns the document as it stands after the edit.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string" },
					old_string: {
						type: "string",
						description:
							"The exact text to find, copied character for character including indentation. Must appear exactly once unless replace_all is set.",
					},
					new_string: {
						type: "string",
						description: "The replacement text. Use an empty string to delete.",
					},
					replace_all: {
						type: "boolean",
						description: "Replace every occurrence rather than requiring one.",
					},
				},
				required: ["id", "old_string", "new_string"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "web_search",
			description:
				"Search the public web for current information and return the top results.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_memory",
			description:
				"Search your whole notes vault — your curated long-term memory under memory/ plus every other note (task reports, journal, project notes). Use it to find anything saved before. Returns matching titles and paths, not full text.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Words to look for in title or body." },
					tag: { type: "string", description: "Restrict to notes with this tag." },
					type: {
						type: "string",
						enum: ["user", "feedback", "project", "reference"],
						description: "Restrict to one kind of memory.",
					},
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_memory",
			description:
				"Read the full text of one memory note by its path, taken from search_memory. Returns the body plus its links and backlinks.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_memory",
			description:
				"Save or update a long-term memory. Use it to remember a durable fact, a preference, a project detail, or a reference — not this turn's chatter. Memories are filed automatically under the memory/ folder, sorted by type, and tagged #memory. Reuse an existing path to update that note; link related notes with [[Note Title]] in the body and classify with type and tags.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description:
							"Short kebab-case name without extension, e.g. preferences or coffee-order. Filed under memory/<type>/ for you; reuse the same name to update.",
					},
					title: { type: "string" },
					type: {
						type: "string",
						enum: ["user", "feedback", "project", "reference"],
					},
					tags: {
						type: "array",
						items: { type: "string" },
						description: "Topic tags without the leading #.",
					},
					body: {
						type: "string",
						description: "The note's Markdown. Link others with [[Title]].",
					},
				},
				required: ["path", "body"],
			},
		},
	},
];

/*
 * An image is worth far more tokens than its base64 length suggests, and
 * the projector's real cost is not visible from here. This is a deliberate
 * over-estimate: spending history on a miscounted image is the failure
 * that ends the turn with an HTTP 500.
 */
const IMAGE_TOKEN_ALLOWANCE = 1024;

/*
 * Headroom for what grows after this sum is taken: the chat template's
 * own scaffolding, and the tool calls and tool results the agent loop
 * appends to `messages` as the turn proceeds.
 */
const CONTEXT_SAFETY_MARGIN = 512;

/**
 * What is left of the context window for prior turns once everything
 * mandatory has been paid for — including the reply the model has not
 * written yet, which is the part that is easy to forget and the part
 * that truncates the answer when it is missed.
 */
function historyBudget(
	prompt: string,
	systemPrompt: string,
	requestTools: unknown[],
	attachments: ImageAttachment[],
	thinkingMode: ThinkingMode,
): number {
	const contextSize = Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192);
	const profile = getThinkingProfile(thinkingMode, os.totalmem(), contextSize);
	const reserved =
		estimateTokens(systemPrompt) +
		estimateTokens(prompt) +
		estimateTokens(requestTools.length ? JSON.stringify(requestTools) : "") +
		attachments.length * IMAGE_TOKEN_ALLOWANCE +
		profile.maxTokens +
		CONTEXT_SAFETY_MARGIN;
	return Math.max(0, contextSize - reserved);
}

async function runAgent(
	prompt: string,
	thinkingMode: ThinkingMode,
	send: Send,
	requestId: string,
	attachments: ImageAttachment[],
	history: HistoryTurn[] = [],
	openArtifactId = "",
): Promise<void> {
	const activeModel = await activeModelMetadata();
	const openArtifact = openArtifactId ? artifacts.get(openArtifactId) : undefined;
	const allowedNames = allowedToolNames(prompt, {
		hasArtifact: Boolean(openArtifact),
	});
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
	/*
	 * Naming the open document is what makes an edit possible: the model
	 * cannot quote an id it was never told, and "change the footer" carries
	 * no id of its own. The content stays out — it is on screen already,
	 * and read_artifact fetches it when the model actually needs to see it.
	 */
	const artifactPrompt = openArtifact
		? ` The document "${openArtifact.title}" (id ${openArtifact.id}, ${openArtifact.kind}) is open. For a small change use edit_artifact with that id, quoting the exact text to replace. For a change affecting most of the document, or when you cannot quote the existing text exactly, use rewrite_artifact with the complete new document. Use read_artifact first if you need to see its current state.`
		: "";
	/*
	 * Long-term memory: the vault the model shares with the remindme-vault
	 * editor. Notes touching this turn's prompt are surfaced up front so the
	 * model recalls without a tool round-trip; it can still write_memory to
	 * save durable facts and read_memory for a note's full text. Injected into
	 * the system prompt, so historyBudget already pays for its tokens.
	 */
	const recalled = vault.recall(prompt, 5);
	const memoryPrompt = recalled.length
		? "\n\nFrom your long-term memory (shared notes vault). Treat as things you already know; use read_memory for a note's full text before relying on specifics:\n" +
			recalled
				.map((note) => {
					const tags = note.tags.length
						? ` [${note.tags.map((tag) => `#${tag}`).join(" ")}]`
						: "";
					const snippet = note.body.replace(/\s+/g, " ").trim().slice(0, 140);
					return `- ${note.title} (${note.path})${tags}: ${snippet}`;
				})
				.join("\n")
		: "";
	/*
	 * When the user just signals that the last thing worked, that is the moment
	 * to learn from it: save the reusable lesson so the next conversation starts
	 * ahead. Only on short acknowledgements, and only with something to look back
	 * on — the prior turn is what holds what worked.
	 */
	const learningPrompt =
		history.length > 0 && detectPositiveFeedback(prompt)
			? "\n\nThe user is confirming the previous approach worked. If the exchange above holds a durable, reusable lesson — a fix that worked, a method, a confirmed preference — call write_memory with type feedback to save it: a short kebab name, a clear title, and a body stating what worked and why (link related notes with [[Title]]). It is filed under memory/feedback/ for you. Then acknowledge in one short line. If nothing is durable enough to keep, just acknowledge."
			: "";
	/*
	 * The persona (voice + standing rules) is user-editable in Settings; the
	 * capability line is always appended, so editing the persona can never
	 * strip the model's memory or tools. Skills bind for the whole turn.
	 */
	const systemPrompt =
		persona.get() +
		" You have a long-term memory kept in the memory/ folder of your notes vault: write_memory saves durable facts, preferences, and project details there to carry across conversations; search_memory searches the whole vault (memory plus everything else) and read_memory reads any note." +
		artifactPrompt +
		memoryPrompt +
		learningPrompt +
		skillPrompt(skills.enabled());
	const budget = historyBudget(
		prompt,
		systemPrompt,
		requestTools,
		attachments,
		thinkingMode,
	);
	const messages: Array<Record<string, unknown>> = [
		{ role: "system", content: systemPrompt },
		...fitHistory(history, budget),
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
				/*
				 * Card data travels beside the model's receipt rather than
				 * inside it. Only array views were being forwarded, so an
				 * artifact the model wrote produced no card and could not be
				 * opened — the document existed and nothing pointed at it.
				 */
				view: Array.isArray(value.view) ? undefined : value.view,
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

/**
 * Push a document to the pane while the model is still writing it.
 *
 * `create_artifact` carries its whole document in one tool-call argument,
 * which does not become valid JSON until the closing brace — minutes after
 * the first tag at a Pi's decode rate. Reading the field out of the partial
 * text means the console can show the write as it happens instead of
 * staring at a spinner and then producing a finished page from nowhere.
 *
 * This is a preview, not a commitment. Nothing is stored until the tool
 * actually runs, and the pane swaps the draft for the saved artifact when
 * its receipt arrives.
 */
function streamArtifactPreview(
	call: ToolCall,
	emitted: Map<string, number>,
	send: Send,
): void {
	if (call.function.name !== "create_artifact") return;
	const args = call.function.arguments;
	const content = partialStringField(args, "content");
	if (!content) return;
	if (!emitted.has(call.id)) {
		const title = partialStringField(args, "title");
		const kind = partialStringField(args, "kind");
		emitted.set(call.id, 0);
		send("artifact_draft", {
			id: call.id,
			// The header fields normally land first, but the schema does not
			// oblige the model to emit them in order, so neither is required.
			title: title?.complete ? title.value : "Writing…",
			kind: kind?.complete ? kind.value : "code",
		});
	}
	const already = emitted.get(call.id) || 0;
	if (content.value.length <= already) return;
	send("artifact_delta", {
		id: call.id,
		text: content.value.slice(already),
	});
	emitted.set(call.id, content.value.length);
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
	const endpoint = resolveEndpoint();
	const requestBody: Record<string, unknown> = {
		model: endpoint.model,
		messages,
		stream: true,
		max_tokens: thinkingProfile.maxTokens,
	};
	/*
	 * The reasoning controls are llama.cpp extensions. A plain OpenAI-style
	 * server rejects unknown fields with a 400, so they go only to an
	 * endpoint that understands them.
	 */
	if (!endpoint.openaiCompat) {
		requestBody.chat_template_kwargs = { enable_thinking: thinkingMode !== "fast" };
		requestBody.reasoning_format = thinkingMode === "fast" ? "none" : "deepseek";
		requestBody.reasoning = thinkingMode === "fast" ? "off" : "on";
		requestBody.reasoning_budget = thinkingProfile.reasoningBudget;
	}
	if (requestTools.length) {
		requestBody.tools = requestTools;
		requestBody.tool_choice = "auto";
	}
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: endpoint.headers,
		body: JSON.stringify(requestBody),
	});
	if (!response.ok)
		throw new Error(
			`${endpoint.label} endpoint returned HTTP ${response.status}: ${await response.text()}`,
		);
	if (!response.body) throw new Error("The endpoint returned no stream");
	let buffer = "";
	let text = "";
	let thinking = "";
	let timings: Record<string, number> = {};
	let usage: Record<string, number> = {};
	let firstTokenAt: number | undefined;
	/* "length" means the answer hit max_tokens rather than finishing. */
	let finishReason = "";
	const thinkState = { active: false };
	const toolCalls: ToolCall[] = [];
	/* Per tool call, how much of its document has already gone to the pane. */
	const artifactStreamed = new Map<string, number>();
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
					finish_reason?: string | null;
				}>;
			};
			try {
				payload = JSON.parse(line.slice(6));
			} catch {
				continue;
			}
			const choice = payload.choices?.[0];
			if (choice?.finish_reason) finishReason = choice.finish_reason;
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
				streamArtifactPreview(toolCalls[index], artifactStreamed, send);
			}
		}
	}
	const elapsed = Date.now() - started;
	const metrics: PhaseMetrics = {
		...normalizePhaseMetrics(
			usage,
			timings,
			firstTokenAt ? firstTokenAt - started : elapsed,
			elapsed,
			{ answer: text, thinking },
			activeModel,
		),
		truncated: finishReason === "length",
	};
	send("metrics", {
		inputTokens: metrics.inputTokens,
		outputTokens: metrics.outputTokens,
		promptTokensPerSecond: metrics.encodeTokensPerSecond,
		generationTokensPerSecond: metrics.decodeTokensPerSecond,
		firstTokenMs: metrics.firstTokenMs,
		totalMs: metrics.totalMs,
		thinkingTokens: metrics.thinkingTokens,
		truncated: metrics.truncated,
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
		const reminders = (await listReminders(process.env.OWNER_ID || "")).map((item) => ({
			id: item.id,
			message: item.message,
			time: item.time.toISOString(),
		}));
		return { model: reminders, view: reminders };
	}
	if (name === "create_reminder") {
		const parsed = parseReminder(String(args.request || ""));
		if (!parsed.at)
			return {
				model: {
					error: "No time found in that request. Ask the user when.",
					message: parsed.message,
				},
			};
		/*
		 * Held for confirmation rather than set outright. The parse is a
		 * reading of ambiguous words — "at 5" is a guess about the evening —
		 * and a reminder set for the wrong half of the day is worse than one
		 * that took an extra tap.
		 */
		const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		pendingReminders.set(token, {
			message: parsed.message,
			at: parsed.at.toISOString(),
		});
		const confirmation = {
			confirmation_required: true,
			kind: "reminder",
			token,
			message: parsed.message,
			at: parsed.at.toISOString(),
			when: describeWhen(parsed.at),
			assumedEvening: parsed.assumedEvening,
			/*
			 * A nudge the model reads in its tool result, so it stops announcing
			 * the reminder as set. The confirmation card, not the reply, is what
			 * commits it.
			 */
			awaiting_confirmation: true,
		};
		/*
		 * The confirmation travels as `model`, not just `view`, because the
		 * `tool` stream event the console renders carries `value.model`. Sending
		 * only a lean receipt here left the console with no confirmation_required
		 * flag, so the card — and with it the only way to actually schedule the
		 * reminder — never appeared. control_entity works for exactly this
		 * reason: its model IS the confirmation.
		 */
		return { model: confirmation, view: confirmation };
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
	if (name === "read_artifact") {
		const artifact = artifacts.get(String(args.id || ""));
		if (!artifact) return { model: { error: `No artifact with id ${args.id}` } };
		const view = modelView(artifact.content);
		return {
			model: {
				id: artifact.id,
				title: artifact.title,
				kind: artifact.kind,
				bytes: view.bytes,
				lines: view.lines,
				truncated: view.windowed,
				content: view.content,
			},
		};
	}
	if (name === "rewrite_artifact") {
		const artifact = artifacts.get(String(args.id || ""));
		if (!artifact) return { model: { error: `No artifact with id ${args.id}` } };
		const content = String(args.content ?? "");
		if (!content.trim())
			return { model: { error: "content is required and cannot be empty" } };
		const updated = await artifacts.update(artifact.id, { content });
		const view = modelView(content);
		return {
			model: {
				rewritten: true,
				id: artifact.id,
				bytes: view.bytes,
				lines: view.lines,
				truncated: view.windowed,
				content: view.content,
			},
			view: { artifact: { ...updated, content: undefined } },
		};
	}
	if (name === "edit_artifact") {
		const artifact = artifacts.get(String(args.id || ""));
		if (!artifact) return { model: { error: `No artifact with id ${args.id}` } };
		const newString = String(args.new_string ?? "");
		const result = applyEdit(
			artifact.content,
			String(args.old_string ?? ""),
			newString,
			args.replace_all === true,
		);
		/*
		 * A failed edit is reported, not thrown. The model sees why it missed
		 * — wrong quote, or one that matched three places — and gets another
		 * pass at it inside the same turn.
		 */
		if (isEditFailure(result)) return { model: { error: result.error } };
		const updated = await artifacts.update(artifact.id, {
			content: result.content,
		});
		/*
		 * The document as it now stands, not just a receipt. A patch can move
		 * everything below it, and an edit aimed at what the model remembers
		 * writing lands in the wrong place once that memory is one edit stale.
		 * Bounded, and centred on what just changed, so a long document costs
		 * a window rather than the whole context.
		 */
		const view = modelView(result.content, result.content.indexOf(newString));
		return {
			model: {
				edited: true,
				id: artifact.id,
				replacements: result.replacements,
				/*
				 * Say what was actually done. A quote that only matched with
				 * whitespace collapsed, or a call that was really a rewrite,
				 * both produced the right document by a route the model did
				 * not ask for — and it should know for the next call.
				 */
				...(result.rewrote
					? {
							note: "old_string covered almost none of the document while new_string restarted it, so this was applied as a full rewrite. Use rewrite_artifact for that.",
						}
					: {}),
				...(result.loose
					? { note: "old_string matched only after collapsing whitespace." }
					: {}),
				bytes: view.bytes,
				lines: view.lines,
				truncated: view.windowed,
				content: view.content,
			},
			view: { artifact: { ...updated, content: undefined } },
		};
	}
	if (name === "web_search") {
		return { model: await webSearch(String(args.query)) };
	}
	if (name === "search_memory") {
		const matches = vault
			.list({
				search: typeof args.query === "string" ? args.query : undefined,
				tag: typeof args.tag === "string" ? args.tag : undefined,
				type: typeof args.type === "string" ? args.type : undefined,
			})
			.slice(0, 8)
			.map(summariseNote);
		return {
			model: matches.length
				? matches.map(({ path, title, type, tags, snippet }) => ({
						path,
						title,
						type,
						tags,
						snippet,
					}))
				: { matches: [], hint: "Nothing saved matches. Broaden the query or omit the tag." },
			view: { memory: matches },
		};
	}
	if (name === "read_memory") {
		const note = vault.get(String(args.path || ""));
		if (!note)
			return { model: { error: `No memory note at ${args.path}. Use search_memory to find its path.` } };
		const related = vault.related(note.path);
		return {
			model: {
				path: note.path,
				title: note.title,
				type: note.type,
				tags: note.tags,
				body: note.body,
				links: note.links,
				backlinks: related.backlinks.map((entry) => entry.path),
			},
			view: { memory: [summariseNote(note)] },
		};
	}
	if (name === "write_memory") {
		if (!String(args.path || "").trim())
			return { model: { error: "A note path is required." } };
		const body = typeof args.body === "string" ? args.body : "";
		if (!body.trim()) return { model: { error: "A note body is required." } };
		// File under memory/<kind>/… and always tag #memory, so the folder and
		// the tag both mark it as long-term memory.
		const path = memoryNotePath(args.path, args.type);
		const frontmatter = noteFrontmatter(args);
		const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
		frontmatter.tags = [...new Set(["memory", ...tags])];
		try {
			const note = await vault.write(path, { body, frontmatter });
			return {
				model: {
					saved: true,
					path: note.path,
					title: note.title,
					tags: note.tags,
					/* Surface dangling links so the model can offer to fill them in. */
					unresolved_links: note.unresolvedLinks,
				},
				view: { memory: [summariseNote(note)] },
			};
		} catch (error) {
			return {
				model: { error: error instanceof Error ? error.message : "Write failed" },
			};
		}
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

/** The configured SearXNG base URL, or undefined when the option is blank. */
function getSearxngUrl(): URL | undefined {
	const raw = process.env.SEARXNG_URL?.trim();
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Search a self-hosted SearXNG instance through its JSON API.
 *
 * Results are trimmed to a handful, each with its snippet cut short: the
 * model reads these out of the same small window it is answering in, so a
 * page of raw hits would cost more than it is worth.
 */
async function searxngSearch(base: URL, query: string) {
	// Resolve /search against the base's path, so a SearXNG behind a subpath
	// still works. A trailing slash keeps URL() from dropping the last segment.
	const search = new URL("search", base.toString().replace(/\/*$/, "/"));
	search.searchParams.set("q", query);
	search.searchParams.set("format", "json");
	const response = await fetch(search, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		return { error: `SearXNG returned HTTP ${response.status}` };
	const data = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
		answers?: unknown[];
	};
	const results = (data.results || []).slice(0, 6).map((result) => ({
		title: result.title || "",
		url: result.url || "",
		snippet: (result.content || "").replace(/\s+/g, " ").trim().slice(0, 300),
	}));
	return {
		source: "searxng",
		results,
		answers: (data.answers || []).slice(0, 3),
	};
}

/**
 * Web search, SearXNG first and Exa as an optional fallback.
 *
 * When a SearXNG instance is configured it answers; Exa steps in only if
 * SearXNG is unreachable or returns nothing, and only when a key is set.
 * With neither configured the model is told plainly, rather than left to
 * guess why a search returned an error.
 */
async function webSearch(query: string) {
	const searxng = getSearxngUrl();
	const hasExa = Boolean(process.env.EXA_API_KEY);
	if (searxng) {
		try {
			const result = await searxngSearch(searxng, query);
			if (!("error" in result) && result.results.length) return result;
			if (hasExa) return await exaSearch(query);
			return result;
		} catch (error) {
			if (hasExa) return await exaSearch(query);
			return {
				error:
					error instanceof Error ? error.message : "SearXNG search failed",
			};
		}
	}
	if (hasExa) return await exaSearch(query);
	return {
		error:
			"No web search is configured. Set searxng_url or exa_api_key in the add-on options.",
	};
}

/* ── Scheduled tasks ──────────────────────────────────────────────────── */

/**
 * Run a task's prompt through the full agent loop with no browser attached,
 * and return the answer text. The agent streams to a `send` callback; here it
 * feeds a collector that keeps the answer events and discards the rest, so a
 * scheduled run reuses exactly the tools and reasoning a chat turn gets.
 */
async function runTaskPrompt(prompt: string): Promise<string> {
	const answers: string[] = [];
	const collect: Send = (event, data) => {
		if (event === "answer") {
			const text = (data as { text?: unknown })?.text;
			if (typeof text === "string" && text.trim()) answers.push(text.trim());
		}
	};
	const mode = getThinkingProfile(
		"balanced",
		os.totalmem(),
		Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
	).id;
	await runAgent(prompt, mode, collect, `task-${Date.now()}`, [], [], "");
	// The last answer is the turn's conclusion; earlier ones are pre-tool asides.
	return answers[answers.length - 1] || "";
}

/** A one-line headline from a report, for the notification and the UI. */
function headline(report: string): string {
	const line = report
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry && !entry.startsWith("#"));
	const text = (line || report).replace(/\s+/g, " ").trim();
	return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

/**
 * Run a task once and deliver it. The full report is archived as a dated vault
 * note; the headline is pushed as a one-shot reminder so the bot's pipeline
 * pings Home Assistant, mobile, and Discord as configured. Returns the outcome
 * for the store to record.
 */
async function runTaskNow(task: ScheduledTask): Promise<{
	status: "ok" | "error";
	summary: string;
	notePath?: string;
}> {
	const at = new Date();
	let report: string;
	try {
		report = await runTaskPrompt(task.prompt);
	} catch (error) {
		console.error(`Task "${task.name}" failed:`, error);
		return {
			status: "error",
			summary: error instanceof Error ? error.message : "Run failed",
		};
	}
	if (!report.trim())
		return { status: "error", summary: "The model returned nothing." };

	let notePath: string | undefined;
	if (task.deliver.includes("vault")) {
		// One note per run. Daily/weekly get a date; intervals add the time so
		// several runs in a day do not overwrite each other.
		const day = at.toISOString().slice(0, 10);
		const stamp =
			task.schedule.kind === "interval"
				? `${day}-${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`
				: day;
		try {
			const note = await vault.write(`tasks/${stamp}-${slug(task.name)}`, {
				frontmatter: {
					title: `${task.name} — ${describeWhen(at)}`,
					type: "reference",
					tags: ["task-report", slug(task.name)],
				},
				body: `${report}\n`,
			});
			notePath = note.path;
		} catch (error) {
			console.error(`Task "${task.name}" could not archive to the vault:`, error);
		}
	}

	if (task.deliver.includes("notify")) {
		const suffix = notePath ? `\n\n(Full report saved to ${notePath})` : "";
		try {
			await addReminder(
				`${task.name}: ${headline(report)}${suffix}`,
				0,
				process.env.OWNER_ID || "",
				task.channelId || "",
			);
		} catch (error) {
			console.error(`Task "${task.name}" could not enqueue a notification:`, error);
		}
	}

	return { status: "ok", summary: headline(report), notePath };
}

/**
 * Poll for due tasks and run them one at a time.
 *
 * A minute-granular sweep is plenty for daily and weekly cadences and cheap
 * for intervals; running due tasks serially matters more, because a Pi with a
 * single small model cannot answer two turns at once. A task that is still
 * running when the next sweep comes is skipped, not stacked.
 */
let taskSweepRunning = false;
function startTaskScheduler(intervalMs = 60_000): ReturnType<typeof setInterval> {
	const sweep = async () => {
		if (taskSweepRunning) return;
		taskSweepRunning = true;
		try {
			for (const task of tasks.due()) {
				const outcome = await runTaskNow(task);
				await tasks.recordRun(task.id, { ...outcome, at: new Date() });
			}
		} catch (error) {
			console.error("Task sweep failed:", error);
		} finally {
			taskSweepRunning = false;
		}
	};
	void sweep();
	return setInterval(() => void sweep(), intervalMs);
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
	// Only the running server sweeps for due tasks; importing the app for a
	// test must not start firing model turns.
	startTaskScheduler();
}
