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
import type { ActiveModelMetadata } from "./harness/modelPhases";
import { createSseSender } from "./harness/sse";
import { validateHistory, type HistoryTurn } from "./harness/history";
import { measureTokenUsage, tokenizerUrl } from "./harness/tokenizer";
import { normalizeEntity, type HassEntity } from "./harness/entities";
import { resolveEntities } from "./harness/entityResolver";
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
import {
	ParcelStore,
	describeParcelTag,
	parcelNotice,
	type Parcel,
} from "./harness/parcelStore";
import {
	TrackingError,
	createTracking,
	deleteTracking,
	getTracking,
} from "./harness/trackingmore";
import { readSystemStats } from "./harness/systemStats";
import { ArtifactStore, toDocument } from "./harness/artifacts";
import { EndpointStore } from "./harness/endpoints";
import { readablePage, ReaderError } from "./harness/reader";
import { describeWhen } from "./harness/reminderParser";
import {
	McpServerStore,
	callTool as callMcpTool,
	connect as connectMcp,
	parseToolCallName,
	toolCallName,
} from "./harness/mcp";
import {
	describeTransportError,
	invalidateManagerToken,
} from "./harness/modelManager";

import type { McpToolRef } from "./agent/actions";
import { HomeApi } from "./agent/home";
import { describeActions } from "./agent/prompts";
import { runTurn, type TurnDeps } from "./agent/turn";
import {
	getThinkingProfile,
	thinkingProfilesForHardware,
	type ThinkingMode,
} from "./harness/thinkingProfiles";
import { validateAttachments, type ImageAttachment } from "./harness/attachments";
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
/*
 * Tracked parcels. TrackingMore registers each number once and polls the carrier
 * itself; a scheduler here refreshes the cached status and pings the owner on a
 * change (see startParcelScheduler). Tracking is off unless an TrackingMore key is
 * configured — every entry point checks config.trackingMoreApiKey first.
 */
const parcels = new ParcelStore();
void parcels.load();
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
/*
 * Parcels. The list survives restarts and the poller refreshes it; adding a
 * number registers it with TrackingMore (the only quota-spending call). Every
 * route is a no-op with a clear message when no TrackingMore key is configured.
 */
app.get("/api/parcels", (_request, response) => {
	response.json({
		enabled: Boolean(config.trackingMoreApiKey),
		parcels: parcels.list().map(parcelCard),
	});
});
app.post("/api/parcels", async (request, response) => {
	const body = request.body || {};
	const result = await trackParcel(
		String(body.trackingNumber ?? body.number ?? ""),
		String(body.label ?? ""),
		String(body.courier ?? body.slug ?? ""),
	);
	if (!result.ok) return response.status(400).json({ error: result.error });
	response.status(result.existed ? 200 : 201).json(parcelCard(result.parcel));
});
app.delete("/api/parcels/:id", async (request, response) => {
	const parcel = parcels.get(request.params.id);
	if (!parcel) return response.status(404).end();
	// Purge from the provider too, not just locally.
	await purgeParcel(parcel);
	response.status(204).end();
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
	// The agent has no tool list any more; these are the actions it chooses between.
	response.json(describeActions());
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
app.get("/api/models/inventory", async (_request, response) => {
	await proxyModelManager(response, "/models/inventory");
});
app.delete("/api/models/inventory/:id", async (request, response) => {
	if (!/^[a-f0-9]{32}$/.test(request.params.id))
		return response
			.status(400)
			.json(
				safeModelError(
					"invalid_inventory_target",
					"Inventory item is invalid.",
				),
			);
	await proxyModelManager(
		response,
		`/models/inventory/${encodeURIComponent(request.params.id)}`,
		"DELETE",
	);
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
/*
 * The house at a glance, for the empty console: a few plain facts rather than
 * a dashboard. Each part is optional — no Home Assistant, no reminders, and it
 * simply says less.
 */
app.get("/api/pulse", async (_request, response) => {
	const pulse: string[] = [];
	if (home) {
		try {
			const cards = (await home.cards()).filter((card) => card.available);
			const lights = cards.filter((card) => card.domain === "light");
			if (lights.length) {
				const on = lights.filter((card) => card.state === "on").length;
				pulse.push(on ? `${on} of ${lights.length} lights on` : "All lights off");
			}
			const indoor = cards.filter(
				(card) =>
					card.domain === "sensor" &&
					card.deviceClass === "temperature" &&
					card.numericState !== undefined &&
					!/outdoor|outside|garden|balcony|weather/i.test(`${card.name} ${card.area || ""}`),
			);
			if (indoor.length) {
				const mean =
					indoor.reduce((sum, card) => sum + Number(card.numericState), 0) / indoor.length;
				pulse.push(`${mean.toFixed(1)}° inside`);
			}
			const open = cards.filter(
				(card) =>
					card.domain === "binary_sensor" &&
					["door", "window", "garage_door", "opening"].includes(card.deviceClass || "") &&
					card.state === "on",
			);
			if (open.length === 1) pulse.push(`${open[0].name} open`);
			else if (open.length > 1) pulse.push(`${open.length} doors or windows open`);
		} catch (error) {
			console.warn("Pulse: Home Assistant unavailable:", error instanceof Error ? error.message : error);
		}
	}
	try {
		const next = (await listReminders(process.env.OWNER_ID || ""))
			.filter((item) => item.time.getTime() > Date.now())
			.sort((a, b) => a.time.getTime() - b.time.getTime())[0];
		if (next) pulse.push(`Next: ${next.message}, ${describeWhen(next.time)}`);
	} catch {
		/* reminders are optional */
	}
	response.set("Cache-Control", "no-store").json({ pulse });
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
	/* A closed tab or a Cancel stops generation instead of running it out. */
	const abort = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) abort.abort();
	});
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
			abort.signal,
		);
		send("complete", {});
	} catch (error) {
		if (abort.signal.aborted) return;
		console.error("Harness request failed:", error);
		send("error", {
			message: error instanceof Error ? error.message : "Unknown error",
		});
	} finally {
		response.end();
	}
});

