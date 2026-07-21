import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Minimal Model Context Protocol client over Streamable HTTP.
 *
 * Remote transport only. Spawning stdio servers would mean a package manager
 * and arbitrary child processes inside the add-on container, which is a large
 * amount of new attack surface for a box that also runs the house.
 *
 * Tools from a server are exposed to the model behind a per-server toggle,
 * because every tool definition is spent from a 4-8k context window before
 * the model reads the question.
 */

export interface McpServer {
	id: string;
	name: string;
	url: string;
	/** Optional "Authorization: ..." style header value. */
	authorization?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Namespaced so an MCP tool can never shadow a built-in one. */
export const MCP_PREFIX = "mcp__";

export function toolCallName(serverId: string, tool: string): string {
	return `${MCP_PREFIX}${serverId}__${tool}`;
}

export function parseToolCallName(
	name: string,
): { serverId: string; tool: string } | undefined {
	if (!name.startsWith(MCP_PREFIX)) return undefined;
	const rest = name.slice(MCP_PREFIX.length);
	const split = rest.indexOf("__");
	if (split < 0) return undefined;
	return { serverId: rest.slice(0, split), tool: rest.slice(split + 2) };
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

export class McpServerStore {
	private servers: McpServer[] = [];
	constructor(
		private readonly path = process.env.MCP_DATA_PATH || "./data/mcp.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.servers = Array.isArray(parsed) ? (parsed as McpServer[]) : [];
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load MCP servers:", error);
			this.servers = [];
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(this.servers, null, 2), "utf8");
		await rename(temporary, this.path);
	}

	/** Never leaks the stored credential to the browser. */
	list(): Array<Omit<McpServer, "authorization"> & { hasAuth: boolean }> {
		return this.servers.map(({ authorization, ...rest }) => ({
			...rest,
			hasAuth: Boolean(authorization),
		}));
	}

	get(id: string): McpServer | undefined {
		return this.servers.find((server) => server.id === id);
	}

	enabled(): McpServer[] {
		return this.servers.filter((server) => server.enabled);
	}

	async create(values: Partial<McpServer>): Promise<McpServer> {
		const now = new Date().toISOString();
		const server: McpServer = {
			id: randomUUID().slice(0, 8),
			name: String(values.name || "MCP server").slice(0, 60),
			url: validateServerUrl(String(values.url || "")),
			authorization: values.authorization
				? String(values.authorization).slice(0, 500)
				: undefined,
			enabled: values.enabled !== false,
			createdAt: now,
			updatedAt: now,
		};
		this.servers.unshift(server);
		await this.persist();
		return server;
	}

	async update(
		id: string,
		values: Partial<McpServer>,
	): Promise<McpServer | undefined> {
		const server = this.get(id);
		if (!server) return undefined;
		if (typeof values.name === "string") server.name = values.name.slice(0, 60);
		if (typeof values.url === "string")
			server.url = validateServerUrl(values.url);
		if (typeof values.authorization === "string")
			server.authorization = values.authorization || undefined;
		if (typeof values.enabled === "boolean") server.enabled = values.enabled;
		server.updatedAt = new Date().toISOString();
		await this.persist();
		return server;
	}

	async delete(id: string): Promise<boolean> {
		const before = this.servers.length;
		this.servers = this.servers.filter((server) => server.id !== id);
		if (this.servers.length === before) return false;
		await this.persist();
		return true;
	}
}

export function validateServerUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("MCP endpoint must be a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("MCP endpoint must use HTTP or HTTPS");
	return url.toString();
}

/**
 * One JSON-RPC exchange. A Streamable HTTP server may answer with plain JSON
 * or with an SSE stream, so both are handled; for a request/response call we
 * want the first frame carrying our id and nothing else.
 */
async function rpc(
	server: McpServer,
	method: string,
	params: Record<string, unknown> | undefined,
	sessionId: string | undefined,
	signal: AbortSignal,
): Promise<{ result?: unknown; error?: { message?: string }; sessionId?: string }> {
	const id = Math.floor(Math.random() * 1e9);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (server.authorization) headers.Authorization = server.authorization;
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;

	const response = await fetch(server.url, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	const returnedSession =
		response.headers.get("Mcp-Session-Id") || sessionId || undefined;
	if (!response.ok)
		throw new Error(`MCP server returned HTTP ${response.status}`);

	const type = response.headers.get("Content-Type") || "";
	if (!type.includes("text/event-stream")) {
		const body = (await response.json()) as {
			result?: unknown;
			error?: { message?: string };
		};
		return { ...body, sessionId: returnedSession };
	}

	// SSE: scan frames until the one answering this id arrives.
	const text = await response.text();
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const frame = JSON.parse(line.slice(5).trim());
			if (frame.id === id) return { ...frame, sessionId: returnedSession };
		} catch {
			/* keep scanning */
		}
	}
	throw new Error("MCP server sent no response for the request");
}

/** Notifications carry no id and expect no reply. */
async function notify(
	server: McpServer,
	method: string,
	sessionId: string | undefined,
	signal: AbortSignal,
): Promise<void> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (server.authorization) headers.Authorization = server.authorization;
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	await fetch(server.url, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({ jsonrpc: "2.0", method }),
	}).catch(() => undefined);
}

export interface McpSession {
	sessionId?: string;
	tools: McpTool[];
	serverName?: string;
}

/** Handshake, then list what the server offers. */
export async function connect(
	server: McpServer,
	timeoutMs = 8000,
): Promise<McpSession> {
	const signal = AbortSignal.timeout(timeoutMs);
	const initialized = await rpc(
		server,
		"initialize",
		{
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "RemindMe", version: "1.0" },
		},
		undefined,
		signal,
	);
	if (initialized.error)
		throw new Error(initialized.error.message || "MCP initialize failed");
	const sessionId = initialized.sessionId;
	await notify(server, "notifications/initialized", sessionId, signal);

	const listed = await rpc(server, "tools/list", {}, sessionId, signal);
	if (listed.error) throw new Error(listed.error.message || "tools/list failed");
	const tools = ((listed.result as { tools?: McpTool[] })?.tools || []).filter(
		(tool) => typeof tool?.name === "string",
	);
	const info = (initialized.result as { serverInfo?: { name?: string } })
		?.serverInfo;
	return { sessionId, tools, serverName: info?.name };
}

/** Invoke a tool and flatten the content blocks into something promptable. */
export async function callTool(
	server: McpServer,
	tool: string,
	args: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<unknown> {
	const session = await connect(server, timeoutMs);
	const signal = AbortSignal.timeout(timeoutMs);
	const response = await rpc(
		server,
		"tools/call",
		{ name: tool, arguments: args },
		session.sessionId,
		signal,
	);
	if (response.error)
		return { error: response.error.message || "MCP tool call failed" };
	const result = response.result as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	if (!result?.content) return result ?? {};
	// Text blocks are what a language model can use; anything else is named
	// rather than embedded, so an image cannot blow the context window.
	const text = result.content
		.map((block) =>
			block?.type === "text" ? block.text : `[${block?.type || "content"}]`,
		)
		.join("\n")
		.trim();
	return result.isError ? { error: text } : { content: text };
}

/** Convert an MCP tool into the OpenAI function schema the harness sends. */
export function toOpenAiTool(serverId: string, tool: McpTool) {
	return {
		type: "function" as const,
		function: {
			name: toolCallName(serverId, tool.name),
			description: tool.description || `MCP tool ${tool.name}`,
			parameters:
				tool.inputSchema && typeof tool.inputSchema === "object"
					? tool.inputSchema
					: { type: "object", properties: {} },
		},
	};
}
