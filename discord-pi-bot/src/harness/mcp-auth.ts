import { type Fetch, SignInExpired, refreshTokens, withParams } from "../connectors/oauth";
import type { McpServer } from "./mcp";

/**
 * Signing in to an MCP server the way the MCP authorization spec lays out:
 * the server answers 401 and points at its protected-resource metadata, that
 * names the sign-in server, and RemindMe registers itself there (dynamic
 * client registration), so the user only pastes the address and signs in.
 */

/** What a server's sign-in needs, and once signed in, the tokens. Stored with the server, never sent to the browser. */
export interface McpSignIn {
	issuer: string;
	authorize: string;
	token: string;
	clientId: string;
	clientSecret?: string;
	method: "client_secret_basic" | "client_secret_post" | "none";
	redirectUri: string;
	/** The MCP server the tokens are for (RFC 8707). */
	resource: string;
	scope?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	signedInAt?: string;
}

interface Discovered {
	issuer: string;
	authorize: string;
	token: string;
	register?: string;
	resource: string;
	scope?: string;
}

/** `Bearer resource_metadata="…", scope="…"` → its parts. */
export function parseChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
	const out: { resourceMetadata?: string; scope?: string } = {};
	for (const match of (header || "").matchAll(/([a-z_]+)="([^"]*)"/gi)) {
		if (match[1].toLowerCase() === "resource_metadata") out.resourceMetadata = match[2];
		if (match[1].toLowerCase() === "scope") out.scope = match[2];
	}
	return out;
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return undefined;
		const data = (await response.json()) as unknown;
		return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
/** Sign-in addresses must be HTTPS, or plain HTTP on this machine (local tests): never javascript: or the like. */
function safeEndpoint(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const url = new URL(value);
	if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.toString();
	throw new Error("This server's sign-in isn't on a secure (https) address, so RemindMe won't use it.");
}
const trimmed = (path: string) => path.replace(/\/+$/, "");

/** Whether the server wants a sign-in: an unauthenticated initialize that comes back 401. */
export async function wantsSignIn(url: string, fetchImpl: Fetch = fetch): Promise<{ resourceMetadata?: string; scope?: string } | undefined> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "RemindMe", version: "1.0" } } }),
		signal: AbortSignal.timeout(10_000),
	});
	await response.body?.cancel().catch(() => undefined);
	return response.status === 401 ? parseChallenge(response.headers.get("WWW-Authenticate")) : undefined;
}

/** Find the server's sign-in: protected-resource metadata, then the sign-in server's own metadata. */
export async function discover(serverUrl: string, fetchImpl: Fetch = fetch): Promise<Discovered> {
	const url = new URL(serverUrl);
	const challenge = (await wantsSignIn(serverUrl, fetchImpl).catch(() => undefined)) || {};
	const path = trimmed(url.pathname);
	const resourceUrls = [challenge.resourceMetadata, path ? `${url.origin}/.well-known/oauth-protected-resource${path}` : undefined, `${url.origin}/.well-known/oauth-protected-resource`].filter(
		(entry): entry is string => Boolean(entry),
	);
	let resource: Record<string, unknown> | undefined;
	for (const candidate of [...new Set(resourceUrls)]) if ((resource = await getJson(candidate, fetchImpl))) break;

	const claimed = str(resource?.resource);
	// Tokens go to this server only: a resource on another host is refused.
	if (claimed && new URL(claimed).origin !== url.origin) throw new Error("This server's sign-in is for a different address, so RemindMe won't use it.");
	const named = str((resource?.authorization_servers as unknown[] | undefined)?.[0]);
	// Servers from before the protected-resource metadata are their own sign-in server.
	const issuer = new URL(named || url.origin);
	const issuerPath = trimmed(issuer.pathname);
	const metadataUrls = issuerPath
		? [`${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`]
		: [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
	let metadata: Record<string, unknown> | undefined;
	for (const candidate of metadataUrls) if ((metadata = await getJson(candidate, fetchImpl))) break;
	if (!metadata && named) throw new Error("This server's sign-in server didn't describe itself, so RemindMe can't sign in to it.");

	const scopes = resource?.scopes_supported;
	return {
		issuer: str(metadata?.issuer) || issuer.toString(),
		authorize: safeEndpoint(str(metadata?.authorization_endpoint) || `${issuer.origin}/authorize`) as string,
		token: safeEndpoint(str(metadata?.token_endpoint) || `${issuer.origin}/token`) as string,
		register: safeEndpoint(metadata ? str(metadata.registration_endpoint) : `${issuer.origin}/register`),
		resource: claimed || serverUrl,
		scope: challenge.scope || (Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string").join(" ") || undefined : undefined),
	};
}

/** Register RemindMe with the sign-in server (RFC 7591). */
export async function register(found: Discovered, redirectUri: string, fetchImpl: Fetch = fetch): Promise<Pick<McpSignIn, "clientId" | "clientSecret" | "method">> {
	if (!found.register) throw new Error("This server doesn't let apps sign up for its sign-in. If it gives you a token instead, add it as the token.");
	const response = await fetchImpl(found.register, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: "RemindMe",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			...(found.scope ? { scope: found.scope } : {}),
		}),
		signal: AbortSignal.timeout(15_000),
	});
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const clientId = str(data.client_id);
	if (!response.ok || !clientId) throw new Error(`The server didn't register RemindMe (${str(data.error_description) || str(data.error) || `HTTP ${response.status}`}).`);
	const secret = str(data.client_secret);
	const method = str(data.token_endpoint_auth_method);
	return {
		clientId,
		...(secret ? { clientSecret: secret } : {}),
		method: method === "client_secret_basic" || method === "client_secret_post" || method === "none" ? method : secret ? "client_secret_basic" : "none",
	};
}