/** A compact parcel for a status card in the console and tool results. */
function parcelCard(parcel: Parcel) {
	return {
		id: parcel.id,
		label: parcel.label,
		trackingNumber: parcel.trackingNumber,
		courier: parcel.courierName || parcel.slug,
		tag: parcel.tag,
		status: describeParcelTag(parcel.tag),
		message: parcel.statusMessage,
		location: parcel.location,
		expectedDelivery: parcel.expectedDelivery,
		delivered: parcel.delivered,
		updatedAt: parcel.updatedAt,
	};
}

type TrackResult =
	| { ok: true; parcel: Parcel; existed: boolean }
	| { ok: false; error: string };

/**
 * Register a tracking number with TrackingMore and store it, or return the parcel
 * already tracked for that number (idempotent). Shared by the model tool and
 * the REST route; the only path that spends TrackingMore quota.
 */
async function trackParcel(
	trackingNumber: string,
	label: string,
	courier: string,
): Promise<TrackResult> {
	if (!config.trackingMoreApiKey)
		return {
			ok: false,
			error:
				"Parcel tracking is off. Set the TrackingMore API key in the add-on configuration.",
		};
	const number = trackingNumber.trim();
	if (!number) return { ok: false, error: "A tracking number is required." };
	const existing = parcels.findByNumber(number);
	if (existing) return { ok: true, parcel: existing, existed: true };
	try {
		const status = await createTracking(
			config.trackingMoreApiKey,
			number,
			courier.trim() || undefined,
		);
		const parcel = await parcels.add({
			trackingNumber: number,
			slug: status.courierSlug,
			providerId: status.providerId,
			courierName: status.courierName,
			label: label.trim() || undefined,
			tag: status.tag,
			statusMessage: status.message,
			location: status.location,
			expectedDelivery: status.expectedDelivery,
			delivered: status.delivered,
			lastCheckedAt: new Date().toISOString(),
			// The add response is the owner's first notice, so start caught up:
			// the poller then only pings on a change from here.
			lastNotifiedTag: status.tag,
		});
		return { ok: true, parcel, existed: false };
	} catch (error) {
		if (error instanceof TrackingError) return { ok: false, error: error.message };
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Tracking failed.",
		};
	}
}

/**
 * Stop tracking a parcel: purge it from TrackingMore's servers (best-effort, by
 * its provider id) and remove the local record. Used when a parcel is delivered
 * and when the owner forgets one, so delivery metadata does not linger with the
 * provider longer than it is useful.
 */
async function purgeParcel(parcel: Parcel): Promise<void> {
	if (config.trackingMoreApiKey && parcel.providerId) {
		try {
			await deleteTracking(config.trackingMoreApiKey, parcel.providerId);
		} catch (error) {
			console.error(
				`Could not purge parcel "${parcel.label}" from TrackingMore:`,
				error,
			);
		}
	}
	await parcels.remove(parcel.id);
}

/* ── Agent ──────────────────────────────────────────────────────────── */

const home = supervisorToken ? new HomeApi(supervisorToken, homeAssistantUrl) : undefined;

function parcelLine(card: ReturnType<typeof parcelCard>): string {
	const name = card.label || card.trackingNumber;
	const where = card.location ? ` — ${card.location}` : "";
	const eta =
		card.expectedDelivery && !card.delivered
			? `, expected ${new Date(card.expectedDelivery).toDateString()}`
			: "";
	return `${name}: ${card.status}${where}${eta}`;
}

/**
 * The agent's view of this add-on: every store and service it may act
 * through. Built per turn so option changes (search, TrackingMore, MCP
 * servers) apply without a restart.
 */
