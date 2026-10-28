import { Router } from "express";
import { type McpSignIn, mcpSignInUrl, prepareSignIn } from "../harness/mcp-auth";
import type { McpServer, McpServerStore } from "../harness/mcp";
import { type GoogleApp, type GoogleAppConfig, type GoogleTokens, OTHER_CONTACTS, SAVED_CONTACTS, checkGoogleApp, googleAccount, googleEndpoints, googleRedirect, googleSignInUrl } from "./google";
import { type Fetch, SignIns, callbackFor, exchangeCode, signInPage } from "./oauth";
import type { ConnectorStore, StoredConnector } from "./store";

export interface SignInDeps {
	/** The phone app's address: the services send the browser back there. */
	redirectBase(): Promise<string | undefined>;
	googleApp: GoogleApp;
	googleTokens: GoogleTokens;
	connectors: ConnectorStore;
	/** Connect to a mail connector and say how it went. */
	testMail(connector: StoredConnector): Promise<string>;
	mcp: { store: McpServerStore; test(server: McpServer): Promise<string> };
	/** A line for the History. */
	note(text: string): void;
	fetchImpl?: Fetch;
}

type Pending = { kind: "google"; app: GoogleAppConfig; redirectUri: string } | { kind: "mcp"; serverId: string; signIn: McpSignIn };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const NO_ADDRESS = "Signing in needs the phone app's address, because the service sends you back there. Turn the phone app on under Settings, Phone app, then try again.";

/**
 * Signing in to Google and to Connected tools. The console opens
 * /api/oauth/start in a new tab, which goes on to the service; the service
 * sends the browser back to /api/oauth/callback on the phone app's address;
 * the console asks /api/oauth/result how it went.
 */
