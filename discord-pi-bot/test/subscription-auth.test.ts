import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { ChatGptAuth, chatgptAuth } from "../src/harness/chatgptAuth";
import { ClaudeAuth, claudeCompletion } from "../src/harness/claudeAuth";
import { modelFetch } from "../src/harness/providerRequests";
import { EndpointStore } from "../src/harness/endpoints";
import { streamText } from "../src/agent/llm";
import { responseText } from "../src/harness/responses";

test("ChatGPT sign-in verifies state, nonce and identity, and protects credentials", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-oauth-"));
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const auth = new ChatGptAuth(join(directory, "account.json"), async () => publicKey, 0);
	context.after(async () => { auth.cancel(); await rm(directory, { recursive: true, force: true }); });
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	const first = await auth.start();
	const url = new URL(first.url);
	assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
	assert.match(url.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
	const callback = new URL("http://127.0.0.1:1455/auth/callback");
	callback.search = new URLSearchParams({ state: "wrong", code: "single-use-code", client_id: "oaiapp_remindme" }).toString();
	await assert.rejects(auth.complete(first.attemptId, callback.toString()), /does not match/);
	callback.searchParams.set("state", url.searchParams.get("state")!);
	const idToken = await new SignJWT({ nonce: url.searchParams.get("nonce"), email: "test@example.invalid" })
		.setProtectedHeader({ alg: "RS256" }).setIssuer("https://auth.openai.com").setAudience("oaiapp_remindme")
		.setSubject("account-1").setIssuedAt().setExpirationTime("1h").sign(privateKey);
	globalThis.fetch = (async (target, init) => {
		assert.equal(String(target), "https://auth.openai.com/api/accounts/oauth/token");
		assert.equal(init?.redirect, "error");
		const body = new URLSearchParams(String(init?.body));
		assert.equal(body.get("client_id"), "oaiapp_remindme");
		assert.equal(body.get("code"), "single-use-code");
		assert.ok(body.get("code_verifier"));
		return Response.json({ access_token: "private-access", refresh_token: "private-refresh", id_token: idToken, expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" });
	}) as typeof fetch;
	const status = await auth.complete(first.attemptId, callback.toString());
	assert.equal(status.connected, true);
	assert.equal(status.email, "test@example.invalid");
	assert.equal(JSON.stringify(status).includes("private-"), false);
	assert.equal((await stat(join(directory, "account.json"))).mode & 0o777, 0o600);
	assert.equal(await auth.accessToken(), "private-access");
	await assert.rejects(auth.complete(first.attemptId, callback.toString()), /expired/);
	const again = await auth.start();
	const returning = new URL(again.url);
	assert.equal(returning.searchParams.get("client_id"), "oaiapp_remindme");
	assert.equal(returning.searchParams.get("ext_agent_host_id"), url.searchParams.get("ext_agent_host_id"));
	assert.equal(returning.searchParams.get("id_token_hint"), idToken);
	const badIdentity = await new SignJWT({ nonce: returning.searchParams.get("nonce") })
		.setProtectedHeader({ alg: "RS256" }).setIssuer("https://auth.openai.com").setAudience("oaiapp_remindme")
		.setSubject("account-2").setIssuedAt().setExpirationTime("1h").sign(privateKey);
	globalThis.fetch = (async () => Response.json({ access_token: "wrong-account", refresh_token: "wrong-refresh", id_token: badIdentity, expires_in: 3600, scope: "chatgpt.tokens.use.direct" })) as typeof fetch;
	callback.searchParams.set("state", returning.searchParams.get("state")!);
	await assert.rejects(auth.complete(again.attemptId, callback.toString()), /identity could not be verified/);
	assert.equal(await auth.accessToken(), "private-access");
	await auth.logout();
	assert.equal((await auth.status()).connected, false);
	assert.equal((await readFile(join(directory, "account.json"), "utf8")).includes("private-access"), false);
	await assert.rejects(auth.accessToken(), /Connect your ChatGPT account/);
	// Exercise the real verifier too; an unexpected issuer is never accepted.
	await assert.rejects(jwtVerify(idToken, publicKey, { issuer: "https://other.invalid", audience: "oaiapp_remindme" }));
});

test("two chat processes serialize refresh-token rotation", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-refresh-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "account.json");
	await writeFile(path, JSON.stringify({ hostId: "stable-host", account: {
		clientId: "oaiapp_remindme", subject: "account-1", scopes: ["chatgpt.tokens.use.direct"],
		accessToken: "expired", refreshToken: "rotate-once", expiresAt: 1,
	} }), { mode: 0o600 });
	let requests = 0;
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	globalThis.fetch = (async (_url, init) => {
		requests++;
		assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "rotate-once");
		await new Promise((resolve) => setTimeout(resolve, 30));
		return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 });
	}) as typeof fetch;
	assert.deepEqual(await Promise.all([new ChatGptAuth(path).accessToken(), new ChatGptAuth(path).accessToken()]), ["fresh", "fresh"]);
	assert.equal(requests, 1);
	assert.equal(JSON.parse(await readFile(path, "utf8")).account.refreshToken, "rotated");
});

