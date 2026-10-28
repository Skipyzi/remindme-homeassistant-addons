import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Fetch, type OAuthEndpoints, SignInExpired, type Tokens, callbackFor, refreshTokens, withParams } from "./oauth";
import type { StoredConnector } from "./store";

/*
 * Signing in with Google instead of an app password. It has to be the user's
 * own Google app: an app Google has vetted for Gmail needs a paid security
 * audit, so, like Home Assistant's Google integrations, each install brings
 * its own client id and secret.
 */

export const MAIL_SCOPE = "https://mail.google.com/";
export const SAVED_CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
/** People the user has emailed but never saved: where most addresses are. */
export const OTHER_CONTACTS = "https://www.googleapis.com/auth/contacts.other.readonly";
const SCOPES = ["openid", "email", MAIL_SCOPE, SAVED_CONTACTS, OTHER_CONTACTS];

export interface GoogleEndpoints extends OAuthEndpoints {
	revoke: string;
	userinfo: string;
	people: string;
}

/** Google's addresses; GOOGLE_FAKE_BASE points them all at a stand-in for local tests. */
export function googleEndpoints(env: NodeJS.ProcessEnv = process.env): GoogleEndpoints {
	const fake = env.GOOGLE_FAKE_BASE?.replace(/\/$/, "");
	if (fake) return { authorize: `${fake}/auth`, token: `${fake}/token`, revoke: `${fake}/revoke`, userinfo: `${fake}/userinfo`, people: `${fake}/v1` };
	return {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		revoke: "https://oauth2.googleapis.com/revoke",
		userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
		people: "https://people.googleapis.com/v1",
	};
}

export interface GoogleAppConfig {
	clientId: string;
	clientSecret: string;
}

export function checkGoogleApp(input: { clientId?: unknown; clientSecret?: unknown }, current?: GoogleAppConfig): GoogleAppConfig {
	const clientId = String(input.clientId || "").trim();
	if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("The client ID ends in .apps.googleusercontent.com. Copy it from the client you made in Google Cloud.");
	const clientSecret = String(input.clientSecret || "").trim() || (current?.clientId === clientId ? current.clientSecret : "");
	if (!clientSecret) throw new Error("Paste the client secret too. Google shows it when you make the client, under Clients.");
	return { clientId, clientSecret };
}

/** The user's Google app: its client id and secret, kept on the Pi. The secret never goes back to the browser. */
export class GoogleApp {
	private config: GoogleAppConfig | undefined;

	constructor(private readonly path = process.env.GOOGLE_APP_PATH || "./data/google-app.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Partial<GoogleAppConfig>;
			this.config = saved.clientId && saved.clientSecret ? { clientId: saved.clientId, clientSecret: saved.clientSecret } : undefined;
		} catch {
			this.config = undefined;
		}
	}

	get(): GoogleAppConfig | undefined {
		return this.config;
	}

	async save(config: GoogleAppConfig): Promise<void> {
		this.config = config;
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFile(`${this.path}.tmp`, JSON.stringify(config), { mode: 0o600 });
		await rename(`${this.path}.tmp`, this.path);
		await chmod(this.path, 0o600).catch(() => {});
	}

	async clear(): Promise<void> {
		this.config = undefined;
		await rm(this.path, { force: true });
	}
}

/**
 * Where Google sends the browser back to, and the domain Google wants listed
 * for it, from the phone app's address. A ts.net name is on the public suffix
 * list, so the tailnet's own name (tailxxxx.ts.net) is the domain to list.
 */
export function googleRedirect(base: string): { redirectUri: string; domain: string } {
	const url = new URL(base);
	const parts = url.hostname.split(".");
	const plain = /^[\d.]+$/.test(url.hostname) || parts.length <= 2;
	const domain = url.hostname.endsWith(".ts.net") ? parts.slice(-3).join(".") : plain ? url.hostname : parts.slice(-2).join(".");
	return { redirectUri: callbackFor(base), domain };
}

export function googleSignInUrl(
	app: GoogleAppConfig,
	input: { redirectUri: string; state: string; challenge: string; loginHint?: string },
	endpoints: GoogleEndpoints = googleEndpoints(),
): string {
	return withParams(endpoints.authorize, {
		client_id: app.clientId,
		redirect_uri: input.redirectUri,
		response_type: "code",
		scope: SCOPES.join(" "),
		state: input.state,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		// A refresh token every time, so mail keeps working without the browser.
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
		login_hint: input.loginHint,
	});
}

const granted = (scope: string | undefined) => new Set((scope || "").split(/\s+/).filter(Boolean));

/** Who signed in and what they allowed. Mail is the point; contacts are a bonus they may untick. */
export async function googleAccount(tokens: Tokens, fetchImpl: Fetch = fetch, endpoints: GoogleEndpoints = googleEndpoints()): Promise<{ email: string; scope: string }> {
	if (!granted(tokens.scope).has(MAIL_SCOPE)) throw new Error("Google didn't give RemindMe your mail. Sign in again and leave the Gmail box ticked on Google's screen.");
	if (!tokens.refreshToken) throw new Error("Google didn't give RemindMe lasting access. Remove RemindMe at myaccount.google.com/connections, then sign in again.");
	const response = await fetchImpl(endpoints.userinfo, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15_000) });
	const info = (await response.json().catch(() => ({}))) as { email?: string; email_verified?: boolean };
	if (!response.ok || !info.email) throw new Error("Google didn't say which account signed in.");
	return { email: info.email, scope: tokens.scope || "" };
}

/** A Google mail connector: signed in, not a password. */
export const signedInWithGoogle = (connector: StoredConnector) => connector.values.auth === "google";

