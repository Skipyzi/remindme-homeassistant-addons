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
import { createSseSender } from "./harness/sse";
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
import { readablePage, ReaderError } from "./harness/reader";
import { describeWhen } from "./harness/reminderParser";
import {
	McpServerStore,
	callTool as callMcpTool,
	connect as connectMcp,
	parseToolCallName,
	toolCallName,
} from "./harness/mcp";
import { validateAttachments } from "./harness/attachments";
import { HomeApi } from "./agent/home";
import { AiSettings, PROVIDERS } from "./ai/settings";
import { SpendLedger } from "./ai/spend";
import { withLegacyKeys } from "./ai/legacyEndpoints";
import type { Effort, ImageInput, ProviderId } from "./ai/types";
import { Assistant, type AskEvents, type AskResult } from "./assistant/agent";
import { ConfirmationStore } from "./assistant/confirmations";
import { ActivityLog } from "./assistant/activity";
import { wasteEvents } from "./assistant/proactive";
import { DiscordChats } from "./discord/chats";
import { Mailboxes, type MailAccount } from "./mail/mailboxes";
import { ConnectorStore, publicView } from "./connectors/store";
import { CONNECTOR_KINDS, checkMailInput, importMailOptions, mailAccount } from "./connectors/mail";
import { CalendarChoice, listCalendars } from "./connectors/calendar";
import { ThreadStore, titleFrom, type Thread } from "./assistant/threads";
import { JobRunner } from "./assistant/jobs";
import type { EntityCard } from "./harness/entities";
import { PhonePush, type PushMessage } from "./phone/push";
import { TailscaleNode, tailnetGuard } from "./phone/tailscale";
import type { CalendarEvent } from "./agent/home";
import { buildTools, type McpTool, type ToolContext } from "./assistant/tools";
import { registerBridge, chatgptFetch } from "./agents/bridge";
import { NativeAccounts } from "./agents/native-accounts";
import { agentDirectory } from "./agents/paths";
import { RunnerThreads } from "./agents/threads";
import { chatgptAuth } from "./subscriptions/chatgptAuth";
import { claudeAuth } from "./subscriptions/claudeAuth";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const app = express();
/* The phone app: RemindMe on the tailnet, and notifications to the phones that installed it. */
export const tailscale = new TailscaleNode();
let phoneUrl: string | undefined;
const phonePush = new PhonePush(undefined, () => phoneUrl || "mailto:remindme@example.com");
/** A notification to every phone with the app; answers how many it reached. */
export function phoneNotify(message: PushMessage): Promise<number> {
	// The icon's count goes along: held actions and questions from jobs.
	const badge = confirmations.list().length + jobs.waiting().length;
	return phonePush.send({ badge, ...message }).catch((error) => {
		console.warn("Push failed:", error instanceof Error ? error.message : error);
		return 0;
	});
}
/** For the Discord bot's reminders: whether any phone listens, and how to reach it. */
export const phoneApp = { devices: () => phonePush.devices().length, send: phoneNotify };
app.use(tailnetGuard(tailscale));
const port = Number(process.env.HARNESS_PORT || 8090);
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
/* Home Assistant through the Supervisor; HA_API_URL points elsewhere for local runs. */
const homeAssistantUrl = process.env.HA_API_URL || "http://supervisor/core/api";
const instanceId = randomUUID();
/* Device actions waiting for the owner's tap, shared with the Discord bot. */
export const confirmations = new ConfirmationStore();
/* What RemindMe said, did and sent: the console's ledger. */
export const activity = new ActivityLog();
void activity.load();
/* Connectors: the mail accounts (and later other sources) added in the console. */
const connectors = new ConnectorStore();
/* Every switched-on mail connector, read fresh on each use. */
export const mailboxes = new Mailboxes(() =>
	connectors
		.list("mail")
		.filter((connector) => connector.enabled)
		.map(mailAccount)
		.filter((account): account is MailAccount => Boolean(account)),
);
/* The calendar new events go to; the calendars themselves live in Home Assistant. */
const calendarChoice = new CalendarChoice();
/* Load the connectors, taking in Gmail and GMX from the 4.2 app options once. */
export async function loadConnectors(): Promise<void> {
	await Promise.all([connectors.load(), calendarChoice.load()]);
	await importMailOptions(connectors).catch((error) => console.warn("Could not import the mail options:", error instanceof Error ? error.message : error));
}
/* The console's running chat, kept here like a Discord DM's. */
const consoleChat = new DiscordChats(process.env.CONSOLE_CHAT_PATH || "./data/console-chat.json");
void consoleChat.load();
/* The inbox's threads: one per request; a background job lives in its thread. */
export const threads = new ThreadStore();
/* Which AI answers, and what it has cost today. */
/* Codex's own sign-in, and its sign-in console. */
const nativeAccounts = new NativeAccounts();
async function storedKeys(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}
/* Keys saved by RemindMe 3.x still work until they are moved into the options. */
export const aiSettings = new AiSettings(withLegacyKeys(process.env), process.env.AI_DATA_PATH, {
	async accounts() {
		const [chatgpt, claude, codex] = await Promise.all([
			chatgptAuth.status().catch(() => ({ connected: false })),
			claudeAuth.status().catch(() => ({ connected: false })),
			storedKeys(join(agentDirectory(), "codex/auth.json")),
		]);
		return {
			chatgpt: chatgpt.connected,
			claude: claude.connected,
			codex: Boolean((codex.tokens as { access_token?: string } | undefined)?.access_token),
		};
	},
	chatgpt: { token: () => chatgptAuth.accessToken(), fetch: chatgptFetch },
	chatgptModels: async () => (await chatgptAuth.models()).map((model) => model.id),
	agentModels: async (runner) => ((await nativeAccounts.catalog(runner)).models as Array<{ id: string }>).map((model) => model.id),
});
void aiSettings.load();
export const spend = new SpendLedger();
void spend.load();
export const home = supervisorToken ? new HomeApi(supervisorToken, homeAssistantUrl) : undefined;
const conversations = new ConversationStore();
void conversations.load();
const skills = new SkillStore();
void skills.load();
const artifacts = new ArtifactStore();
void artifacts.load();
const mcpServers = new McpServerStore();
void mcpServers.load();

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
/* Which AI answers. Keys only ever come from the app options; this picks among them. */
function searchFallback(): boolean {
	return Boolean(getSearxngUrl() || process.env.EXA_API_KEY);
}
/* The agents' tool and inference bridge, reachable only with a turn's token. */
registerBridge(app);
/* Sign-in consoles for the CLI agents' own accounts, drawn in a terminal. */
nativeAccounts.register(app, () => false);
app.get("/vendor/xterm.js", (_request, response) => response.sendFile(resolve(process.cwd(), "node_modules/@xterm/xterm/lib/xterm.js")));
app.get("/vendor/xterm.css", (_request, response) => response.sendFile(resolve(process.cwd(), "node_modules/@xterm/xterm/css/xterm.css")));
/*
 * ChatGPT and Claude subscription sign-in. ChatGPT finishes on a loopback
 * page the browser usually can't reach, so its address is pasted back in;
 * Claude shows a code to paste.
 */