test("subscription inference forces streaming and no storage, and refuses custom URLs", async (context) => {
	context.mock.method(chatgptAuth, "accessToken", async () => "subscription-secret");
	const endpoint = { url: new URL("https://api.openai.com/v1/responses"), headers: {}, authProvider: "chatgpt" as const, model: "gpt-6-luna", label: "ChatGPT", openaiCompat: true };
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	globalThis.fetch = (async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		assert.equal(body.stream, true);
		assert.equal(body.store, false);
		assert.equal("max_output_tokens" in body, false);
		assert.equal("temperature" in body, false);
		assert.deepEqual(body.input, [{ role: "developer", content: "Keep replies short." }, { role: "user", content: "Hello" }]);
		assert.equal(init?.redirect, "error");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer subscription-secret");
		return new Response('data: {"type":"response.output_text.delta","output_index":0,"delta":"Hel"}\n\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"lo"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"output_tokens":2}}}\n\n');
	}) as typeof fetch;
	const result = await modelFetch(endpoint, { stream: false, store: true, max_output_tokens: 32, temperature: 0, input: [{ role: "system", content: "Keep replies short." }, { role: "user", content: "Hello" }] });
	const completed = await result.json();
	assert.equal(completed.status, "completed");
	assert.equal(responseText(completed), "Hello");
	assert.equal(completed.usage.output_tokens, 2);
	await assert.rejects(modelFetch({ ...endpoint, url: new URL("https://other.invalid/v1/responses") }, {}), /custom URL/);
	globalThis.fetch = (async () => new Response('data: {"type":"response.incomplete","response":{}}\n\n')) as typeof fetch;
	await assert.rejects(streamText(endpoint, [], { maxTokens: 100, thinking: false }, { answer() {}, thinking() {} }), /output limit/);
	globalThis.fetch = (async () => new Response('data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n')) as typeof fetch;
	await assert.rejects(modelFetch(endpoint, {}), /before completing/);
});

test("ChatGPT model discovery preserves provider order and exposes only listed models", async (context) => {
	context.mock.method(chatgptAuth, "accessToken", async () => "subscription-secret");
	const nativeFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = nativeFetch; });
	globalThis.fetch = (async (url) => {
		assert.equal(String(url), "https://api.openai.com/v1/models");
		return Response.json({ models: [
			{ slug: "new-model", display_name: "New model", visibility: "list" },
			{ slug: "internal", display_name: "Internal", visibility: "hide" },
			{ slug: "existing-model", display_name: "Existing model", visibility: "list" },
		] });
	}) as typeof fetch;
	assert.deepEqual(await chatgptAuth.models(), [{ id: "new-model", name: "New model" }, { id: "existing-model", name: "Existing model" }]);
});

test("subscription endpoints cannot redirect credentials to a custom host", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-endpoint-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const store = new EndpointStore(join(directory, "endpoints.json"));
	const endpoint = await store.create({ url: "https://api.openai.com/v1/responses", authProvider: "chatgpt", model: "gpt-6-luna" });
	await assert.rejects(store.update(endpoint.id, { url: "https://other.invalid" }), /Subscription/);
	await assert.rejects(store.update(endpoint.id, { apiKey: "unexpected-key" }), /Subscription/);
	await assert.rejects(store.create({ url: "https://other.invalid", authProvider: "claude" }), /Subscription/);
});

test("official Claude client login, inference isolation and logout", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-claude-"));
	const original = { ...process.env };
	context.after(async () => { process.env = original; await rm(directory, { recursive: true, force: true }); });
	process.env.CLAUDE_CONFIG_DIR = join(directory, "auth");
	process.env.CLAUDE_CLI_PATH = join(directory, "fake-claude");
	process.env.ANTHROPIC_API_KEY = "must-not-reach-client";
	process.env.SUPERVISOR_TOKEN = "must-not-reach-client";
	await writeFile(process.env.CLAUDE_CLI_PATH, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = path.join(process.env.CLAUDE_CONFIG_DIR, 'connected');
if(args[0] === 'auth') {
  if(args[1] === 'status') { console.log(JSON.stringify({loggedIn:fs.existsSync(state),authMethod:'claude.ai',email:'test@example.invalid'})); }
  if(args[1] === 'login') { console.log('https://claude.com/cai/oauth/authorize?state=test');process.stdin.once('data',code=>{if(code.toString().trim()==='approved-code'){fs.writeFileSync(state,'connected');process.exit(0);}process.exit(1);}); }
  if(args[1] === 'logout') { fs.rmSync(state,{force:true}); }
} else {
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'invocation.json'),JSON.stringify({args,hasApiKey:!!process.env.ANTHROPIC_API_KEY,hasSupervisorToken:!!process.env.SUPERVISOR_TOKEN,home:process.env.HOME}));
  process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'Grüße!'}}}));
    if(!args.includes('fail'))console.log(JSON.stringify({type:'result',result:'Grüße!',structured_output:{action:'reply'},usage:{input_tokens:20,output_tokens:5}}));
  });
}
`, { mode: 0o700 });
	const auth = new ClaudeAuth();
	context.after(() => auth.cancel());
	assert.equal((await auth.status()).connected, false);
	const login = await auth.start();
	assert.equal(new URL(login.url).hostname, "claude.com");
	assert.equal((await auth.complete(login.attemptId, "approved-code")).connected, true);
	let answer = "";
	const result = await claudeCompletion("sonnet", [{ role: "user", content: "Hello" }], { schema: { type: "object" } }, { answer: (text) => { answer += text; }, thinking() {} });
	assert.equal(answer, "Grüße!");
	assert.deepEqual(result.structured, { action: "reply" });
	const invocation = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR, "invocation.json"), "utf8"));
	assert.equal(invocation.hasApiKey, false);
	assert.equal(invocation.hasSupervisorToken, false);
	assert.equal(invocation.home, process.env.CLAUDE_CONFIG_DIR);
	assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
	assert.ok(invocation.args.includes("--strict-mcp-config"));
	assert.ok(invocation.args.includes("--no-session-persistence"));
	assert.ok(invocation.args.includes('{"disableAllHooks":true}'));
	await assert.rejects(claudeCompletion("fail", [{ role: "user", content: "Hello" }], {}), /could not complete/);
	await auth.logout();
	assert.equal((await auth.status()).connected, false);
});
