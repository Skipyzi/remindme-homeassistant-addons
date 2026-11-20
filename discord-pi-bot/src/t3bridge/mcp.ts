/**
 * A small client for T3 Code's HTTP MCP endpoint (`/mcp`, Streamable HTTP)
 * with a static bearer token: an MCP client session at the
 * `approval-required` ceiling, so nothing sent from Discord can run with
 * broader permissions than that, and tool approvals stay in the T3 app.
 *
 * Errors are sorted so the bridge can tell "the PC is off" (queue and retry)
 * from "the token is wrong" and "T3 said no". None of them ever carries the
 * token.
 */

export class T3Unreachable extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "T3Unreachable";
	}
}
export class T3AuthError extends Error {
	constructor(readonly status: number) {
		super(`T3 refused the bridge's token (HTTP ${status})`);
		this.name = "T3AuthError";
	}
}
export class T3ToolError extends Error {
	constructor(message: string, readonly code?: string) {
		super(message);
		this.name = "T3ToolError";
	}
}

export type RunStatus = "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";
export const FINISHED: ReadonlySet<string> = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export interface LaunchArgs {
	projectId: string;
	title: string;
	message: string;
	runtimeMode: "approval-required";
	interactionMode: "default" | "plan";
	workspaceStrategy: { type: "worktree"; baseRef: string; startFromOrigin: boolean };
	modelSelection: { instanceId: string; model: string };
	clientRequestId: string;
}
export interface Launched {
	threadId: string;
	link?: string | null;
	runId?: string | null;
	status?: RunStatus | null;
}
export interface Sent {
	threadId: string;
	link?: string | null;
	runId?: string | null;
	status?: string | null;
	delivery?: string;
}
export interface ThreadItem {
	position: number;
	type: string;
	runId?: string | null;
	text?: string | null;
	textTruncated?: boolean;
}
export interface ThreadRun {
	runId: string;
	ordinal?: number;
	status: string;
}
export interface ThreadView {
	thread: {
		threadId: string;
		link?: string | null;
		status: string;
		latestRunId?: string | null;
		activeRunId?: string | null;
		pendingRequestCount?: number;
		interactionMode?: string;
		runtimeMode?: string;
		archived?: boolean;
	};
	recentRuns?: ThreadRun[];
	items?: ThreadItem[];
}

/** What the bridge needs from T3. The tests swap in a fake. */
export interface T3Api {
	ping(): Promise<void>;
	launch(args: LaunchArgs): Promise<Launched>;
	send(args: { threadId: string; message: string; mode: "queue" | "auto"; clientRequestId: string }): Promise<Sent>;
	read(args: { threadId: string; view: "messages" | "activity"; limit: number; beforePosition?: number; runLimit?: number; maxCharsPerItem?: number }): Promise<ThreadView>;
	interrupt(args: { threadId: string; reason: string }): Promise<{ status?: string }>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

const PROTOCOL = "2025-06-18";

export class T3McpClient implements T3Api {
	private sessionId?: string;
	private connecting?: Promise<void>;

	constructor(
		private readonly url: string,
		private readonly token: string,
		private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
		private readonly timeoutMs = 30_000,
	) {}

	async ping(): Promise<void> {
		this.sessionId = undefined;
		await this.ensureSession(8_000);
	}

	async launch(args: LaunchArgs): Promise<Launched> {
		return (await this.call("t3_thread_launch", args as unknown as Record<string, unknown>)) as Launched;
	}

	async send(args: { threadId: string; message: string; mode: "queue" | "auto"; clientRequestId: string }): Promise<Sent> {
		return (await this.call("t3_thread_send", args)) as Sent;
	}

	async read(args: { threadId: string; view: "messages" | "activity"; limit: number; beforePosition?: number; runLimit?: number; maxCharsPerItem?: number }): Promise<ThreadView> {
		return (await this.call("t3_thread_read", args)) as ThreadView;
	}

	async interrupt(args: { threadId: string; reason: string }): Promise<{ status?: string }> {
		return (await this.call("t3_thread_interrupt", args)) as { status?: string };
	}