const subscriptions = { chatgpt: chatgptAuth, claude: claudeAuth } as const;
type SubscriptionId = keyof typeof subscriptions;
function subscription(id: string): (typeof subscriptions)[SubscriptionId] | undefined {
	return id in subscriptions ? subscriptions[id as SubscriptionId] : undefined;
}
app.get("/api/ai/signin/:provider", async (request, response) => {
	const manager = subscription(request.params.provider);
	if (!manager) return response.status(404).json({ error: "Unknown sign-in" });
	try {
		response.set("Cache-Control", "no-store").json(await manager.status());
	} catch {
		response.status(503).json({ connected: false, error: "The sign-in client is unavailable." });
	}
});
app.post("/api/ai/signin/:provider/:step", async (request, response) => {
	const manager = subscription(request.params.provider);
	if (!manager) return response.status(404).json({ error: "Unknown sign-in" });
	if (!request.is("application/json")) return response.status(415).json({ error: "Send an application/json request" });
	try {
		switch (request.params.step) {
			case "start":
				return response.json(await manager.start());
			case "complete": {
				const status = await manager.complete(String(request.body?.attemptId || ""), String(request.body?.code || ""));
				await aiSettings.refreshAccounts();
				return response.json(status);
			}
			case "cancel":
				manager.cancel();
				return response.json({ ok: true });
			case "logout":
				await manager.logout();
				await aiSettings.refreshAccounts();
				return response.json({ ok: true });
			default:
				return response.status(404).json({ error: "Unknown step" });
		}
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Sign-in failed" });
	}
});
app.get("/api/ai", async (_request, response) => {
	await aiSettings.refreshAccounts();
	response.set("Cache-Control", "no-store").json({
		...aiSettings.status(searchFallback()),
		spend: spend.today(),
		budget: aiSettings.dailyBudget(),
	});
});
app.put("/api/ai", async (request, response) => {
	try {
		await aiSettings.choose(request.body || {});
		response.json(aiSettings.status(searchFallback()));
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Invalid choice" });
	}
});
app.get("/api/ai/models", async (request, response) => {
	const id = String(request.query.provider || aiSettings.providerId());
	if (!PROVIDERS.some((provider) => provider.id === id))
		return response.status(400).json({ error: "Unknown provider" });
	try {
		response.json({ models: await aiSettings.listModels(id as ProviderId) });
	} catch (error) {
		response.status(502).json({ error: error instanceof Error ? error.message : "Could not list models" });
	}
});
/* One tiny request, to prove the key and model work before trusting them with a turn. */
app.post("/api/ai/test", async (_request, response) => {
	const status = aiSettings.status(searchFallback());
	if (!status.ready) return response.json({ ok: false, error: status.problem });
	try {
		const reply = await assistant.quick("Reply with the single word: ok", AbortSignal.timeout(60_000));
		response.json({ ok: Boolean(reply), reply: reply?.slice(0, 120) || "", model: status.model });
	} catch (error) {
		response.json({ ok: false, error: error instanceof Error ? error.message : "The test failed" });
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
app.get("/api/tools", async (_request, response) => {
	const provider = aiSettings.provider();
	const tools = await buildTools(toolContext(), { nativeWebSearch: Boolean(provider?.nativeWebSearch) });
	response.json(
		tools.map(({ spec }) => ({
			name: spec.name,
			description: spec.description,
			parameters: Object.keys((spec.parameters as { properties?: object }).properties || {}),
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
/* Cloud models have no public tokenizer; the console falls back to its estimate. */
app.post("/api/tokenize", (_request, response) => {
	response.json({ exact: false });
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
			response.json(
				confirmations.hold(validated, `${validated.service.replace(/_/g, " ")} ${validated.entityId}`),
			);
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
/* The composer's thinking choices, as effort levels. The ids are the old ones,
 * so a choice saved in the browser keeps working. */
const EFFORT_PROFILES: Array<{ id: string; name: string; effort: Effort; description: string }> = [
	{ id: "fast", name: "Quick", effort: "low", description: "Short thinking. Best for the house and quick questions." },
	{ id: "balanced", name: "Normal", effort: "medium", description: "Thinks a little longer." },
	{ id: "deep", name: "Deep", effort: "high", description: "Thinks hardest. Slower and costs more." },
];
function effortFor(mode: unknown): Effort | undefined {
	return EFFORT_PROFILES.find((profile) => profile.id === mode)?.effort;
}
app.get("/api/status", (_request, response) => {
	const status = aiSettings.status(searchFallback());
	response.set("Cache-Control", "no-store").json({
		instanceId,
		model: status.model,
		modelName: status.ready ? `${status.label} · ${status.model}` : "AI not set up",
		ai: status,
		capabilities: status.vision ? ["vision"] : [],
		vision: status.vision,
		/* The companion remindme-vault editor's URL, if configured — lets the
		 * console deep-link a note into that add-on. Empty means no link shown. */
		vaultUrl: process.env.VAULT_UI_URL || "",
		profiles: EFFORT_PROFILES.map((profile) => ({
			...profile,
			recommended: profile.effort === aiSettings.effort(),
		})),
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
	const held = confirmations.take(token);
	if (!held || !home) {
		response.status(404).json({ error: "That request expired. Ask again." });
		return;
	}
	try {
		await home.service(held.action);
		activity.resolve(token, "confirmed", held.label);
		response.json({ done: true, message: held.label });
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Home Assistant refused";
		activity.resolve(token, "failed", `${held.label}: ${reason}`);
		response.status(502).json({ error: reason });
	}
});
app.post("/api/confirm/cancel", (request, response) => {
	const token = typeof request.body?.token === "string" ? request.body.token : "";
	const pending = confirmations.list().find((item) => item.token === token);
	confirmations.cancel(token);
	activity.resolve(token, "cancelled", pending?.message || "Cancelled");
	response.json({ cancelled: true });
});

/* What RemindMe will do next on its own; set by the app once the scheduler runs. */
let plannedSends: () => Promise<Array<{ at: Date; text: string }>> = async () => [];
export function setPlannedSends(source: () => Promise<Array<{ at: Date; text: string }>>): void {
	plannedSends = source;
}
let calendarCache: { at: number; events: CalendarEvent[] } | undefined;
async function nextEvents(now: Date): Promise<CalendarEvent[]> {
	if (!home) return [];
	if (calendarCache && now.getTime() - calendarCache.at < 5 * 60_000) return calendarCache.events;
	try {
		const all = await home.calendarEvents(now, new Date(now.getTime() + 36 * 3_600_000));
		const waste = new Set(wasteEvents(all));
		calendarCache = { at: now.getTime(), events: all.filter((event) => !waste.has(event)) };
	} catch (error) {
		console.warn("Ledger calendar failed:", error instanceof Error ? error.message : error);
		calendarCache = { at: now.getTime(), events: [] };
	}
	return calendarCache.events;
}

/* Batteries at or under the nudge threshold, for "waiting on you". */
function lowBatteries(cards: EntityCard[]) {
	const threshold = Number(process.env.BATTERY_NUDGE_PERCENT || 15) || 15;
	return cards
		.filter((card) => card.available && card.deviceClass === "battery" && card.numericState !== undefined && card.numericState <= threshold)
		.map((card) => ({ entityId: card.entityId, name: card.name.replace(/\s*battery$/i, ""), level: Math.round(card.numericState!) }));
}

/**
 * The inbox: what needs the user, the jobs and scheduled tasks running, the
 * threads, and what RemindMe sent or did outside them (the brief, nudges,
 * reminders, Discord).
 */
app.get("/api/inbox", async (_request, response) => {
	const now = new Date();
	const status = aiSettings.status(searchFallback());
	const cards = home ? await home.cards().catch(() => [] as EntityCard[]) : [];
	response.set("Cache-Control", "no-store").json({
		now: now.toISOString(),
		ai: { label: status.label, model: status.model, ready: status.ready, problem: status.problem },
		waiting: confirmations.list(),
		batteries: lowBatteries(cards),
		threads: threads.list().slice(0, 100),
		tasks: tasks
			.list()
			.filter((task) => task.enabled)
			.map((task) => ({ id: task.id, name: task.name, schedule: describeSchedule(task.schedule), nextRun: task.nextRun, lastRun: task.lastRun, lastStatus: task.lastStatus, lastSummary: task.lastSummary })),
		activity: activity
			.recent(3, now)
			.filter((entry) => entry.channel !== "console" && entry.channel !== "job" && entry.kind !== "waiting")
			.slice(0, 80),
	});
});

app.get("/api/threads/:id", (request, response) => {
	const thread = threads.get(request.params.id);
	if (!thread) return response.status(404).json({ error: "That conversation is gone." });
	response.set("Cache-Control", "no-store").json(thread);
});

/*
 * A turn in a thread, streamed like the old console chat. A new message from
 * the inbox opens a thread first and says which; a reply continues one.
 */
async function threadTurn(request: express.Request, response: express.Response, existing?: Thread): Promise<void> {
	const said = typeof request.body?.message === "string" ? request.body.message.trim() : "";
	let attachments: ReturnType<typeof validateAttachments>;
	try {
		attachments = validateAttachments(request.body?.attachments, true);
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Those pictures can't be used." });
		return;
	}
	const prompt = said || (attachments.length ? "What's in this picture?" : "");
	if (!prompt) {
		response.status(400).json({ error: "Say something first." });
		return;
	}
	response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
	const send = createSseSender(response);
	const abort = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) abort.abort();
	});
	const thread = existing || threads.create({ title: titleFrom(prompt), origin: "console" });
	send("thread", { id: thread.id, title: thread.title });
	const history = threads.history(thread.id);
	threads.setBusy(thread.id, true);
	threads.append(thread.id, { role: "user", text: attachments.length ? `${prompt}\n\n(${attachments.length} picture${attachments.length === 1 ? "" : "s"})` : prompt });
	try {
		const result = await runConsoleTurn(send, `thread-${thread.id}-${Date.now()}`, {
			prompt,
			history,
			images: attachments.map((image): ImageInput => ({ mediaType: image.mediaType, data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1) })),
			effort: effortFor(request.body?.thinkingMode),
			conversationId: `thread:${thread.id}`,
			threadId: thread.id,
			signal: abort.signal,
		});
		threads.append(thread.id, {
			role: "assistant",
			text: result.text,
			receipts: result.did,
			confirms: result.confirms.map((item) => ({ token: item.token, message: item.message, destructive: item.destructive })),
		});
		send("complete", { threadId: thread.id });
	} catch (error) {
		if (abort.signal.aborted) threads.append(thread.id, { role: "assistant", text: "(Stopped before answering.)" });
		else {
			console.error("Thread turn failed:", error);
			threads.append(thread.id, { role: "assistant", text: `Something went wrong: ${error instanceof Error ? error.message : error}` });
			send("error", { message: error instanceof Error ? error.message : "Unknown error" });
		}
	} finally {
		threads.setBusy(thread.id, false);
		response.end();
	}
}
app.post("/api/threads", (request, response) => void threadTurn(request, response));
/* A reply: a job takes it as an answer and carries on; a conversation answers it now. */
app.post("/api/threads/:id/messages", (request, response) => {
	const thread = threads.get(request.params.id);
	if (!thread) return void response.status(404).json({ error: "That conversation is gone." });
	if (!thread.job) return void threadTurn(request, response, thread);
	const text = typeof request.body?.message === "string" ? request.body.message.trim() : "";
	if (!text || !jobs.answer(thread.id, text)) return void response.status(400).json({ error: "Say something first." });
	response.json(threads.get(thread.id));
});
app.post("/api/threads/:id/stop", (request, response) => {
	if (!jobs.stop(request.params.id)) return response.status(400).json({ error: "That job isn't running." });
	response.json(threads.get(request.params.id));
});
app.delete("/api/threads/:id", (request, response) => {
	jobs.stop(request.params.id);
	response.status(threads.remove(request.params.id) ? 204 : 404).end();
});

/**
 * The console's history: what is waiting on you, what comes next, and
 * everything RemindMe said, did and sent over the last week.
 */
app.get("/api/ledger", async (_request, response) => {
	const now = new Date();
	const status = aiSettings.status(searchFallback());
	const ownerId = process.env.OWNER_ID || "";
	const weekAhead = now.getTime() + 7 * 86_400_000;
	const [reminders, planned, events, cards] = await Promise.all([
		listReminders(ownerId).catch(() => []),
		plannedSends().catch(() => []),
		nextEvents(now),
		home ? home.cards().catch(() => []) : Promise.resolve([]),
	]);
	const upcoming = [
		...planned.map((item) => ({ at: item.at.toISOString(), kind: "will send", text: item.text })),
		...reminders
			.filter((item) => item.time.getTime() <= weekAhead)
			.map((item) => ({ at: item.time.toISOString(), kind: "reminder", text: item.message, reminderId: item.id })),
		...events
			.filter((event) => !event.allDay && Date.parse(event.start) > now.getTime())
			.map((event) => ({ at: new Date(event.start).toISOString(), kind: "calendar", text: event.summary, until: event.end })),
		...events
			.filter((event) => event.allDay)
			.map((event) => ({ at: new Date(`${event.start}T00:00:00`).toISOString(), kind: "calendar", text: event.summary, allDay: true })),
		...tasks
			.list()
			.filter((task) => task.enabled && Date.parse(task.nextRun) <= now.getTime() + 36 * 3_600_000)
			.map((task) => ({ at: task.nextRun, kind: "task", text: task.name })),
	].sort((a, b) => a.at.localeCompare(b.at));
	const pending = new Set(confirmations.list().map((item) => item.token));
	response.set("Cache-Control", "no-store").json({
		now: now.toISOString(),
		ai: { label: status.label, model: status.model, ready: status.ready, problem: status.problem },
		waiting: confirmations.list(),
		batteries: lowBatteries(cards),
		upcoming,
		// A waiting row whose token is gone expired unseen.
		entries: activity
			.recent(7, now)
			.map((entry) => (entry.kind === "waiting" && (!entry.token || !pending.has(entry.token)) ? { ...entry, kind: "cancelled", text: `${entry.text} (expired)`, token: undefined } : entry)),
	});
});
/* Set a reminder straight from the ledger, such as "replace the battery on Saturday". */
app.post("/api/reminders", async (request, response) => {
	const message = typeof request.body?.message === "string" ? request.body.message.trim().slice(0, 300) : "";
	const at = new Date(String(request.body?.at || ""));
	if (!message || Number.isNaN(at.getTime()) || at.getTime() < Date.now()) return response.status(400).json({ error: "Say what to remind you of, and a time in the future." });
	const created = await addReminder(message, (at.getTime() - Date.now()) / 60_000, process.env.OWNER_ID || "", "");
	activity.add({ kind: "did", channel: "console", text: `Reminder for ${describeWhen(at)}: ${message}`, receipts: [{ text: `Reminder for ${describeWhen(at)}: ${message}` }] });
	response.status(201).json({ id: created.id, at: at.toISOString() });
});
/*
 * Connectors. Passwords go in, never out: the list says which are set.
 * A mail account is tested before it's saved, so a typo never lands.
 */
app.get("/api/connectors", (_request, response) => {
	response.set("Cache-Control", "no-store").json({
		kinds: CONNECTOR_KINDS,
		connectors: connectors.list().map((connector) => ({ ...publicView(connector), status: mailboxes.status(connector.id) })),
	});
});
app.post("/api/connectors", async (request, response) => {
	try {
		if (request.body?.kind !== "mail") throw new Error("Unknown kind of connector");
		const input = checkMailInput(request.body, true);
		const draftId = `draft-${Date.now()}`;
		const account = mailAccount({ kind: "mail", enabled: true, ...input, id: draftId, createdAt: "" });
		if (!account) throw new Error("Enter the address and password.");
		const result = await mailboxes.test(account);
		const saved = await connectors.create({ kind: "mail", enabled: true, ...input });
		mailboxes.carryStatus(draftId, saved.id);
		activity.add({ kind: "did", channel: "console", text: `Connected ${saved.name} (${saved.values.address})`, receipts: [{ text: `Connected ${saved.name} (${saved.values.address})` }] });
		response.status(201).json({ connector: publicView(saved), result });
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Could not add the connector" });
	}
});
app.patch("/api/connectors/:id", async (request, response) => {
	const existing = connectors.get(request.params.id);
	if (!existing) return response.status(404).json({ error: "No such connector" });
	try {
		const body = request.body || {};
		const patch: Parameters<ConnectorStore["update"]>[1] = {};
		if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
		if (body.values || body.secrets || body.name !== undefined) {
			const input = checkMailInput({ preset: existing.preset, name: body.name ?? existing.name, values: { ...existing.values, ...(body.values || {}) }, secrets: body.secrets }, false);
			patch.name = input.name;
			patch.values = input.values;
			patch.secrets = input.secrets;
			// New credentials are tested before they replace the working ones.
			if (input.secrets.password || body.values) {
				const account = mailAccount({ ...existing, values: input.values, secrets: { ...existing.secrets, ...input.secrets } });
				if (!account) throw new Error("Enter the address and password.");
				await mailboxes.test(account);
			}
		}
		const saved = await connectors.update(existing.id, patch);
		response.json({ connector: saved && publicView(saved) });
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Could not save the connector" });
	}
});
app.delete("/api/connectors/:id", async (request, response) => {
	response.status((await connectors.remove(request.params.id)) ? 204 : 404).end();
});
/* Home Assistant's calendars, and which one takes new events. */
app.get("/api/calendars", async (_request, response) => {
	if (!home) return response.json({ calendars: [], newEvents: null });
	try {
		response.set("Cache-Control", "no-store").json({ calendars: await listCalendars(home), newEvents: calendarChoice.newEvents() ?? null });
	} catch (error) {
		response.status(502).json({ error: error instanceof Error ? error.message : "Home Assistant didn't answer" });
	}
});
app.put("/api/calendars/new-events", async (request, response) => {
	const entityId = typeof request.body?.entityId === "string" ? request.body.entityId : "";
	if (entityId) {
		const calendar = home && (await listCalendars(home).catch(() => [])).find((entry) => entry.entityId === entityId);
		if (!calendar?.writable) return response.status(400).json({ error: "That calendar doesn't take new events." });
	}
	await calendarChoice.choose(entityId || undefined);
	response.json({ newEvents: calendarChoice.newEvents() ?? null });
});
app.post("/api/connectors/:id/test", async (request, response) => {
	const connector = connectors.get(request.params.id);
	const account = connector && mailAccount(connector);
	if (!account) return response.status(404).json({ ok: false, error: "No such connector, or it has no password." });
	try {
		response.json({ ok: true, message: await mailboxes.test(account) });
	} catch (error) {
		response.json({ ok: false, error: error instanceof Error ? error.message : "The test failed" });
	}
});

app.post("/api/chat/reset", (_request, response) => {
	consoleChat.reset("console");
	response.json({ ok: true });
});

app.post("/api/chat", async (request, response) => {
	const prompt =
		typeof request.body?.message === "string"
			? request.body.message.trim()
			: "";
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
		const attachments = validateAttachments(request.body?.attachments, true);
		const artifactId = typeof request.body?.artifactId === "string" ? request.body.artifactId : "";
		const result = await runConsoleTurn(send, `request-${Date.now()}`, {
			prompt,
			history: consoleChat.history("console"),
			images: attachments.map(
				(image): ImageInput => ({ mediaType: image.mediaType, data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1) }),
			),
			// Which document is on the bench, so edits have a default target.
			openDocument: artifactId ? artifacts.get(artifactId) : undefined,
			effort: effortFor(request.body?.thinkingMode),
			conversationId: consoleChat.conversationId("console"),
			signal: abort.signal,
		});
		if (!result.problem)
			consoleChat.append("console", [
				{ role: "user", text: prompt },
				{ role: "assistant", text: result.text },
			]);
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

function parcelLine(card: ReturnType<typeof parcelCard>): string {
	const name = card.label || card.trackingNumber;
	const where = card.location ? ` — ${card.location}` : "";
	const eta =
		card.expectedDelivery && !card.delivered
			? `, expected ${new Date(card.expectedDelivery).toDateString()}`
			: "";
	return `${name}: ${card.status}${where}${eta}`;
}

let homeName: string | undefined;
async function loadHomeName(): Promise<void> {
	if (!home) return;
	try {
		const settings = await home.config();
		homeName = settings.location_name;
		// The app container may not carry the house's time zone; Home Assistant knows it.
		if (!process.env.TZ && settings.time_zone) process.env.TZ = settings.time_zone;
	} catch (error) {
		console.warn("Could not read Home Assistant's settings:", error instanceof Error ? error.message : error);
	}
}

/**
 * Everything the assistant's tools reach. Built per turn so option changes
 * (search, TrackingMore, MCP servers) apply without a restart.
 */
export function toolContext(): ToolContext {
	const ownerId = process.env.OWNER_ID || "";
	return {
		home,
		confirmations,
		reminders: {
			add: (message, at) => addReminder(message, Math.max(0, (at.getTime() - Date.now()) / 60_000), ownerId, ""),
			list: () => listReminders(ownerId),
			cancel: (id) => deleteReminder(id, ownerId),
		},
		vault,
		webSearch: searchFallback() ? webSearch : undefined,
		async readPage(url) {
			const page = await readablePage(url);
			return { title: page.title, url: page.finalUrl, text: page.text };
		},
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
		artifacts,
		mail: mailboxes,
		calendar: calendarChoice,
		jobs: { start: (input) => jobs.start(input), answer: (id, text) => jobs.answer(id, text) },
		mcp: {
			/* A server that is down must not take the turn with it. */
			async tools() {
				const refs: McpTool[] = [];
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
			async call(name, args) {
				const parsed = parseToolCallName(name);
				const server = parsed ? mcpServers.get(parsed.serverId) : undefined;
				if (!parsed || !server || !server.enabled)
					throw new Error("That MCP server is not enabled.");
				return callMcpTool(server, parsed.tool, args);
			},
		},
	};
}

export const assistant = new Assistant({
	settings: aiSettings,
	spend,
	persona: () => persona.get() + skillPrompt(skills.enabled()),
	tools: toolContext,
	recall: (prompt) => vault.recall(prompt, 5),
	home: () => homeName,
	searchFallback,
	agents: { bridgeUrl: `http://127.0.0.1:${port}/internal/agent-tools`, threads: new RunnerThreads() },
	activity,
	standing: () => {
		const waiting = jobs.waiting();
		return waiting.length
			? `Background jobs waiting for the user's answer (pass an answer on with reply_to_job):\n${waiting.map((job) => `- ${job.id} "${job.title}": ${job.question}`).join("\n")}`
			: undefined;
	},
});

/* How a job's questions and results reach the user; the app sets this once Discord runs. */
let jobNotifier = async (thread: Thread, text: string): Promise<void> => {
	activity.add({ kind: "sent", channel: "job", text: `${thread.title}: ${text}` });
};
export function setJobNotifier(notify: (thread: Thread, text: string) => Promise<void>): void {
	jobNotifier = notify;
}
/* Background jobs, one at a time, on the same assistant. Their news goes to Discord and the phone app. */
export const jobs = new JobRunner({
	threads,
	ask: (input) => assistant.ask(input),
	notify: async (thread, text) => {
		await Promise.all([jobNotifier(thread, text), phoneNotify({ title: thread.title, body: text, url: `./#t/${thread.id}`, tag: `job-${thread.id}` })]);
	},
});

/* The phone app's settings: Tailscale, and the phones that get notifications. */
app.get("/api/phone", async (_request, response) => {
	const status = await tailscale.status();
	if (status.url) phoneUrl = status.url;
	response.set("Cache-Control", "no-store").json({ ...status, pushKey: phonePush.publicKey, devices: phonePush.devices() });
});
app.post("/api/phone/connect", async (_request, response) => {
	const status = await tailscale.connect();
	if (status.url) phoneUrl = status.url;
	response.json({ ...status, pushKey: phonePush.publicKey, devices: phonePush.devices() });
});
app.post("/api/push/subscribe", async (request, response) => {
	try {
		await phonePush.subscribe(request.body?.subscription, request.get("user-agent") || "");
		response.json({ devices: phonePush.devices() });
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : "Couldn't turn notifications on." });
	}
});
app.post("/api/push/unsubscribe", async (request, response) => {
	await phonePush.unsubscribe(typeof request.body?.endpoint === "string" ? request.body.endpoint : undefined);
	response.json({ devices: phonePush.devices() });
});
app.post("/api/push/test", async (_request, response) => {
	const reached = await phoneNotify({ title: "RemindMe", body: "Notifications work. Questions from jobs, reminders and the morning brief arrive like this.", url: "./", tag: "test" });
	response.json({ reached });
});

/** Parcels still on their way, as lines for the morning brief. */
export function parcelSummary(): string {
	const cards = parcels.list().filter((parcel) => !parcel.delivered).map(parcelCard);
	return cards.length ? cards.map((card) => `- ${parcelLine(card)}`).join("\n") : "No parcels are being tracked.";
}

/* The morning brief on demand; set by the app when the Discord bot runs. */
let briefSender: (() => Promise<string>) | undefined;
export function setBriefSender(send: () => Promise<string>): void {
	briefSender = send;
}
app.post("/api/brief", async (_request, response) => {
	if (!briefSender) return response.status(503).json({ error: "The brief is sent on Discord, and the Discord bot isn't running." });
	try {
		response.json({ text: await briefSender() });
	} catch (error) {
		response.status(502).json({ error: error instanceof Error ? error.message : "The brief failed" });
	}
});

/**
 * One console turn, streamed as the events the console's timeline already
 * knows: a phase per model round, a row per tool call, the answer last.
 */
async function runConsoleTurn(
	send: Send,
	requestId: string,
	input: Omit<Parameters<Assistant["ask"]>[0], "channel">,
): Promise<AskResult> {
	const phase = (round: number) => `${requestId}-${round}`;
	const thinkingOpen = new Set<number>();
	const toolNames = new Map<string, string>();
	let lastRound = 0;
	const rowName = (round: number, id: string, name: string) => {
		const key = `${round}:${id}`;
		if (!toolNames.has(key)) {
			const taken = [...toolNames.entries()].filter(([entry, value]) => entry.startsWith(`${round}:`) && value.startsWith(name)).length;
			toolNames.set(key, taken ? `${name} · ${taken + 1}` : name);
		}
		return toolNames.get(key)!;
	};
	const parse = (content: string): unknown => {
		try {
			return JSON.parse(content);
		} catch {
			return content;
		}
	};
	const events: AskEvents = {
		roundStart(round) {
			lastRound = round;
		},
		thinking(delta, round) {
			if (!thinkingOpen.has(round)) {
				thinkingOpen.add(round);
				send("phase_start", { phaseId: phase(round), iteration: round, kind: "thinking", state: "active" });
			}
			send("thinking_delta", { phaseId: phase(round), iteration: round, kind: "thinking", text: delta });
		},
		text(delta, round) {
			send("answer_delta", { phaseId: phase(round), iteration: round, kind: "answer", text: delta });
		},
		toolStart(call, round) {
			send("tool_start", { phaseId: phase(round), iteration: round, kind: "tool", state: "active", name: rowName(round, call.id, call.name), arguments: call.input });
		},
		toolEnd(call, result, round) {
			send("tool_complete", {
				phaseId: phase(round),
				iteration: round,
				kind: "tool",
				state: "complete",
				name: rowName(round, call.id, call.name),
				result: result.isError ? { error: result.content } : parse(result.content),
				view: result.view,
			});
		},
		searched(query, round) {
			const name = rowName(round, `search-${query}`, "web_search");
			send("tool_start", { phaseId: phase(round), iteration: round, kind: "tool", state: "active", name, arguments: { query } });
			send("tool_complete", { phaseId: phase(round), iteration: round, kind: "tool", state: "complete", name, result: { searched: query } });
		},
		confirm(confirmation, round) {
			const name = `confirm · ${confirmation.message}`;
			send("tool_start", { phaseId: phase(round), iteration: round, kind: "tool", state: "active", name, arguments: {} });
			send("tool_complete", { phaseId: phase(round), iteration: round, kind: "tool", state: "complete", name, result: confirmation });
		},
		roundEnd(round, step) {
			const metrics = { inputTokens: step.usage.inputTokens + step.usage.cacheReadTokens + step.usage.cacheWriteTokens, outputTokens: step.usage.outputTokens, modelId: step.model, modelName: step.model };
			send("phase_complete", { phaseId: phase(round), iteration: round, kind: step.calls.length ? "tool" : "answer", state: "complete", metrics });
		},
	};
	const result = await assistant.ask({ ...input, channel: "console" }, events);
	const final = phase(lastRound);
	if (result.problem) {
		send("phase_start", { phaseId: `${final}-problem`, iteration: lastRound + 1, kind: "answer", state: "active" });
		send("answer_delta", { phaseId: `${final}-problem`, iteration: lastRound + 1, kind: "answer", text: result.text });
		send("phase_complete", { phaseId: `${final}-problem`, iteration: lastRound + 1, kind: "answer", state: "complete" });
		return result;
	}
	send("answer", { phaseId: final, iteration: lastRound, text: result.text, cards: result.cards });
	send("phase_metrics", {
		phaseId: final,
		iteration: lastRound,
		kind: "answer",
		metrics: {
			modelId: result.model,
			modelName: result.model,
			inputTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
			outputTokens: result.usage.outputTokens,
			...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
		},
	});
	send("phase_complete", { phaseId: final, iteration: lastRound, kind: "answer", state: "complete" });
	return result;
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
	const result = await assistant.ask({ prompt, channel: "task", effort: "medium" });
	if (result.problem) throw new Error(result.problem);
	return result.text;
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

/**
 * Serve the console and start the task and parcel sweeps. Resolves once Home
 * Assistant has said which time zone the house is in, so nothing scheduled
 * runs on the container's clock.
 */
export async function startHarness(): Promise<void> {
	await Promise.all([loadConnectors(), threads.load(), phonePush.load()]);
	app.listen(port, () => console.log(`RemindMe console listening on port ${port}`));
	jobs.resume();
	// Once Tailscale is up: the app's address, and HTTPS to the console.
	if (tailscale.enabled)
		setTimeout(async () => {
			const status = await tailscale.status();
			if (status.url) phoneUrl = status.url;
			console.log(status.state === "running" ? `Phone app on ${status.url}` : `Phone app: Tailscale ${status.state.replace("_", " ")}`);
		}, 5_000);
	await loadHomeName();
	startTaskScheduler();
	// Parcel polling starts only when a TrackingMore key is configured.
	startParcelScheduler();
}
