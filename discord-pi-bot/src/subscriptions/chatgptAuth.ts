import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server } from "node:http";
import lockfile from "proper-lockfile";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK = "http://127.0.0.1:1455/auth/callback";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

interface Account {
	clientId: string; subject: string; email?: string; idToken: string;
	accessToken: string; refreshToken: string; expiresAt: number; scopes: string[];
}
interface StoredAuth { hostId: string; account?: Account; registrationId?: string }
interface Attempt { id: string; state: string; nonce: string; verifier: string; clientId: string; expiresAt: number; subject?: string }

export class ChatGptAuth {
	private attempt?: Attempt;
	private listener?: Server;
	private timer?: ReturnType<typeof setTimeout>;
	private loginError = "";
	constructor(private readonly path = process.env.CHATGPT_AUTH_PATH || "./data/chatgpt-auth.json", private readonly verifyKey: JWTVerifyGetKey = JWKS, private readonly callbackPort = 1455) {}

	private async read(): Promise<StoredAuth> {
		try { return JSON.parse(await readFile(this.path, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { hostId: "" }; }
	}
	private async write(data: StoredAuth) {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
		await rename(temporary, this.path);
	}
	private async locked<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
		try { return await fn(); } finally { await release(); }
	}
	async status() {
		const { account } = await this.read();
		return { connected: Boolean(account), sharing: Boolean(account?.scopes.includes("chatgpt.tokens.use.direct")), email: account?.email || "", pending: Boolean(this.attempt), error: this.loginError };
	}
	async start() {
		this.cancel();
		this.loginError = "";
		const data = await this.locked(async () => {
			const stored = await this.read();
			if (!stored.hostId) { stored.hostId = `urn:uuid:${randomUUID()}`; await this.write(stored); }
			return stored;
		});
		const clientId = data.account?.clientId || data.registrationId || "dynamic_agent_client";
		const attempt: Attempt = { id: randomUUID(), state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"), verifier: randomBytes(48).toString("base64url"), clientId, expiresAt: Date.now() + 600_000, subject: data.account?.subject };
		// A loopback callback can be reached through an SSH tunnel. The UI also
		// accepts the full callback URL when the browser runs on another host.
		this.listener = createServer(async (request, response) => {
			const url = new URL(request.url || "/", CALLBACK);
			if (url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
			try {
				await this.complete(attempt.id, url.toString());
				response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("RemindMe is connected to ChatGPT. You can close this tab.");
			} catch { response.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in failed. Return to RemindMe and start again."); }
		});
		await new Promise<void>((resolve, reject) => {
			this.listener!.once("error", reject);
			this.listener!.listen(this.callbackPort, "127.0.0.1", resolve);
		});
		this.attempt = attempt;
		this.timer = setTimeout(() => this.cancel(), 600_000);
		this.timer.unref();
		const url = new URL(`${ISSUER}/api/accounts/authorize`);
		url.search = new URLSearchParams({ client_id: clientId, ext_agent_host_id: data.hostId, response_type: "code", redirect_uri: CALLBACK, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url") }).toString();
		if (clientId === "dynamic_agent_client") url.searchParams.set("agent_name_hint", "RemindMe Home Assistant");
		if (data.account?.idToken) url.searchParams.set("id_token_hint", data.account.idToken);
		return { attemptId: attempt.id, url: url.toString(), instructions: "Sign in and approve ChatGPT plan usage. If the final 127.0.0.1 page cannot connect, copy its full address and paste it below." };
	}
	async complete(id: string, callback: string) {
		const attempt = this.attempt;
		if (!attempt || attempt.id !== id || Date.now() > attempt.expiresAt) throw new Error("This sign-in attempt expired. Start again.");
		const url = new URL(callback);
		if (url.origin !== new URL(CALLBACK).origin || url.pathname !== "/auth/callback" || url.searchParams.get("state") !== attempt.state)
			throw new Error("The callback does not match this sign-in attempt.");
		if (url.searchParams.has("error")) { this.cancel(); throw new Error("ChatGPT sign-in was declined."); }
		const clientId = url.searchParams.get("client_id") || (attempt.clientId !== "dynamic_agent_client" ? attempt.clientId : "");
		if (!clientId || clientId === "dynamic_agent_client" || (attempt.clientId !== "dynamic_agent_client" && clientId !== attempt.clientId)) throw new Error("ChatGPT did not return the expected client registration.");
		const code = url.searchParams.get("code");
		if (!code) throw new Error("The callback has no authorization code.");
		// Claim the attempt before exchanging its one-use code.
		this.attempt = undefined;
		try {
			await this.locked(async () => {
				const data = await this.read();
				data.registrationId = clientId;
				await this.write(data);
				const tokens = await this.tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: CALLBACK, resource: RESOURCE });
				const { payload } = await jwtVerify(tokens.id_token, this.verifyKey, { issuer: ISSUER, audience: clientId, requiredClaims: ["exp", "iat", "sub", "nonce"] });
				if (payload.nonce !== attempt.nonce || !payload.sub || (attempt.subject && payload.sub !== attempt.subject)) throw new Error("ChatGPT account identity could not be verified.");
				const scopes = String(tokens.scope || "").split(/\s+/);
				if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("Enable ChatGPT plan usage in the sign-in permissions.");
				data.account = { clientId, subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined, idToken: tokens.id_token, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, scopes };
				await this.write(data);
			});
		} catch (error) { this.loginError = error instanceof Error ? error.message : "Sign-in failed"; throw error; }
		finally { this.cancel(); }
		return this.status();
	}
	private async tokenRequest(values: Record<string, string>) {
		const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values), signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`ChatGPT authorization failed with HTTP ${response.status}. Sign in again.`);
		const tokens = await response.json() as { access_token: string; refresh_token: string; id_token: string; expires_in: number; scope: string };
		if (!tokens.access_token || !tokens.refresh_token || (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) throw new Error("ChatGPT returned incomplete credentials.");
		return tokens;
	}
	async accessToken(): Promise<string> {
		return this.locked(async () => {
			const data = await this.read();
			const account = data.account;
			if (!account?.scopes.includes("chatgpt.tokens.use.direct")) throw new Error("Connect your ChatGPT account under Models first.");
			if (account.expiresAt < Date.now() + 60_000) {
				const tokens = await this.tokenRequest({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
				const scopes = tokens.scope ? tokens.scope.split(/\s+/) : account.scopes;
				if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage permission was removed. Sign in again.");
				Object.assign(account, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, scopes });
				await this.write(data);
			}
			return account.accessToken;
		});
	}
	async models() {
		const token = await this.accessToken();
		const response = await fetch(`${RESOURCE}/models`, { redirect: "error", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Could not list ChatGPT models: HTTP ${response.status}`);
		const data = await response.json() as { models?: Array<{ slug: string; display_name: string; visibility: string }> };
		return (data.models || []).filter((model) => model.visibility === "list").map((model) => ({ id: model.slug, name: model.display_name }));
	}
	cancel() { this.attempt = undefined; this.listener?.close(); this.listener = undefined; if (this.timer) clearTimeout(this.timer); }
	async logout() { this.cancel(); await this.locked(async () => { const data = await this.read(); delete data.account; delete data.registrationId; await this.write(data); }); }
}

export const chatgptAuth = new ChatGptAuth();