	/** One tool call; a lost MCP session (T3 restarted) is opened again once. */
	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		await this.ensureSession(this.timeoutMs);
		try {
			return await this.callOnce(tool, args);
		} catch (error) {
			if (!(error instanceof SessionLost)) throw error;
			this.sessionId = undefined;
			await this.ensureSession(this.timeoutMs);
			return this.callOnce(tool, args);
		}
	}

	private async callOnce(tool: string, args: Record<string, unknown>): Promise<unknown> {
		const frame = await this.rpc("tools/call", { name: tool, arguments: args }, this.timeoutMs);
		if (frame.error) throw new T3ToolError(frame.error.message || `${tool} failed`, frame.error.code === undefined ? undefined : String(frame.error.code));
		const result = (frame.result || {}) as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
		const text = (result.content || [])
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		if (result.isError) {
			// T3 answers a refused call as {"_tag":"OrchestratorMcpFailure","code":…,"message":…}.
			try {
				const failure = JSON.parse(text) as { code?: string; message?: string };
				throw new T3ToolError(failure.message || text || `${tool} failed`, failure.code);
			} catch (error) {
				if (error instanceof T3ToolError) throw error;
				throw new T3ToolError(text.slice(0, 500) || `${tool} failed`);
			}
		}
		if (result.structuredContent !== undefined) return result.structuredContent;
		try {
			return JSON.parse(text);
		} catch {
			return { text };
		}
	}

	private ensureSession(timeoutMs: number): Promise<void> {
		if (this.sessionId) return Promise.resolve();
		if (!this.connecting)
			this.connecting = (async () => {
				const frame = await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "mochi-t3-bridge", version: "1" } }, timeoutMs, true);
				if (frame.error) throw new T3ToolError(frame.error.message || "MCP initialize failed");
				await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs).catch(() => undefined);
			})().finally(() => {
				this.connecting = undefined;
			});
		return this.connecting;
	}

	private async post(body: unknown, timeoutMs: number): Promise<Response> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${this.token}`,
			"MCP-Protocol-Version": PROTOCOL,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
		let response: Response;
		try {
			response = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
		} catch (error) {
			// Connection refused, DNS, timeout: the PC is off or asleep, or T3 isn't running.
			const name = error instanceof Error ? error.name : "";
			const inner = (error as { cause?: unknown } | null)?.cause;
			const cause = inner instanceof Error ? ` (${(inner as NodeJS.ErrnoException).code || inner.name})` : "";
			throw new T3Unreachable(name === "TimeoutError" || name === "AbortError" ? "T3 did not answer in time" : `T3 is unreachable${cause}`);
		}
		return response;
	}

	private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number, initializing = false): Promise<{ result?: unknown; error?: { message?: string; code?: unknown } }> {
		const id = Math.floor(Math.random() * 1e9);
		const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			throw new T3AuthError(response.status);
		}
		// A session T3 no longer knows (it restarted): open a new one.
		if (response.status === 404 && !initializing && this.sessionId) {
			await response.body?.cancel().catch(() => undefined);
			throw new SessionLost();
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			// 429 and 5xx: try again later, like an unreachable PC.
			if (response.status === 429 || response.status >= 500) throw new T3Unreachable(`T3 answered HTTP ${response.status}`, response.status);
			throw new T3ToolError(`T3 answered HTTP ${response.status}`);
		}
		if (initializing) this.sessionId = response.headers.get("Mcp-Session-Id") || undefined;
		const type = response.headers.get("Content-Type") || "";
		let text: string;
		try {
			text = await response.text();
		} catch {
			throw new T3Unreachable("T3's answer broke off");
		}
		if (!type.includes("text/event-stream")) {
			try {
				return JSON.parse(text);
			} catch {
				throw new T3ToolError("T3 sent an answer that isn't JSON");
			}
		}
		for (const line of text.split("\n")) {
			if (!line.startsWith("data:")) continue;
			try {
				const frame = JSON.parse(line.slice(5).trim());
				if (frame.id === id) return frame;
			} catch {
				/* keep scanning */
			}
		}
		throw new T3ToolError("T3 sent no answer for the request");
	}
}

class SessionLost extends Error {}
