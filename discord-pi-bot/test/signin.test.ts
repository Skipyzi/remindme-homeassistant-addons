import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { GoogleApp, GoogleTokens, MAIL_SCOPE, SAVED_CONTACTS } from "../src/connectors/google.ts";
import { signInRoutes } from "../src/connectors/signin-routes.ts";
import { ConnectorStore } from "../src/connectors/store.ts";
import { McpAuth, discover, parseChallenge } from "../src/harness/mcp-auth.ts";
import { McpServerStore, connect, publicMcp } from "../src/harness/mcp.ts";

const temp = () => mkdtempSync(join(tmpdir(), "signin-"));

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const body = (request: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => resolve(raw));
	});
const send = (response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) =>
	response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(data));

/** An MCP server with its own sign-in, the way Notion and Linear do it, at /mcp with the sign-in server at /as. */
function fakeTools() {
	const state = { registered: 0, access: "", refresh: "", challenge: "", resource: "", base: "" };
	const server = createServer(async (request, response) => {
		const url = new URL(request.url || "/", state.base);
		const raw = await body(request);
		const issuer = `${state.base}/as`;
		if (url.pathname === "/mcp") {
			if (!state.access || request.headers.authorization !== `Bearer ${state.access}`)
				return send(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="tasks"` });
			const rpc = JSON.parse(raw);
			if (!("id" in rpc)) return response.writeHead(202).end();
			const result = rpc.method === "initialize" ? { serverInfo: { name: "Tasks" } } : rpc.method === "tools/list" ? { tools: [{ name: "list_tasks" }] } : { content: [{ type: "text", text: "Buy milk" }] };
			return send(response, 200, { jsonrpc: "2.0", id: rpc.id, result }, { "Mcp-Session-Id": "s1" });
		}
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(response, 200, { resource: `${state.base}/mcp`, authorization_servers: [issuer], scopes_supported: ["tasks"] });
		if (url.pathname === "/.well-known/oauth-authorization-server/as")
			return send(response, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ["S256"] });
		if (url.pathname === "/as/register") {
			state.registered++;
			const asked = JSON.parse(raw);
			assert.equal(asked.token_endpoint_auth_method, "none");
			return send(response, 201, { client_id: `client-${state.registered}`, redirect_uris: asked.redirect_uris, token_endpoint_auth_method: "none" });
		}
		if (url.pathname === "/as/authorize") {
			state.challenge = url.searchParams.get("code_challenge") || "";
			state.resource = url.searchParams.get("resource") || "";
			const back = new URL(url.searchParams.get("redirect_uri") || "");
			back.searchParams.set("code", "code-1");
			back.searchParams.set("state", url.searchParams.get("state") || "");
			back.searchParams.set("iss", issuer);
			return response.writeHead(302, { Location: back.toString() }).end();
		}
		if (url.pathname === "/as/token") {
			const form = new URLSearchParams(raw);
			if (form.get("grant_type") === "authorization_code") {
				if (createHash("sha256").update(form.get("code_verifier") || "").digest("base64url") !== state.challenge) return send(response, 400, { error: "invalid_grant" });
				if (form.get("resource") !== `${state.base}/mcp`) return send(response, 400, { error: "invalid_target" });
				state.access = "access-1";
				state.refresh = "refresh-1";
				return send(response, 200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600, token_type: "Bearer" });
			}
			if (form.get("refresh_token") !== state.refresh) return send(response, 400, { error: "invalid_grant" });
			state.access = "access-2";
			return send(response, 200, { access_token: state.access, expires_in: 3600, token_type: "Bearer" });
		}
		response.writeHead(404).end();
	});
	return { server, state };
}

/** Google's sign-in, userinfo and token endpoints. */
function fakeGoogle(scope: string) {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://google.test");
		await body(request);
		if (url.pathname === "/auth") {
			const back = new URL(url.searchParams.get("redirect_uri") || "");
			back.searchParams.set("code", "g-code");
			back.searchParams.set("state", url.searchParams.get("state") || "");
			return response.writeHead(302, { Location: back.toString() }).end();
		}
		if (url.pathname === "/token") return send(response, 200, { access_token: "g-at", refresh_token: "g-rt", expires_in: 3599, scope });
		if (url.pathname === "/userinfo") return send(response, 200, { email: "me@gmail.com", email_verified: true });
		response.writeHead(404).end();
	});
	return server;
}

/** Follow a sign-in the way a browser would: start, the service's screen, back to the callback. */
async function signIn(start: string): Promise<{ status: number; page: string }> {
	let next = start;
	for (let hop = 0; hop < 4; hop++) {
		const response = await fetch(next, { redirect: "manual" });
		const location = response.headers.get("location");
		if (!location) return { status: response.status, page: await response.text() };
		next = new URL(location, next).toString();
	}
	throw new Error("Too many redirects");
}

async function harness(context: test.TestContext, extra: { testMail?: () => Promise<string> } = {}) {
	const dir = temp();
	const store = new McpServerStore(join(dir, "mcp.json"));
	const connectors = new ConnectorStore(join(dir, "connectors.json"));
	const googleApp = new GoogleApp(join(dir, "google.json"));
	const notes: string[] = [];
	const app = express();
	app.use(express.json());
	let base = "";
	app.use(
		signInRoutes({
			redirectBase: async () => base,
			googleApp,
			googleTokens: new GoogleTokens(googleApp),
			connectors,
			testMail: extra.testMail || (async () => "Connected: 3 messages in the inbox."),
			mcp: {
				store,
				test: async (server) => `${(await connect({ ...server, authorization: `Bearer ${server.oauth?.accessToken}` })).tools.length} tool`,
			},
			note: (text) => notes.push(text),
		}),
	);
	const server = createServer(app);
	base = await listen(server);
	context.after(() => server.close());
	return { base, store, connectors, googleApp, notes };
}

test("a challenge header gives the metadata address and the scope", () => {
	assert.deepEqual(parseChallenge('Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", scope="default"'), {
		resourceMetadata: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
		scope: "default",
	});
	assert.deepEqual(parseChallenge(null), {});
});

test("a Connected tool signs in with nothing but its address: found, registered, swapped, used", async (context) => {
	const tools = fakeTools();
	tools.state.base = await listen(tools.server);
	context.after(() => tools.server.close());
	const found = await discover(`${tools.state.base}/mcp`);
	assert.equal(found.issuer, `${tools.state.base}/as`);
	assert.equal(found.register, `${tools.state.base}/as/register`);
	assert.equal(found.scope, "tasks");

	const { base, store, notes } = await harness(context);
	const added = await store.create({ name: "Tasks", url: `${tools.state.base}/mcp` });
	const done = await signIn(`${base}/api/oauth/start?for=mcp&id=${added.id}&handle=handle-0001`);
	assert.equal(done.status, 200, done.page);
	assert.match(done.page, /Tasks is connected\. 1 tool/);
	assert.equal(tools.state.resource, `${tools.state.base}/mcp`, "the token is asked for this server");
	const saved = store.get(added.id);
	assert.equal(saved?.oauth?.accessToken, "access-1");
	assert.equal(saved?.wantsSignIn, false);
	const shown = publicMcp(saved!);
	assert.equal(shown.signedIn, true);
	assert.ok(!JSON.stringify(shown).includes("access-1") && !JSON.stringify(store.list()).includes("refresh-1"), "tokens never reach the console");
	assert.deepEqual(await (await fetch(`${base}/api/oauth/result/handle-0001`)).json(), { state: "done", text: "Tasks is connected. 1 tool" });
	assert.deepEqual(notes, ["Signed in to Tasks"]);

	// Signing in again reuses the registration.
	await signIn(`${base}/api/oauth/start?for=mcp&id=${added.id}&handle=handle-0002`);
	assert.equal(tools.state.registered, 1);

	// A used callback can't be replayed.
	const replay = await fetch(`${base}/api/oauth/callback?code=code-1&state=whatever`);
	assert.equal(replay.status, 400);
	assert.match(await replay.text(), /run out/);
});

test("a run-out token is refreshed before use; a refused refresh asks for a new sign-in", async (context) => {
	const tools = fakeTools();
	tools.state.base = await listen(tools.server);
	context.after(() => tools.server.close());
	const store = new McpServerStore(join(temp(), "mcp.json"));
	const added = await store.create({ name: "Tasks", url: `${tools.state.base}/mcp` });
	tools.state.refresh = "refresh-1";
	const signedIn = { issuer: `${tools.state.base}/as`, authorize: `${tools.state.base}/as/authorize`, token: `${tools.state.base}/as/token`, clientId: "client-1", method: "none" as const, redirectUri: "http://x/cb", resource: `${tools.state.base}/mcp` };
	await store.setSignIn(added.id, { ...signedIn, accessToken: "access-old", refreshToken: "refresh-1", expiresAt: Date.now() - 1000 });
	const auth = new McpAuth((id, signIn) => store.setSignIn(id, signIn));
	assert.equal(await auth.header(store.get(added.id)!), "Bearer access-2");
	assert.equal(store.get(added.id)?.oauth?.refreshToken, "refresh-1", "the refresh token stays when no new one comes");

	tools.state.refresh = "revoked";
	assert.equal(await auth.refresh(store.get(added.id)!), false);
	assert.equal(store.get(added.id)?.oauth?.accessToken, undefined);
	assert.equal(store.get(added.id)?.oauth?.clientId, "client-1", "the registration is kept for the next sign-in");
	assert.equal(store.get(added.id)?.wantsSignIn, true);
});

test("an older server without metadata is its own sign-in server; a resource on another host is refused", async (context) => {
	let base = "";
	const legacy = createServer((request, response) => {
		if (request.url === "/mcp") return send(response, 401, {}, { "WWW-Authenticate": "Bearer" });
		if (request.url === "/.well-known/oauth-protected-resource") return send(response, 200, { resource: "https://elsewhere.test/mcp", authorization_servers: [base] });
		response.writeHead(404).end();
	});
	base = await listen(legacy);
	context.after(() => legacy.close());
	await assert.rejects(discover(`${base}/mcp`), /different address/);

	const sneaky = createServer((request, response) => {
		if (request.url === "/.well-known/oauth-authorization-server") return send(response, 200, { issuer: "x", authorization_endpoint: "javascript:alert(1)", token_endpoint: "http://evil.test/token" });
		response.writeHead(404).end();
	});
	const sneakyBase = await listen(sneaky);
	context.after(() => sneaky.close());
	await assert.rejects(discover(`${sneakyBase}/mcp`), /secure \(https\) address/);

	const older = createServer((_request, response) => response.writeHead(404).end());
	const olderBase = await listen(older);
	context.after(() => older.close());
	const found = await discover(`${olderBase}/mcp`);
	assert.deepEqual([found.authorize, found.token, found.register], [`${olderBase}/authorize`, `${olderBase}/token`, `${olderBase}/register`]);
});

test("signing in with Google turns an app-password Gmail into a signed-in one, and says what was allowed", async (context) => {
	const google = fakeGoogle(`openid email ${MAIL_SCOPE} ${SAVED_CONTACTS}`);
	process.env.GOOGLE_FAKE_BASE = await listen(google);
	context.after(() => {
		google.close();
		delete process.env.GOOGLE_FAKE_BASE;
	});
	const { base, connectors, notes } = await harness(context);

	const early = await signIn(`${base}/api/oauth/start?for=google&handle=handle-g001`);
	assert.equal(early.status, 400);
	assert.match(early.page, /Add your Google app/);
	assert.equal((await (await fetch(`${base}/api/oauth/result/handle-g001`)).json()).state, "failed");

	const bad = await fetch(`${base}/api/oauth/google-app`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "nope" }) });
	assert.equal(bad.status, 400);
	const put = await fetch(`${base}/api/oauth/google-app`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "1-a.apps.googleusercontent.com", clientSecret: "GOCSPX-x" }) });
	assert.equal(put.status, 200);
	const shown = await (await fetch(`${base}/api/oauth/google-app`)).json();
	assert.deepEqual(shown, { set: true, clientId: "1-a.apps.googleusercontent.com", redirectUri: `${base}/api/oauth/callback`, domain: "127.0.0.1" });

	const old = await connectors.create({ kind: "mail", preset: "gmail", name: "Gmail", enabled: true, values: { address: "Me@gmail.com" }, secrets: { password: "app password" } });
	const done = await signIn(`${base}/api/oauth/start?for=google&handle=handle-g002`);
	assert.equal(done.status, 200, done.page);
	assert.match(done.page, /me@gmail\.com is connected\. RemindMe can look up addresses in your contacts too\. Connected: 3 messages in the inbox\./);
	const mail = connectors.list("mail");
	assert.equal(mail.length, 1, "the same address isn't added twice");
	assert.equal(mail[0].id, old.id);
	assert.equal(mail[0].values.auth, "google");
	assert.deepEqual(Object.keys(mail[0].secrets), ["refreshToken"], "the app password is gone");
	assert.deepEqual(notes, ["Signed in to Gmail as me@gmail.com"]);

	const refused = await fetch(`${base}/api/oauth/callback?state=nothing&error=access_denied`);
	assert.equal(refused.status, 400);
});

test("a refusal on the service's screen changes nothing and says so", async (context) => {
	const { base, googleApp, connectors } = await harness(context);
	await googleApp.save({ clientId: "1-a.apps.googleusercontent.com", clientSecret: "s" });
	process.env.GOOGLE_FAKE_BASE = "http://127.0.0.1:9";
	context.after(() => delete process.env.GOOGLE_FAKE_BASE);
	const start = await fetch(`${base}/api/oauth/start?for=google&handle=handle-g003`, { redirect: "manual" });
	const state = new URL(start.headers.get("location") || "").searchParams.get("state");
	const page = await fetch(`${base}/api/oauth/callback?state=${state}&error=access_denied`);
	assert.match(await page.text(), /You said no on the sign-in screen/);
	assert.equal(connectors.list().length, 0);
	assert.equal((await (await fetch(`${base}/api/oauth/result/handle-g003`)).json()).state, "failed");
});