export function signInRoutes(deps: SignInDeps): Router {
	const router = Router();
	const signIns = new SignIns<Pending>();
	const fetchImpl = deps.fetchImpl || fetch;

	router.get("/api/oauth/google-app", async (_request, response) => {
		const base = await deps.redirectBase().catch(() => undefined);
		const app = deps.googleApp.get();
		response.set("Cache-Control", "no-store").json({ set: Boolean(app), clientId: app?.clientId || "", ...(base ? googleRedirect(base) : {}) });
	});
	router.put("/api/oauth/google-app", async (request, response) => {
		try {
			const config = checkGoogleApp(request.body || {}, deps.googleApp.get());
			await deps.googleApp.save(config);
			response.json({ set: true, clientId: config.clientId });
		} catch (error) {
			response.status(400).json({ error: message(error) });
		}
	});
	router.delete("/api/oauth/google-app", async (_request, response) => {
		await deps.googleApp.clear();
		response.status(204).end();
	});

	router.get("/api/oauth/start", async (request, response) => {
		const asked = typeof request.query.handle === "string" ? request.query.handle : undefined;
		response.set("Cache-Control", "no-store");
		try {
			const base = await deps.redirectBase().catch(() => undefined);
			if (!base) throw new Error(NO_ADDRESS);
			const redirectUri = callbackFor(base);
			if (request.query.for === "google") {
				const app = deps.googleApp.get();
				if (!app) throw new Error("Add your Google app under Settings, Mail and calendars first.");
				const started = signIns.start(asked, { kind: "google", app, redirectUri });
				const hint = typeof request.query.hint === "string" ? request.query.hint.slice(0, 200) : undefined;
				return response.redirect(302, googleSignInUrl(app, { redirectUri, state: started.state, challenge: started.challenge, loginHint: hint }));
			}
			if (request.query.for === "mcp") {
				const server = deps.mcp.store.get(String(request.query.id || ""));
				if (!server) throw new Error("That tool isn't in Connected tools any more.");
				const signIn = await prepareSignIn(server, redirectUri, fetchImpl);
				const started = signIns.start(asked, { kind: "mcp", serverId: server.id, signIn });
				return response.redirect(302, mcpSignInUrl(signIn, started));
			}
			throw new Error("RemindMe doesn't know that sign-in.");
		} catch (error) {
			if (asked) signIns.finish(asked, false, message(error));
			response.status(400).type("html").send(signInPage(false, "The sign-in didn't start", message(error)));
		}
	});

	async function finishGoogle(pending: Extract<Pending, { kind: "google" }>, code: string, verifier: string): Promise<string> {
		const tokens = await exchangeCode(googleEndpoints(), { id: pending.app.clientId, secret: pending.app.clientSecret }, { code, verifier, redirectUri: pending.redirectUri }, fetchImpl);
		const account = await googleAccount(tokens, fetchImpl);
		const values = { address: account.email, auth: "google", scope: account.scope };
		const secrets = { refreshToken: tokens.refreshToken as string };
		// Signing in with an address that has an app password replaces the password.
		const existing = deps.connectors.list("mail").find((connector) => connector.preset === "gmail" && connector.values.address?.toLowerCase() === account.email.toLowerCase());
		const saved = existing
			? await deps.connectors.update(existing.id, { values, secrets, dropSecrets: ["password"], enabled: true })
			: await deps.connectors.create({ kind: "mail", preset: "gmail", name: "Gmail", enabled: true, values, secrets });
		if (!saved) throw new Error("The Gmail connector was removed while you signed in.");
		deps.googleTokens.remember(saved.id, tokens);
		deps.note(`Signed in to ${saved.name} as ${account.email}`);
		const scopes = new Set(account.scope.split(/\s+/));
		const contacts = scopes.has(SAVED_CONTACTS) || scopes.has(OTHER_CONTACTS) ? "RemindMe can look up addresses in your contacts too." : "Contacts were left unticked, so RemindMe can't look up addresses.";
		const check = await deps.testMail(saved).catch((error) => `But the mail check failed: ${message(error)}`);
		return `${account.email} is connected. ${contacts} ${check}`;
	}

	async function finishMcp(pending: Extract<Pending, { kind: "mcp" }>, code: string, verifier: string, issuer: string | undefined): Promise<string> {
		const server = deps.mcp.store.get(pending.serverId);
		if (!server) throw new Error("That tool was removed while you signed in.");
		// RFC 9207: an answer naming another sign-in server isn't this one's.
		if (issuer && issuer !== pending.signIn.issuer) throw new Error("The answer came from a different sign-in server, so RemindMe ignored it.");
		const { signIn } = pending;
		const tokens = await exchangeCode(signIn, { id: signIn.clientId, secret: signIn.clientSecret, method: signIn.method }, { code, verifier, redirectUri: signIn.redirectUri, resource: signIn.resource }, fetchImpl);
		await deps.mcp.store.setSignIn(server.id, { ...signIn, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, signedInAt: new Date().toISOString() });
		deps.note(`Signed in to ${server.name}`);
		const check = await deps.mcp.test(deps.mcp.store.get(server.id) || server).catch((error) => `But it didn't answer: ${message(error)}`);
		return `${server.name} is connected. ${check}`;
	}

	router.get("/api/oauth/callback", async (request, response) => {
		response.set("Cache-Control", "no-store");
		const found = signIns.take(String(request.query.state || ""));
		if (!found) return response.status(400).type("html").send(signInPage(false, "This sign-in has run out", "It took longer than 10 minutes, or this page was opened twice. Start it again from RemindMe's Settings."));
		const done = (ok: boolean, title: string, text: string) => {
			signIns.finish(found.handle, ok, text);
			response.status(ok ? 200 : 400).type("html").send(signInPage(ok, title, text));
		};
		const refused = request.query.error;
		if (refused) {
			const said = String(request.query.error_description || refused).slice(0, 200);
			return done(false, "Not signed in", refused === "access_denied" ? "You said no on the sign-in screen, so nothing changed." : `The service said: ${said}.`);
		}
		try {
			const code = String(request.query.code || "");
			if (!code) throw new Error("The service sent no code back.");
			const text = found.data.kind === "google" ? await finishGoogle(found.data, code, found.verifier) : await finishMcp(found.data, code, found.verifier, typeof request.query.iss === "string" ? request.query.iss : undefined);
			done(true, "Signed in", text);
		} catch (error) {
			done(false, "Not signed in", message(error));
		}
	});

	router.get("/api/oauth/result/:handle", (request, response) => {
		response.set("Cache-Control", "no-store").json(signIns.result(request.params.handle) || { state: "failed", text: "RemindMe lost track of this sign-in. Start it again." });
	});

	return router;
}
