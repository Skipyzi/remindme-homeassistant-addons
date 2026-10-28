import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { chatgptFetch } from "../src/agents/bridge.ts";
import { OpenAiProvider } from "../src/ai/openai.ts";
import { ChatGptAuth, chatgptAuth } from "../src/subscriptions/chatgptAuth.ts";

test("ChatGPT sign-in checks state, nonce and identity, and keeps the tokens private", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-oauth-"));
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const auth = new ChatGptAuth(join(directory, "account.json"), async () => publicKey, 0);
	context.after(async () => {
		auth.cancel();
		await rm(directory, { recursive: true, force: true });
	});
	const nativeFetch = globalThis.fetch;
	context.after(() => {
		globalThis.fetch = nativeFetch;
	});
	const first = await auth.start();
	const url = new URL(first.url);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
	const callback = new URL("http://127.0.0.1:1455/auth/callback");
	callback.search = new URLSearchParams({ state: "wrong", code: "single-use-code", client_id: "oaiapp_remindme" }).toString();
	await assert.rejects(auth.complete(first.attemptId, callback.toString()), /does not match/);
	callback.searchParams.set("state", url.searchParams.get("state")!);
	const idToken = await new SignJWT({ nonce: url.searchParams.get("nonce"), email: "test@example.invalid" })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer("https://auth.openai.com")
		.setAudience("oaiapp_remindme")
		.setSubject("account-1")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
	globalThis.fetch = (async (target, init) => {
		assert.equal(String(target), "https://auth.openai.com/api/accounts/oauth/token");
		assert.equal(new URLSearchParams(String(init?.body)).get("code"), "single-use-code");
		return Response.json({ access_token: "private-access", refresh_token: "private-refresh", id_token: idToken, expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" });
	}) as typeof fetch;
	const status = await auth.complete(first.attemptId, callback.toString());
	assert.equal(status.connected, true);
	assert.equal(status.email, "test@example.invalid");
	assert.equal(JSON.stringify(status).includes("private-"), false);
	assert.equal((await stat(join(directory, "account.json"))).mode & 0o777, 0o600);
	assert.equal(await auth.accessToken(), "private-access");
	await assert.rejects(auth.complete(first.attemptId, callback.toString()), /expired/);
	await auth.logout();
	assert.equal((await auth.status()).connected, false);
	assert.equal((await readFile(join(directory, "account.json"), "utf8")).includes("private-access"), false);
});

test("two requests refresh an expired ChatGPT token once", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-refresh-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "account.json");
	await writeFile(path, JSON.stringify({ hostId: "host", account: { clientId: "oaiapp_remindme", subject: "account-1", scopes: ["chatgpt.tokens.use.direct"], accessToken: "expired", refreshToken: "rotate-once", expiresAt: 1 } }), { mode: 0o600 });
	let requests = 0;
	const nativeFetch = globalThis.fetch;
	context.after(() => {
		globalThis.fetch = nativeFetch;
	});
	globalThis.fetch = (async (_url, init) => {
		requests++;
		assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "rotate-once");
		await new Promise((resolve) => setTimeout(resolve, 30));
		return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 });
	}) as typeof fetch;
	assert.deepEqual(await Promise.all([new ChatGptAuth(path).accessToken(), new ChatGptAuth(path).accessToken()]), ["fresh", "fresh"]);
	assert.equal(requests, 1);
});

test("ChatGPT requests always stream, store nothing, and go only to OpenAI", async (context) => {
	context.mock.method(chatgptAuth, "accessToken", async () => "subscription-secret");
	const nativeFetch = globalThis.fetch;
	context.after(() => {
		globalThis.fetch = nativeFetch;
	});
	let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
	globalThis.fetch = (async (url, init) => {
		seen = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> };
		return new Response("");
	}) as typeof fetch;
	await chatgptFetch({ store: true, max_output_tokens: 32, previous_response_id: "x", input: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
	assert.equal(seen?.url, "https://api.openai.com/v1/responses");
	assert.equal(seen?.body.stream, true);
	assert.equal(seen?.body.store, false);
	assert.equal("max_output_tokens" in seen!.body, false);
	assert.equal("previous_response_id" in seen!.body, false);
	assert.deepEqual(seen?.body.input, [{ role: "developer", content: "Be brief." }, { role: "user", content: "Hi" }]);
	assert.equal(seen?.headers.Authorization, "Bearer subscription-secret");
});

test("on the ChatGPT subscription the assistant resends the turn so far, without ids", async () => {
	const bodies: Array<Record<string, unknown>> = [];
	const sse = (response: unknown) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response })}\n\n`;
	const replies = [
		sse({ id: "resp_1", object: "response", created_at: 0, status: "completed", model: "gpt-fixture", output: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "secret-thoughts" }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "find_devices", arguments: '{"query":"lamp"}', status: "completed" }], usage: { input_tokens: 5, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } }),
		// The final event can arrive without its output; the finished items still count.
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, sequence_number: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Lamp is on.", annotations: [] }] } })}\n\n` +
			sse({ id: "resp_2", object: "response", created_at: 0, status: "completed", model: "gpt-fixture", output: [], usage: { input_tokens: 5, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } }),
	];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			bodies.push(JSON.parse(raw));
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(replies.shift());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const provider = new OpenAiProvider("", "gpt-fixture", {
			subscription: {
				token: async () => "tok",
				fetch: (body, signal) => fetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ ...body, store: false }), signal }),
			},
		});
		assert.equal(provider.id, "chatgpt");
		const session = provider.start({ system: "S", context: "C", history: [], prompt: "lamp?", tools: [{ name: "find_devices", description: "d", parameters: { type: "object", properties: {} } }], webSearch: false, effort: "low", maxTokens: 1000 });
		const first = await session.next({});
		assert.equal(first.stop, "tools");
		session.answer([{ call: first.calls[0], outcome: { content: "on" } }]);
		const second = await session.next({});
		assert.equal(second.text, "Lamp is on.");
		assert.equal(bodies[0].store, false);
		assert.deepEqual(bodies[0].include, ["reasoning.encrypted_content"]);
		assert.equal("previous_response_id" in bodies[1], false);
		const input = bodies[1].input as Array<Record<string, unknown>>;
		assert.equal(input[0].role, "user");
		assert.deepEqual(input.slice(1).map((item) => item.type), ["reasoning", "function_call", "function_call_output"]);
		assert.equal(input[1].encrypted_content, "secret-thoughts");
		assert.ok(input.slice(1).every((item) => !("id" in item)), "nothing is stored, so no ids");
	} finally {
		server.close();
	}
});
