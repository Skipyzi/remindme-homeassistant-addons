import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
	CANONICAL_MANAGER_URL,
	canonicalLocalEndpoint,
} from "./localEndpoints";

export interface ManagerAPIError {
	code?: string;
	message?: string;
	retryable?: boolean;
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class ModelManagerError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
		public readonly retryable = false,
		/**
		 * The underlying transport failure, when there was one. Every network
		 * fault used to collapse into an identical "unavailable" message with
		 * the cause discarded, which made the manager impossible to diagnose:
		 * a DNS miss, a refused connection and a timeout all read the same.
		 */
		public readonly detail?: string,
	) {
		super(message);
		this.name = "ModelManagerError";
	}
}

/** Node nests the useful part of a fetch failure one or two levels down. */
export function describeTransportError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current; depth += 1) {
		if (current instanceof Error) {
			const code = (current as NodeJS.ErrnoException).code;
			parts.push(code ? `${current.message} (${code})` : current.message);
			current = (current as { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(" <- ") || "unknown transport failure";
}

export function deriveManagerUrl(completionUrl: string): string {
	canonicalLocalEndpoint(completionUrl, "inference");
	return CANONICAL_MANAGER_URL;
}

export async function readManagerToken(secretPath: string): Promise<string> {
	const token = (await readFile(secretPath, "utf8")).trim();
	if (token.length < 32) throw new Error("Model manager pairing is invalid");
	return token;
}

export async function managerPairingConfigured(
	secretPath: string,
): Promise<boolean> {
	try {
		await readManagerToken(secretPath);
		return true;
	} catch {
		return false;
	}
}

async function writeManagerToken(secretPath: string, token: string) {
	await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
	const temporary = `${secretPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, token, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await chmod(temporary, 0o600);
		await rename(temporary, secretPath);
		await chmod(secretPath, 0o600);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

export async function pairModelManager(
	baseUrl: string,
	code: string,
	secretPath: string,
	requestFetch: FetchLike = fetch,
): Promise<void> {
	if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code))
		throw new ModelManagerError(
			"invalid_request",
			"Pairing code must contain six valid characters.",
			400,
		);
	deriveManagerUrl(
		`${baseUrl.replace(/\/manager\/v1\/?$/, "")}/v1/chat/completions`,
	);
	let response: Response;
	try {
		response = await requestFetch(`${baseUrl.replace(/\/$/, "")}/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		throw new ModelManagerError(
			"manager_unavailable",
			"Local model manager is unavailable.",
			503,
			true,
			describeTransportError(error),
		);
	}
	const body = (await response.json().catch(() => ({}))) as ManagerAPIError & {
		token?: unknown;
	};
	if (!response.ok)
		throw new ModelManagerError(
			body.code || "pairing_failed",
			body.message || "Model manager pairing failed.",
			response.status,
			Boolean(body.retryable),
		);
	if (typeof body.token !== "string" || body.token.length < 32)
		throw new ModelManagerError(
			"pairing_failed",
			"Model manager returned an invalid pairing response.",
			502,
		);
	await writeManagerToken(secretPath, body.token);
}

export class ModelManagerClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: () => Promise<string>,
		private readonly requestFetch: FetchLike = fetch,
	) {
		deriveManagerUrl(
			`${baseUrl.replace(/\/manager\/v1\/?$/, "")}/v1/chat/completions`,
		);
	}

	async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		if (!path.startsWith("/")) throw new Error("Manager path must be absolute");
		const token = await this.token();
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body !== undefined && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		let response: Response;
		try {
			response = await this.requestFetch(`${this.baseUrl}${path}`, {
				...init,
				headers,
				signal: init.signal || AbortSignal.timeout(130_000),
			});
		} catch (error) {
			throw new ModelManagerError(
				"manager_unavailable",
				"Local model manager is unavailable.",
				503,
				true,
				describeTransportError(error),
			);
		}
		const body = (await response.json().catch(() => ({}))) as ManagerAPIError;
		if (!response.ok) {
			throw new ModelManagerError(
				body.code || "manager_error",
				body.message || "Local model operation failed.",
				response.status,
				Boolean(body.retryable),
			);
		}
		return body as T;
	}

	async requestText(
		path: string,
	): Promise<{ body: string; contentType: string }> {
		if (!path.startsWith("/")) throw new Error("Manager path must be absolute");
		const token = await this.token();
		let response: Response;
		try {
			response = await this.requestFetch(`${this.baseUrl}${path}`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(130_000),
			});
		} catch (error) {
			throw new ModelManagerError(
				"manager_unavailable",
				"Local model manager is unavailable.",
				503,
				true,
				describeTransportError(error),
			);
		}
		const body = await response.text();
		if (!response.ok) {
			let error: ManagerAPIError = {};
			try {
				error = JSON.parse(body) as ManagerAPIError;
			} catch {
				error = {};
			}
			throw new ModelManagerError(
				error.code || "manager_error",
				error.message || "Local model operation failed.",
				response.status,
				Boolean(error.retryable),
			);
		}
		return {
			body,
			contentType:
				response.headers.get("content-type") || "text/plain; charset=utf-8",
		};
	}

	async openEvents(signal: AbortSignal): Promise<Response> {
		const token = await this.token();
		const response = await this.requestFetch(`${this.baseUrl}/events`, {
			headers: { Authorization: `Bearer ${token}` },
			signal,
		});
		if (!response.ok || !response.body) {
			throw new ModelManagerError(
				"stream_unavailable",
				"Model progress stream is unavailable.",
				response.status,
				true,
			);
		}
		return response;
	}
}