/** Everything for a sign-in except the tokens: found, and registered unless the last registration still fits. */
export async function prepareSignIn(server: McpServer, redirectUri: string, fetchImpl: Fetch = fetch): Promise<McpSignIn> {
	const found = await discover(server.url, fetchImpl);
	const known = server.oauth;
	const client =
		known?.clientId && known.issuer === found.issuer && known.redirectUri === redirectUri
			? { clientId: known.clientId, clientSecret: known.clientSecret, method: known.method }
			: await register(found, redirectUri, fetchImpl);
	return { issuer: found.issuer, authorize: found.authorize, token: found.token, redirectUri, resource: found.resource, ...(found.scope ? { scope: found.scope } : {}), ...client };
}

export function mcpSignInUrl(signIn: McpSignIn, input: { state: string; challenge: string }): string {
	return withParams(signIn.authorize, {
		response_type: "code",
		client_id: signIn.clientId,
		redirect_uri: signIn.redirectUri,
		state: input.state,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		scope: signIn.scope,
		resource: signIn.resource,
	});
}

/** Keeps a signed-in server's access token fresh. */
export class McpAuth {
	private readonly running = new Map<string, Promise<boolean>>();

	constructor(
		private readonly save: (id: string, signIn: McpSignIn) => Promise<void>,
		private readonly fetchImpl: Fetch = fetch,
	) {}

	/** The Authorization header to send: a signed-in server's token, or the one the user pasted. */
	async header(server: McpServer, now = Date.now()): Promise<string | undefined> {
		const signIn = server.oauth;
		if (!signIn?.accessToken) return server.authorization;
		if (signIn.expiresAt && signIn.expiresAt - 60_000 < now) await this.refresh(server);
		return server.oauth?.accessToken ? `Bearer ${server.oauth.accessToken}` : server.authorization;
	}

	/** A new access token; false when the user has to sign in again. */
	refresh(server: McpServer): Promise<boolean> {
		const running = this.running.get(server.id);
		if (running) return running;
		const work = this.renew(server).finally(() => this.running.delete(server.id));
		this.running.set(server.id, work);
		return work;
	}

	private async renew(server: McpServer): Promise<boolean> {
		const signIn = server.oauth;
		if (!signIn) return false;
		try {
			if (!signIn.refreshToken) throw new SignInExpired("No refresh token.");
			const tokens = await refreshTokens(signIn, { id: signIn.clientId, secret: signIn.clientSecret, method: signIn.method }, { refreshToken: signIn.refreshToken, resource: signIn.resource }, this.fetchImpl);
			await this.save(server.id, { ...signIn, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || signIn.refreshToken, expiresAt: tokens.expiresAt });
			return true;
		} catch (error) {
			if (!(error instanceof SignInExpired)) throw error;
			const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...rest } = signIn;
			await this.save(server.id, rest);
			return false;
		}
	}
}