/**
 * Access tokens for the Google connectors, refreshed when they run out
 * (after an hour). Kept in memory only; the refresh token is the lasting part.
 */
export class GoogleTokens {
	private readonly cached = new Map<string, { token: string; until: number }>();
	private readonly running = new Map<string, Promise<string>>();

	constructor(
		private readonly app: GoogleApp,
		private readonly fetchImpl: Fetch = fetch,
		private readonly endpoints: () => GoogleEndpoints = () => googleEndpoints(),
	) {}

	/** A token for one connector, or an error that says to sign in again. */
	token(connector: StoredConnector, now = Date.now()): Promise<string> {
		const cached = this.cached.get(connector.id);
		if (cached && cached.until - 60_000 > now) return Promise.resolve(cached.token);
		const running = this.running.get(connector.id);
		if (running) return running;
		const work = this.refresh(connector).finally(() => this.running.delete(connector.id));
		this.running.set(connector.id, work);
		return work;
	}

	private async refresh(connector: StoredConnector): Promise<string> {
		const app = this.app.get();
		const address = connector.values.address || "this account";
		if (!app) throw new Error(`Google sign-in isn't set up any more, so ${address} can't be read. Add your Google app under Settings, Mail and calendars.`);
		const refreshToken = connector.secrets.refreshToken;
		if (!refreshToken) throw new Error(`Sign in to ${address} again under Settings, Mail and calendars.`);
		try {
			const tokens = await refreshTokens(this.endpoints(), { id: app.clientId, secret: app.clientSecret }, { refreshToken }, this.fetchImpl);
			this.cached.set(connector.id, { token: tokens.accessToken, until: tokens.expiresAt ?? Date.now() + 3_000_000 });
			return tokens.accessToken;
		} catch (error) {
			if (error instanceof SignInExpired) throw new Error(`Google no longer accepts RemindMe's sign-in for ${address}. Sign in again under Settings, Mail and calendars.`);
			throw error;
		}
	}

	/** Keep the access token a sign-in just brought, so the first check doesn't refresh. */
	remember(id: string, tokens: Tokens): void {
		this.cached.set(id, { token: tokens.accessToken, until: tokens.expiresAt ?? Date.now() + 3_000_000 });
	}

	forget(id: string): void {
		this.cached.delete(id);
	}

	/** Take back RemindMe's access, when the connector is removed. */
	async revoke(refreshToken: string): Promise<void> {
		await this.fetchImpl(withParams(this.endpoints().revoke, { token: refreshToken }), { method: "POST", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
	}
}

export interface Contact {
	name: string;
	emails: string[];
	account: string;
}

export interface ContactAccount {
	label: string;
	scope: string;
	token(): Promise<string>;
}

interface PeopleResult {
	results?: Array<{ person?: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }> } }>;
	error?: { message?: string; status?: string };
}

const WARM_MS = 3_600_000;

/**
 * Names to email addresses, from the signed-in Google accounts: saved
 * contacts and the people the user has written with. Read only.
 */
export class GoogleContacts {
	private readonly warmed = new Map<string, number>();

	constructor(
		private readonly accounts: () => ContactAccount[],
		private readonly fetchImpl: Fetch = fetch,
		private readonly endpoints: () => GoogleEndpoints = () => googleEndpoints(),
	) {}

	private sources(account: ContactAccount): string[] {
		const scopes = granted(account.scope);
		return [...(scopes.has(SAVED_CONTACTS) ? ["people:searchContacts"] : []), ...(scopes.has(OTHER_CONTACTS) ? ["otherContacts:search"] : [])];
	}

	get available(): boolean {
		return this.accounts().some((account) => this.sources(account).length > 0);
	}

	async find(query: string, now = Date.now()): Promise<{ people: Contact[]; problems: string[] }> {
		const people = new Map<string, Contact>();
		const problems: string[] = [];
		for (const account of this.accounts()) {
			for (const source of this.sources(account)) {
				try {
					const token = await account.token();
					const ask = async (words: string) => {
						// The warm-up's empty query is sent as query=, so not through withParams.
						const url = `${this.endpoints().people}/${source}?${new URLSearchParams({ query: words, readMask: "names,emailAddresses", pageSize: "10" })}`;
						const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
						const data = (await response.json().catch(() => ({}))) as PeopleResult;
						if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
						return data;
					};
					// Google answers searches from a cache that an empty search fills.
					const key = `${account.label}|${source}`;
					const warmed = this.warmed.get(key);
					if (warmed === undefined || now - warmed > WARM_MS) {
						await ask("");
						this.warmed.set(key, now);
					}
					for (const result of (await ask(query)).results || []) {
						const emails = (result.person?.emailAddresses || []).map((entry) => entry.value || "").filter(Boolean);
						if (!emails.length) continue;
						const name = result.person?.names?.[0]?.displayName || emails[0];
						const known = people.get(emails[0].toLowerCase());
						if (!known) people.set(emails[0].toLowerCase(), { name, emails, account: account.label });
						else for (const email of emails) if (!known.emails.some((other) => other.toLowerCase() === email.toLowerCase())) known.emails.push(email);
					}
				} catch (error) {
					const said = error instanceof Error ? error.message : String(error);
					problems.push(/has not been used|is disabled|SERVICE_DISABLED/i.test(said) ? `${account.label}: turn on the People API in your Google Cloud project (APIs & Services, Library), then try again.` : `${account.label}: ${said}`);
				}
			}
		}
		return { people: [...people.values()].slice(0, 8), problems: [...new Set(problems)] };
	}
}
