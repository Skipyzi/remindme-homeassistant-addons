/*
 * Claude's connector directory (the one claude.ai's Connectors page lists),
 * through Anthropic's public MCP registry API. RemindMe offers the remote
 * servers from it: ones that need no sign-in connect at once, the others
 * sign in the way any connected tool does.
 */

type Fetch = typeof fetch;

export interface DirectoryEntry {
	slug: string;
	name: string;
	/** One line on what it's for. */
	what: string;
	url: string;
	/** It answers without a sign-in. */
	open: boolean;
	/** "read", "write" or "" when the directory doesn't say. */
	can: "read" | "write" | "";
	tools: number;
	toolNames: string[];
	topics: string[];
	/** Its own page about connecting it. */
	docs?: string;
}

/** Topics for a personal assistant, matched on the name and its line; the directory's own use cases are for work. */
export const TOPICS: Array<{ id: string; label: string; words: RegExp }> = [
	{ id: "trips", label: "Trips", words: /\b(flights?|hotels?|travel|trips?|booking|airlines?|vacation|stays?|tours?|experiences)\b/i },
	{ id: "tasks", label: "Tasks and notes", words: /\b(tasks?|to-?dos?|notes?|notebook|projects?|notion|todoist|calendar|schedul\w*|second brain)\b/i },
	{ id: "music", label: "Music", words: /\b(music|songs?|playlists?|podcasts?|audiobooks?|spotify|sheet music)\b/i },
	{ id: "outdoors", label: "Outdoors", words: /\b(hikes?|hiking|trails?|outdoors?|weather)\b/i },
	{ id: "food", label: "Food", words: /\b(food|restaurants?|groceries|recipes?|eats|dishes|meals?|delivered)\b/i },
	{ id: "safety", label: "Safety", words: /\b(scams?|malware|phishing|security check)\b/i },
];

interface RegistryServer {
	server?: { name?: string; title?: string; description?: string; remotes?: Array<{ type?: string; url?: string; headers?: Array<{ isRequired?: boolean }> }> };
	_meta?: Record<string, unknown>;
}

function canOf(permissions: unknown): DirectoryEntry["can"] {
	const text = String(permissions || "").toLowerCase();
	if (text.includes("write")) return "write";
	if (text.includes("read")) return "read";
	return "";
}

/** One registry entry as RemindMe shows it, or nothing when RemindMe can't connect to it. */
export function entryOf(item: RegistryServer): DirectoryEntry | undefined {
	const meta = (item._meta?.["com.anthropic.api/mcp-registry"] || {}) as Record<string, unknown>;
	const remote = item.server?.remotes?.find((entry) => entry.type === "streamable-http" && entry.url);
	const url = String(meta.url || remote?.url || "");
	// A placeholder in the address or a required header means it needs setup RemindMe can't do.
	if (!/^https:\/\//.test(url) || /[{}]/.test(url) || remote?.headers?.some((header) => header.isRequired)) return undefined;
	const name = String(meta.displayName || item.server?.title || "").trim();
	if (!name || name === "None") return undefined;
	const what = String(meta.oneLiner || item.server?.description || "").replace(/\s+/g, " ").trim();
	const toolNames = (Array.isArray(meta.toolNames) ? meta.toolNames : []).map(String).filter((tool) => /^[\w.-]+$/.test(tool));
	const text = `${name} ${what}`;
	return {
		slug: String(meta.slug || item.server?.name || name).slice(0, 80),
		name: name.slice(0, 60),
		what: what.slice(0, 160),
		url,
		open: meta.isAuthless === true,
		can: canOf(meta.permissions),
		tools: toolNames.length,
		toolNames: toolNames.slice(0, 40),
		topics: TOPICS.filter((topic) => topic.words.test(text)).map((topic) => topic.id),
		...(typeof meta.documentation === "string" && /^https:\/\//.test(meta.documentation) ? { docs: meta.documentation } : {}),
	};
}

/** Personal topics first, then ones that need no sign-in, then by name. */
function rank(a: DirectoryEntry, b: DirectoryEntry): number {
	return Number(b.topics.length > 0) - Number(a.topics.length > 0) || Number(b.open) - Number(a.open) || a.name.localeCompare(b.name);
}

export class McpDirectory {
	private cached?: { at: number; entries: DirectoryEntry[] };
	private pending?: Promise<DirectoryEntry[]>;

	constructor(
		private readonly fetchImpl: Fetch = fetch,
		private readonly base = process.env.MCP_DIRECTORY_URL || "https://api.anthropic.com/mcp-registry/v0/servers",
	) {}

	async all(): Promise<DirectoryEntry[]> {
		if (this.cached && Date.now() - this.cached.at < 24 * 60 * 60 * 1000) return this.cached.entries;
		this.pending ??= this.load()
			.then((entries) => {
				this.cached = { at: Date.now(), entries };
				return entries;
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	private async load(): Promise<DirectoryEntry[]> {
		const entries: DirectoryEntry[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const query = new URLSearchParams({ limit: "100", visibility: "commercial" });
			if (cursor) query.set("cursor", cursor);
			const response = await this.fetchImpl(`${this.base}?${query}`, { headers: { Accept: "application/json", "User-Agent": "RemindMe/4 (Home Assistant app)" }, signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new Error(`Claude's directory answered HTTP ${response.status}.`);
			const body = (await response.json()) as { servers?: RegistryServer[]; metadata?: { nextCursor?: string } };
			for (const item of body.servers || []) {
				const entry = entryOf(item);
				if (entry && !seen.has(entry.url)) {
					seen.add(entry.url);
					entries.push(entry);
				}
			}
			cursor = body.metadata?.nextCursor;
			if (!cursor) break;
		}
		return entries.sort(rank);
	}

	/** Entries that match the words or the topic; with neither, the ones for a personal assistant. */
	async find(input: { query?: string; topic?: string; limit?: number }): Promise<{ total: number; open: number; entries: DirectoryEntry[] }> {
		const all = await this.all();
		const words = String(input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
		const matches = all.filter((entry) => {
			if (input.topic && !entry.topics.includes(input.topic)) return false;
			const text = `${entry.name} ${entry.what} ${entry.toolNames.join(" ")}`.toLowerCase();
			return words.every((word) => text.includes(word));
		});
		const shown = words.length || input.topic ? matches : matches.filter((entry) => entry.topics.length);
		return { total: all.length, open: all.filter((entry) => entry.open).length, entries: shown.slice(0, input.limit || 60) };
	}

	async get(slug: string): Promise<DirectoryEntry | undefined> {
		return (await this.all()).find((entry) => entry.slug === slug);
	}
}
