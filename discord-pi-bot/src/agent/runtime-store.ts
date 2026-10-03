import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HistoryTurn } from "../harness/history";

export const BACKENDS = ["harness", "codex", "claude", "opencode", "pi"] as const;
export type AgentBackend = typeof BACKENDS[number];
export interface AgentSelection { backend: AgentBackend; model: string; source: "endpoint" | "native"; endpointId?: string }
export interface AgentIdentity extends AgentSelection { provider: string; label: string; at: string }
export const agentDirectory = () => resolve(process.env.AGENT_DATA_DIR || "./data/agents");
export function internalAgentKey() {
	const path = join(agentDirectory(), "internal-key.json");
	const stored = read<{ key: string } | null>(path, null);
	if (stored?.key) return stored.key;
	const key = `${randomUUID()}${randomUUID()}`;
	write(path, { key });
	return key;
}

function read<T>(path: string, fallback: T): T {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return fallback; }
}
function write(path: string, data: unknown) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
	renameSync(temporary, path);
}

/** Consume before executing: a retry can never repeat a sensitive service call. */
export class DurablePending<T> {
	private entries: Record<string, { value: T; expires: number }>;
	constructor(private path: string, private ttl = 30 * 60_000) { this.entries = read(path, {}); }
	set(token: string, value: T) {
		this.prune();
		if (Object.keys(this.entries).length >= 500) throw new Error("Too many pending confirmations");
		this.entries[token] = { value, expires: Date.now() + this.ttl };
		write(this.path, this.entries);
		return this;
	}
	get(token: string): T | undefined { this.prune(); return this.entries[token]?.value; }
	delete(token: string) { delete this.entries[token]; write(this.path, this.entries); }
	take(token: string) { const value = this.get(token); if (value) this.delete(token); return value; }
	list() { this.prune(); return Object.entries(this.entries).map(([token, entry]) => ({ token, value: entry.value })); }
	private prune() {
		for (const [key, entry] of Object.entries(this.entries)) if (entry.expires <= Date.now()) delete this.entries[key];
	}
}

export interface AgentSession {
	conversationId: string;
	history: HistoryTurn[];
	threads: Partial<Record<AgentBackend, string>>;
	/** Tool receipts are server-owned, never reconstructed from browser prose. */
	receipts: Array<{ at: string; name: string; result: unknown }>;
	selection?: AgentSelection;
	origin?: AgentIdentity;
	originUnknown?: boolean;
	current?: AgentIdentity;
	switches?: AgentIdentity[];
}
export class AgentStore {
	private settingsPath: string;
	private settings: { backend: AgentBackend; models: Partial<Record<AgentBackend, string>> };
	private busy = false;
	constructor(private directory = agentDirectory()) {
		this.settingsPath = join(directory, "settings.json");
		this.settings = read(this.settingsPath, { backend: "harness", models: {} });
	}
	getSettings() { return structuredClone(this.settings); }
	isBusy() { return this.busy; }
	selection(id?: string): AgentSelection {
		return (id ? this.load(id).selection : undefined) || { backend: this.settings.backend, model: this.settings.models[this.settings.backend] || "", source: "endpoint" };
	}
	select(id: string, input: AgentSelection) {
		if (this.busy) throw new Error("Wait for the current assistant turn to finish before switching.");
		if (!BACKENDS.includes(input.backend) || typeof input.model !== "string" || input.model.length > 200 || /[\r\n\0]/.test(input.model)) throw new Error("Invalid assistant or model");
		if (!["endpoint", "native"].includes(input.source) || (input.source === "native" && !["codex", "opencode", "pi"].includes(input.backend))) throw new Error("Invalid account source");
		if (input.endpointId !== undefined && (typeof input.endpointId !== "string" || input.endpointId.length > 200)) throw new Error("Invalid endpoint");
		const session = this.load(id);
		const previous = session.selection || this.selection();
		// A resumed native session would miss intervening turns from another
		// assistant. Import the shared transcript when switching back instead.
		if (previous.backend !== input.backend || previous.source !== input.source || previous.endpointId !== input.endpointId) delete session.threads[input.backend];
		session.selection = { backend: input.backend, model: input.model.trim(), source: input.source, ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}) };
		this.save(session);
		return session;
	}
	identify(session: AgentSession, identity: Omit<AgentIdentity, "at">) {
		const entry = { ...identity, at: new Date().toISOString() };
		const previous = session.current;
		if (previous && ["backend", "model", "source", "endpointId", "provider"].some(key => (previous as any)[key] !== (entry as any)[key])) session.switches = [...(session.switches || []), entry].slice(-100);
		if (!session.originUnknown) session.origin ||= entry;
		session.current = entry;
		this.save(session);
		return entry;
	}
	configure(input: { backend?: unknown; model?: unknown }) {
		if (!BACKENDS.includes(input.backend as AgentBackend)) throw new Error("Unknown agent backend");
		const backend = input.backend as AgentBackend;
		if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 200 || /[\r\n\0]/.test(input.model))) throw new Error("Invalid model name");
		this.settings.backend = backend;
		if (typeof input.model === "string") this.settings.models[backend] = input.model.trim();
		write(this.settingsPath, this.settings);
		return this.getSettings();
	}
	load(id: string, seed: HistoryTurn[] = []): AgentSession {
		if (!id || id.length > 200 || /[\r\n\0]/.test(id)) throw new Error("A valid conversation ID is required");
		return read(this.path(id), { conversationId: id, history: seed, threads: {}, receipts: [] });
	}
	save(session: AgentSession) {
		session.history = session.history.slice(-60);
		session.receipts = session.receipts.slice(-80);
		write(this.path(session.conversationId), session);
	}
	remove(id: string) { rmSync(this.path(id), { force: true }); }
	/** One worker at a time keeps the Pi responsive and prevents conflicting turns. */
	async exclusive<T>(run: () => Promise<T>): Promise<T> {
		if (this.busy) throw new Error("Another assistant turn is running. Wait or cancel it first.");
		this.busy = true;
		try { return await run(); } finally { this.busy = false; }
	}
	private path(id: string) { return join(this.directory, "sessions", `${createHash("sha256").update(id).digest("hex")}.json`); }
}
