import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Where inference runs.
 *
 * The add-on defaults to the local llama.cpp beside it, but a Pi is slow,
 * and the console can point instead at a stronger box on the LAN or an
 * OpenAI-compatible API. Endpoints are kept as a switchable list rather
 * than a single override, so falling back to local is one click.
 *
 * An endpoint carries an optional API key. It is treated like the MCP
 * authorization header: written into the store, sent only to its own
 * endpoint, and never read back out to the browser — the client is told
 * only whether a key is set.
 */

export interface Endpoint {
	id: string;
	name: string;
	url: string;
	model: string;
	/** Sent as `Authorization: Bearer …`; never returned to the client. */
	apiKey?: string;
	/**
	 * A plain OpenAI-compatible server rejects llama.cpp's reasoning
	 * parameters, so this decides whether they are sent. Off for llama.cpp,
	 * on for OpenAI and the like.
	 */
	openaiCompat: boolean;
	createdAt: string;
	updatedAt: string;
}

/** What the browser is allowed to see: everything but the key itself. */
export type SafeEndpoint = Omit<Endpoint, "apiKey"> & { hasKey: boolean };

export interface EndpointConfig {
	endpoints: SafeEndpoint[];
	/** Which endpoint is live, or "" for the built-in local default. */
	activeId: string;
}

/** The endpoint actually used for a request, once the default is folded in. */
export interface ResolvedEndpoint {
	url: URL;
	model: string;
	headers: Record<string, string>;
	openaiCompat: boolean;
	/** A label for the status line: the endpoint's name, or "local". */
	label: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Is this host a private or loopback address that plain HTTP is allowed to
 * reach?
 *
 * Loopback, and the RFC1918 / link-local IP ranges — nothing else. A bare
 * hostname is deliberately not treated as private: `supervisor`,
 * `some-internal-svc` and any container name resolve to whatever the
 * network says, so allowing http to them is the SSRF hole this guards
 * against. A LAN model referred to by name must use its IP over http, or
 * https. The built-in local default reaches `homeassistant` by name, but
 * it goes through the strict allowlist, not this check.
 */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (LOOPBACK.has(host) || host === "::1") return true;
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	// IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
	if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
	return false;
}

/**
 * The URL policy for a user-configured endpoint: HTTPS to anywhere, HTTP
 * only to a private or loopback address. Throws with a reason the UI shows.
 */
export function validateEndpointUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Enter a full URL, including http:// or https://");
	}
	if (url.protocol === "https:") return url.toString();
	if (url.protocol === "http:") {
		if (isPrivateHost(url.hostname)) return url.toString();
		throw new Error(
			"Plain http is allowed only to a LAN or localhost address; use https for a public host.",
		);
	}
	throw new Error("Endpoint must use http or https");
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

interface StoredConfig {
	endpoints: Endpoint[];
	activeId: string;
}

export class EndpointStore {
	private endpoints: Endpoint[] = [];
	private activeId = "";
	constructor(
		private readonly path = process.env.ENDPOINT_DATA_PATH ||
			"./data/endpoints.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredConfig;
			this.endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints : [];
			this.activeId = typeof parsed.activeId === "string" ? parsed.activeId : "";
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load endpoints:", error);
			this.endpoints = [];
			this.activeId = "";
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(
			temporary,
			JSON.stringify({ endpoints: this.endpoints, activeId: this.activeId }, null, 2),
			"utf8",
		);
		await rename(temporary, this.path);
	}

	private safe(endpoint: Endpoint): SafeEndpoint {
		const { apiKey, ...rest } = endpoint;
		return { ...rest, hasKey: Boolean(apiKey) };
	}

	/** The active endpoint's full record, or undefined for the local default. */
	active(): Endpoint | undefined {
		return this.activeId
			? this.endpoints.find((endpoint) => endpoint.id === this.activeId)
			: undefined;
	}

