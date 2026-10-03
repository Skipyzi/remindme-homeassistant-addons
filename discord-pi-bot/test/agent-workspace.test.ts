import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../src/agent/runtime-store.ts";
import { nativePrompt } from "../src/agent/native-backends.ts";
import { NativeAccounts, nativeCodexFetch, quoteCommand } from "../src/agent/native-accounts.ts";
import { EndpointStore } from "../src/harness/endpoints.ts";

test("a chat retains its origin and chosen assistant independently of defaults and other chats", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-workspace-"));
	try {
		const store = new AgentStore(directory);
		store.select("one", { backend: "codex", model: "first-model", source: "endpoint" });
		const first = store.load("one");
		store.identify(first, { ...first.selection!, provider: "ChatGPT", label: "Codex / ChatGPT / first-model" });
		first.threads.codex = "thread-one";
		first.history.push({ role: "user", content: "Use Paper Lamp" }); store.save(first);
		store.configure({ backend: "pi", model: "unrelated-default" });
		assert.equal(store.selection("one").backend, "codex");
		assert.equal(store.selection("two").backend, "pi");
		store.select("one", { backend: "claude", model: "sonnet", source: "endpoint" });
		const second = store.load("one");
		store.identify(second, { ...second.selection!, provider: "Claude", label: "Claude Code / Claude / sonnet" });
		second.history.push({ role: "assistant", content: "Cyberpunk scene uses Paper Lamp and PC Lamp" }); store.save(second);
		store.select("one", { backend: "codex", model: "second-model", source: "endpoint" });
		const resumed = new AgentStore(directory).load("one");
		assert.equal(resumed.threads.codex, undefined, "Switching back must import intervening turns");
		assert.match(nativePrompt({ backend: "codex", session: resumed, prompt: "make it warmer" } as any), /Cyberpunk scene/);
		assert.equal(resumed.origin?.model, "first-model");
		assert.equal(resumed.current?.backend, "claude");
		assert.equal(resumed.switches?.length, 1);
		assert.equal(resumed.selection?.model, "second-model");
		await store.exclusive(async () => assert.throws(() => store.select("one", { backend: "pi", source: "native", model: "provider/model" }), /finish/));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy chats do not acquire an invented original provider", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-legacy-"));
	try {
		const store = new AgentStore(directory); const session = store.load("legacy"); session.originUnknown = true;
		store.identify(session, { backend: "pi", source: "native", model: "provider/model", provider: "provider", label: "Pi" });
		assert.equal(new AgentStore(directory).load("legacy").origin, undefined);
		assert.equal(session.current?.backend, "pi");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolving a conversation endpoint never changes another chat's default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-endpoint-chat-"));
	try {
		const endpoints = new EndpointStore(join(directory, "endpoints.json"));
		const first = await endpoints.create({ name: "LAN", url: "http://192.168.1.3:8080/v1/chat/completions", model: "lan-model", apiKey: "private-lan-key" });
		const second = await endpoints.create({ name: "Cloud", url: "https://example.com/v1/chat/completions", model: "cloud-model" });
		await endpoints.setActive(second.id);
		const fallback = { url: "http://localhost:8080/v1/chat/completions", model: "local-model" };
		assert.equal(endpoints.resolve(fallback, first.id).model, "lan-model");
		assert.equal(endpoints.resolve(fallback).model, "cloud-model");
		assert.equal(endpoints.resolve(fallback, "").model, "local-model");
		assert.throws(() => endpoints.resolve(fallback, "deleted"), /removed/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("the native sign-in PTY only runs its fixed command, isolates credentials and rejects stale input", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-auth-console-"));
	const original = { dir: process.env.AGENT_DATA_DIR, cli: process.env.CODEX_CLI_PATH, secret: process.env.SUPERVISOR_TOKEN };
	const accounts = new NativeAccounts();
	try {
		process.env.AGENT_DATA_DIR = directory; process.env.SUPERVISOR_TOKEN = "must-not-inherit";
		const fixture = join(directory, "login fixture'cli.cjs");
		await writeFile(fixture, '#!/usr/bin/env node\nconst fs=require("node:fs"); if(process.env.SUPERVISOR_TOKEN)process.exit(9);console.log("Ready "+process.argv.slice(2).join(" "));require("node:readline").createInterface({input:process.stdin}).on("line",line=>{fs.writeFileSync(process.env.CODEX_HOME+"/input.txt",line);console.log("Accepted input");process.exit(0)});\n', { mode: 0o700 });
		process.env.CODEX_CLI_PATH = fixture;
		const login = await accounts.start("codex");
		await assert.rejects(accounts.start("opencode"), /Cancel/);
		await assert.rejects(accounts.input("expired", "secret", false), /expired/);
		await accounts.input(login.id, 'literal $(touch /tmp/never-evaluate-login-input)', false);
		const deadline = Date.now() + 5000;
		while (accounts.view().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(accounts.view().running, false);
		assert.match(accounts.view().output, /Ready login --device-auth/);
		assert.match(accounts.view().output, /Accepted input/);
		assert.equal(await readFile(join(directory, "codex/input.txt"), "utf8"), 'literal $(touch /tmp/never-evaluate-login-input)');
		await assert.rejects(accounts.input(login.id, "after completion", false), /expired/);
		assert.equal(quoteCommand("it's literal"), "'it'\\''s literal'");
	} finally {
		accounts.cancel();
		for (const [key, value] of [["AGENT_DATA_DIR", original.dir], ["CODEX_CLI_PATH", original.cli], ["SUPERVISOR_TOKEN", original.secret]]) value === undefined ? delete process.env[key!] : process.env[key!] = value;
		await rm(directory, { recursive: true, force: true });
	}
});

test("native Codex inference reads only its own auth and sends credentials to its fixed upstream", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-native-codex-"));
	const prior = process.env.AGENT_DATA_DIR; const realFetch = global.fetch;
	try {
		process.env.AGENT_DATA_DIR = directory;
		const { mkdir } = await import("node:fs/promises"); await mkdir(join(directory, "codex"));
		await writeFile(join(directory, "codex/auth.json"), JSON.stringify({ tokens: { access_token: "native-fixture-token", account_id: "native-account" } }), { mode: 0o600 });
		global.fetch = async (url, options) => {
			assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
			assert.equal(options?.redirect, "error");
			assert.equal((options?.headers as any).Authorization, "Bearer native-fixture-token");
			assert.equal((options?.headers as any)["ChatGPT-Account-Id"], "native-account");
			const body = JSON.parse(String(options?.body)); assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.max_output_tokens, undefined);
			return new Response("fixture");
		};
		assert.equal(await (await nativeCodexFetch({ model: "fixture", input: [], max_output_tokens: 100 })).text(), "fixture");
	} finally { global.fetch = realFetch; prior === undefined ? delete process.env.AGENT_DATA_DIR : process.env.AGENT_DATA_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});
