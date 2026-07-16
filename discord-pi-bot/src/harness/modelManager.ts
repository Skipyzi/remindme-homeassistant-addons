import { randomBytes as secureRandomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SupervisorAddon {
	slug: string;
	name?: string;
}

export interface PairingDependencies {
	secretPath: string;
	listAddons: () => Promise<SupervisorAddon[]>;
	updateOptions: (
		slug: string,
		options: Record<string, unknown>,
	) => Promise<void>;
	randomBytes?: () => Buffer;
}

export interface Pairing {
	addonSlug: string;
	configured: true;
}

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
	) {
		super(message);
		this.name = "ModelManagerError";
	}
}

export function deriveManagerUrl(completionUrl: string): string {
	let url: URL;
	try {
		url = new URL(completionUrl);
	} catch {
		throw new Error("Model manager endpoint must be a valid URL");
	}
	if (
		url.protocol !== "http:" ||
		!["homeassistant", "localhost", "127.0.0.1"].includes(url.hostname)
	) {
		throw new Error("Model manager must use the internal add-on network");
	}
	url.pathname = "/manager/v1";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export async function readManagerToken(secretPath: string): Promise<string> {
	const token = (await readFile(secretPath, "utf8")).trim();
	if (token.length < 32) throw new Error("Model manager pairing is invalid");
	return token;
}

async function loadOrCreateToken(
	secretPath: string,
	generate: () => Buffer,
): Promise<string> {
	try {
		return await readManagerToken(secretPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const token = generate().toString("base64url");
	if (token.length < 32)
		throw new Error("Generated model manager secret is too short");
	await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
	await writeFile(secretPath, token, { encoding: "utf8", mode: 0o600 });
	return token;
}

export async function ensureModelManagerPairing(
	dependencies: PairingDependencies,
): Promise<Pairing> {
	const token = await loadOrCreateToken(
		dependencies.secretPath,
		dependencies.randomBytes || (() => secureRandomBytes(32)),
	);
	const addons = await dependencies.listAddons();
	const addon = addons.find(
		(item) =>
			item.slug === "local_llama_cpp" ||
			item.slug.endsWith("_local_llama_cpp") ||
			item.name?.toLowerCase() === "local llama.cpp",
	);
	if (!addon) throw new Error("Local llama.cpp add-on was not found");
	await dependencies.updateOptions(addon.slug, { manager_token: token });
	return { addonSlug: addon.slug, configured: true };
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
		} catch {
			throw new ModelManagerError(
				"manager_unavailable",
				"Local model manager is unavailable.",
				503,
				true,
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