	config(): EndpointConfig {
		return {
			endpoints: this.endpoints.map((endpoint) => this.safe(endpoint)),
			// A pointer to a deleted endpoint reads as local rather than nothing.
			activeId: this.active() ? this.activeId : "",
		};
	}

	async create(values: Partial<Endpoint>): Promise<SafeEndpoint> {
		const now = new Date().toISOString();
		const endpoint: Endpoint = {
			id: randomUUID().slice(0, 8),
			name: String(values.name || "Endpoint").slice(0, 60),
			url: validateEndpointUrl(String(values.url || "")),
			model: String(values.model || "").slice(0, 120),
			apiKey: values.apiKey ? String(values.apiKey) : undefined,
			openaiCompat: values.openaiCompat !== false,
			createdAt: now,
			updatedAt: now,
		};
		this.endpoints.push(endpoint);
		await this.persist();
		return this.safe(endpoint);
	}

	async update(id: string, values: Partial<Endpoint>): Promise<SafeEndpoint | undefined> {
		const endpoint = this.endpoints.find((item) => item.id === id);
		if (!endpoint) return undefined;
		if (typeof values.name === "string") endpoint.name = values.name.slice(0, 60);
		if (typeof values.url === "string")
			endpoint.url = validateEndpointUrl(values.url);
		if (typeof values.model === "string") endpoint.model = values.model.slice(0, 120);
		if (typeof values.openaiCompat === "boolean")
			endpoint.openaiCompat = values.openaiCompat;
		/*
		 * A key field left absent keeps the stored key; an empty string is a
		 * deliberate clear. This lets the UI save other edits without ever
		 * having to hold the key it was never given.
		 */
		if (typeof values.apiKey === "string")
			endpoint.apiKey = values.apiKey ? values.apiKey : undefined;
		endpoint.updatedAt = new Date().toISOString();
		await this.persist();
		return this.safe(endpoint);
	}

	async delete(id: string): Promise<boolean> {
		const before = this.endpoints.length;
		this.endpoints = this.endpoints.filter((endpoint) => endpoint.id !== id);
		if (this.endpoints.length === before) return false;
		if (this.activeId === id) this.activeId = "";
		await this.persist();
		return true;
	}

	/** Choose the live endpoint. An empty id restores the local default. */
	async setActive(id: string): Promise<boolean> {
		if (id && !this.endpoints.some((endpoint) => endpoint.id === id)) return false;
		this.activeId = id;
		await this.persist();
		return true;
	}

	get(id: string): Endpoint | undefined {
		return this.endpoints.find((endpoint) => endpoint.id === id);
	}

	/**
	 * The endpoint to send a request to. An active custom endpoint wins;
	 * otherwise the built-in local default, whose URL keeps the original
	 * hostname allowlist since it is not something a user typed.
	 */
	resolve(fallback: { url: string; model: string }): ResolvedEndpoint {
		const endpoint = this.active();
		if (endpoint) {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
			return {
				url: new URL(endpoint.url),
				model: endpoint.model || fallback.model,
				headers,
				openaiCompat: endpoint.openaiCompat,
				label: endpoint.name,
			};
		}
		return {
			url: validateLocalDefaultUrl(fallback.url),
			model: fallback.model,
			headers: { "Content-Type": "application/json" },
			openaiCompat: false,
			label: "local",
		};
	}
}

/**
 * The allowlist for the built-in default only. A user-configured endpoint
 * goes through validateEndpointUrl instead; this stays strict because the
 * default is meant to reach the add-on's own llama.cpp and nothing else.
 */
export function validateLocalDefaultUrl(value: string): URL {
	const url = new URL(value);
	const allowed = ["homeassistant", "localhost", "127.0.0.1", "::1", "local-llama-cpp"];
	if (url.protocol !== "http:" || !allowed.includes(url.hostname))
		throw new Error("The local endpoint must target the add-on's llama.cpp");
	return url;
}
