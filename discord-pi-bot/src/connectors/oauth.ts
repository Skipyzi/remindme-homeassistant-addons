import { createHash, randomBytes } from "node:crypto";

/**
 * Signing in to an outside service with OAuth: the browser goes to the
 * service, the user agrees there, and the service sends the browser back to
 * RemindMe's callback with a code that is swapped for tokens here, on the Pi.
 * Google and the MCP servers in Connected tools both go through this.
 */

export type Fetch = typeof fetch;

export interface OAuthEndpoints {
	authorize: string;
	token: string;
}

export interface OAuthClient {
	id: string;
	secret?: string;
	/** How the secret goes to the token endpoint. */
	method?: "client_secret_basic" | "client_secret_post" | "none";
}

export interface Tokens {
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt?: number;
	/** What the user actually granted, space separated: they can untick boxes. */
	scope?: string;
}

/** The service no longer takes the saved sign-in: the user has to sign in again. */
export class SignInExpired extends Error {}

/** A PKCE pair: the challenge goes out with the sign-in, the verifier with the code. */
export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where every service sends the browser back to: the phone app's address. */
export const callbackFor = (base: string) => `${new URL(base).origin}/api/oauth/callback`;

export function withParams(endpoint: string, params: Record<string, string | undefined>): string {
	const url = new URL(endpoint);
	for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
	return url.toString();
}

async function tokenRequest(endpoints: OAuthEndpoints, client: OAuthClient, body: Record<string, string | undefined>, fetchImpl: Fetch): Promise<Tokens> {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(body)) if (value) form.set(key, value);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
	const method = client.method || (client.secret ? "client_secret_post" : "none");
	if (method === "client_secret_basic" && client.secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}`;
	else {
		form.set("client_id", client.id);
		if (method === "client_secret_post" && client.secret) form.set("client_secret", client.secret);
	}
	const response = await fetchImpl(endpoints.token, { method: "POST", headers, body: form, signal: AbortSignal.timeout(20_000) });
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof data.access_token !== "string") {
		const code = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
		const said = typeof data.error_description === "string" ? ` (${data.error_description})` : "";
		if (code === "invalid_grant") throw new SignInExpired(`The sign-in is no longer valid${said}.`);
		throw new Error(`The sign-in server said ${code}${said}.`);
	}
	const lasts = Number(data.expires_in);
	return {
		accessToken: data.access_token,
		...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
		...(lasts > 0 ? { expiresAt: Date.now() + lasts * 1000 } : {}),
		...(typeof data.scope === "string" ? { scope: data.scope } : {}),
	};
}

/** Swap the code from the callback for tokens. */
export function exchangeCode(
	endpoints: OAuthEndpoints,
	client: OAuthClient,
	input: { code: string; verifier: string; redirectUri: string; resource?: string },
	fetchImpl: Fetch = fetch,
): Promise<Tokens> {
	return tokenRequest(endpoints, client, { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: input.resource }, fetchImpl);
}

/** A fresh access token from the refresh token. Throws SignInExpired when it was revoked. */
export function refreshTokens(endpoints: OAuthEndpoints, client: OAuthClient, input: { refreshToken: string; resource?: string }, fetchImpl: Fetch = fetch): Promise<Tokens> {
	return tokenRequest(endpoints, client, { grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource }, fetchImpl);
}

export interface SignInResult {
	state: "waiting" | "done" | "failed";
	text: string;
}

const PENDING_MS = 10 * 60_000;
const HANDLE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Sign-ins under way. Each gets a one-time state for the round trip through
 * the service, and a handle the console picked so it can ask how it went:
 * the callback lands in another tab, or in Safari on an iPhone.
 */
export class SignIns<T> {
	private readonly pending = new Map<string, { data: T; verifier: string; handle: string; at: number }>();
	private readonly results = new Map<string, SignInResult & { at: number }>();

	start(handle: string | undefined, data: T, now = Date.now()): { state: string; challenge: string; handle: string } {
		this.sweep(now);
		const state = randomBytes(18).toString("base64url");
		const { verifier, challenge } = pkcePair();
		const id = handle && HANDLE.test(handle) ? handle : randomBytes(12).toString("base64url");
		this.pending.set(state, { data, verifier, handle: id, at: now });
		this.results.set(id, { state: "waiting", text: "Waiting for the sign-in.", at: now });
		return { state, challenge, handle: id };
	}

	/** The sign-in a callback belongs to, once. */
	take(state: string, now = Date.now()): { data: T; verifier: string; handle: string } | undefined {
		this.sweep(now);
		const found = this.pending.get(state);
		this.pending.delete(state);
		return found;
	}

	finish(handle: string, ok: boolean, text: string, now = Date.now()): void {
		this.results.set(handle, { state: ok ? "done" : "failed", text, at: now });
	}

	result(handle: string, now = Date.now()): SignInResult | undefined {
		this.sweep(now);
		const found = this.results.get(handle);
		return found && { state: found.state, text: found.text };
	}

	private sweep(now: number) {
		for (const [state, entry] of this.pending) if (now - entry.at > PENDING_MS) this.pending.delete(state);
		for (const [handle, entry] of this.results) if (now - entry.at > PENDING_MS) this.results.delete(handle);
	}
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The page the browser lands on after a sign-in: plain, and safe for any text. */
export function signInPage(ok: boolean, title: string, text: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RemindMe: ${escape(title)}</title>
<style>
@font-face{font-family:"Geist Mono";src:url("../../fonts/geist-mono.woff2") format("woff2");font-weight:100 900}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#f2f2f2;font:15px/1.5 "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .75rem;color:${ok ? "#f2f2f2" : "#ff6b5e"}}
p{margin:0 0 1.25rem;color:#b5b5b5}
a{color:#f2f2f2}
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p><p>You can close this tab and go back to RemindMe. <a href="../../">Open RemindMe</a></p></main></body></html>`;
}