function agentDeps(): TurnDeps {
	return {
		endpoint: resolveEndpoint,
		activeModel: activeModelMetadata,
		contextSize: Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192),
		systemPrompt: () => persona.get() + skillPrompt(skills.enabled()),
		recall: (prompt) => vault.recall(prompt, 5),
		home,
		holdAction(action) {
			const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			pendingActions.set(token, action);
			return token;
		},
		holdReminder(reminder) {
			const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			pendingReminders.set(token, reminder);
			return token;
		},
		listReminders: () => listReminders(process.env.OWNER_ID || ""),
		webSearch: getSearxngUrl() || process.env.EXA_API_KEY ? webSearch : undefined,
		vault,
		parcels: config.trackingMoreApiKey
			? {
					async track(number, label) {
						const result = await trackParcel(number, label, "");
						if (!result.ok) return { error: result.error };
						const card = parcelCard(result.parcel);
						return {
							text: `${result.existed ? "Already tracking" : "Now tracking"} ${parcelLine(card)}.`,
							card,
						};
					},
					list() {
						const cards = parcels.list().map(parcelCard);
						return {
							text: cards.length
								? cards.map((card) => `- ${parcelLine(card)}`).join("\n")
								: "No parcels are being tracked.",
							cards,
						};
					},
				}
			: undefined,
		/*
		 * MCP tools join the decision as one grammar branch each. A server
		 * that is down must not take the turn with it.
		 */
		async mcpTools() {
			const refs: McpToolRef[] = [];
			for (const server of mcpServers.enabled()) {
				try {
					const session = await connectMcp(server, 5000);
					for (const tool of session.tools)
						refs.push({
							name: toolCallName(server.id, tool.name),
							description: tool.description || `MCP tool ${tool.name}`,
							inputSchema: tool.inputSchema || { type: "object", properties: {} },
						});
				} catch (error) {
					console.warn(
						`MCP server ${server.name} unavailable:`,
						error instanceof Error ? error.message : error,
					);
				}
			}
			return refs;
		},
		async callMcp(name, args) {
			const parsed = parseToolCallName(name);
			const server = parsed ? mcpServers.get(parsed.serverId) : undefined;
			if (!parsed || !server || !server.enabled)
				throw new Error("That MCP server is not enabled.");
			return callMcpTool(server, parsed.tool, args);
		},
		artifacts,
		features: { reminders: true, parcels: Boolean(config.trackingMoreApiKey) },
	};
}

async function runAgent(
	prompt: string,
	thinkingMode: ThinkingMode,
	send: Send,
	requestId: string,
	attachments: ImageAttachment[],
	history: HistoryTurn[] = [],
	openArtifactId = "",
	signal?: AbortSignal,
): Promise<void> {
	await runTurn(
		{ prompt, thinkingMode, requestId, attachments, history, openArtifactId, signal },
		agentDeps(),
		send,
	);
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

/**
 * Refresh one parcel from TrackingMore and notify the owner on a status change.
 *
 * Reads are free (they hit TrackingMore's cache, not the carrier), so polling on a
 * cadence costs no quota. A change from the tag the owner last saw is pinged as
 * a one-shot reminder — the same delivery path /task uses, so it reaches HA,
 * mobile, and Discord. Delivered parcels flip `delivered` so a later sweep skips
 * them. Errors are swallowed per-parcel so one bad number cannot stall the sweep.
 */
async function refreshParcel(parcel: Parcel): Promise<void> {
	const status = await getTracking(
		config.trackingMoreApiKey,
		parcel.slug,
		parcel.trackingNumber,
	);
	const notice = parcelNotice(
		parcel.label,
		parcel.lastNotifiedTag,
		status.tag,
		status.message,
	);
	if (notice) {
		try {
			await addReminder(notice, 0, process.env.OWNER_ID || "", "");
		} catch (error) {
			console.error(`Parcel "${parcel.label}" could not enqueue a notification:`, error);
		}
	}
	if (status.delivered) {
		// Delivered: the owner has been told, so stop tracking and purge the
		// record from TrackingMore's servers rather than leaving it to sit out
		// their retention window.
		await purgeParcel(parcel);
		return;
	}
	await parcels.update(parcel.id, {
		tag: status.tag,
		statusMessage: status.message,
		location: status.location,
		expectedDelivery: status.expectedDelivery,
		delivered: status.delivered,
		// Backfill the provider id for parcels added before it was captured.
		providerId: parcel.providerId || status.providerId,
		lastCheckedAt: new Date().toISOString(),
		...(notice ? { lastNotifiedTag: status.tag } : {}),
	});
}

/**
 * Poll tracked, not-yet-delivered parcels on a cadence. Six hours is plenty for
 * a package and cheap; a sweep still running when the next fires is skipped, not
 * stacked. Does nothing without an TrackingMore key.
 */
let parcelSweepRunning = false;
function startParcelScheduler(
	intervalMs = 6 * 60 * 60_000,
): ReturnType<typeof setInterval> | undefined {
	if (!config.trackingMoreApiKey) return undefined;
	const sweep = async () => {
		if (parcelSweepRunning) return;
		parcelSweepRunning = true;
		try {
			for (const parcel of parcels.list()) {
				if (parcel.delivered) continue;
				try {
					await refreshParcel(parcel);
				} catch (error) {
					console.error(`Parcel "${parcel.label}" refresh failed:`, error);
				}
			}
		} finally {
			parcelSweepRunning = false;
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
	// Parcel polling starts only when an TrackingMore key is configured.
	startParcelScheduler();
}
