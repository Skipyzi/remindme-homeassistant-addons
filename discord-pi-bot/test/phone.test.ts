import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { PhonePush } from "../src/phone/push.ts";
import { TailscaleNode, tailnetGuard } from "../src/phone/tailscale.ts";

const subscription = (n: number) => ({ endpoint: `https://web.push.apple.com/device-${n}`, keys: { p256dh: `key-${n}`, auth: `auth-${n}` } });

test("push keys are made once, kept privately, and devices come and go", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "push-")), "push.json");
	const sent: Array<{ endpoint: string; payload: Record<string, unknown>; subject: string; ttl?: number }> = [];
	let refuse = "";
	const push = new PhonePush(path, () => "https://remindme.tail1234.ts.net", async (target, payload, options) => {
		if (target.endpoint === refuse) throw Object.assign(new Error("gone"), { statusCode: 410 });
		sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), subject: options.vapidDetails!.subject, ttl: options.TTL });
	});
	await push.load();
	const key = push.publicKey;
	assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const again = new PhonePush(path);
	await again.load();
	assert.equal(again.publicKey, key, "the same keys after a restart, or every phone would need to subscribe again");

	assert.equal(await push.send({ title: "x", body: "y" }), 0, "no devices, nothing sent");
	await assert.rejects(push.subscribe({ endpoint: "http://insecure", keys: {} }), /isn't a push subscription/);
	await push.subscribe(subscription(1), "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)");
	await push.subscribe(subscription(2), "Mozilla/5.0 (Linux; Android 16)");
	await push.subscribe(subscription(1), "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)");
	assert.deepEqual(push.devices().map((device) => device.kind), ["Android", "iPhone"], "subscribing twice keeps one entry");

	const reached = await push.send({ title: "Flights to Budapest", body: "**Thursday** or Friday?\n• Thursday\n• Friday", url: "./#t/abc", tag: "job-abc" });
	assert.equal(reached, 2);
	assert.deepEqual(sent[0].payload, { title: "Flights to Budapest", body: "Thursday or Friday? • Thursday • Friday", url: "./#t/abc", tag: "job-abc" });
	assert.equal(sent[0].subject, "https://remindme.tail1234.ts.net");
	assert.equal(sent[0].ttl, 6 * 3600);

	await push.send({ title: "Dentist", body: "Add it?", badge: 2 });
	assert.equal(sent.at(-1)!.payload.badge, 2, "the app icon's count goes along when given");
	refuse = subscription(2).endpoint;
	assert.equal(await push.send({ title: "Reminder", body: "Call Oma" }), 1);
	assert.deepEqual(push.devices().map((device) => device.kind), ["iPhone"], "a device the push service says is gone is dropped");
	await push.unsubscribe();
	assert.equal(push.devices().length, 0);
});

/* A stand-in `tailscale` command: answers by the first argument. */
function fakeCli(answers: Record<string, () => string>) {
	const calls: string[] = [];
	const run = async (args: string[]) => {
		calls.push(args.join(" "));
		const answer = answers[args[0]];
		if (!answer) throw new Error(`unexpected ${args[0]}`);
		return answer();
	};
	return { run, calls };
}

const running = JSON.stringify({ BackendState: "Running", AuthURL: "", Self: { DNSName: "remindme.tail1234.ts.net.", UserID: 42 }, User: { "42": { LoginName: "gabor@github" } } });

test("Tailscale's state reads as off, signing in, or running with an HTTPS address", async () => {
	assert.equal((await new TailscaleNode("").status()).state, "off", "no daemon socket: the option is off");

	let state = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "" });
	let serve = () => "";
	const cli = fakeCli({ status: () => state, serve: () => serve() });
	const started: string[] = [];
	const node = new TailscaleNode("/run/ts.sock", 8090, cli.run, () => {
		started.push("up");
		state = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123" });
		return new EventEmitter() as unknown as ChildProcess;
	});
	assert.deepEqual(await node.status(), { state: "needs_login" });
	const connecting = await node.connect();
	assert.deepEqual(connecting, { state: "needs_login", authUrl: "https://login.tailscale.com/a/abc123" });
	await node.connect();
	assert.deepEqual(started, ["up"], "one sign-in at a time");

	state = running;
	serve = () => {
		throw new Error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n");
	};
	assert.deepEqual(await node.status(), { state: "running", url: "https://remindme.tail1234.ts.net", owner: "gabor@github", enableHttpsUrl: "https://login.tailscale.com/f/serve?node=n123" });
	serve = () => "";
	assert.deepEqual(await node.status(), { state: "running", url: "https://remindme.tail1234.ts.net", owner: "gabor@github" });
	await node.status();
	assert.equal(cli.calls.filter((call) => call.startsWith("serve")).length, 2, "HTTPS is set up once it works, then left alone");
	assert.ok(cli.calls.includes("serve --bg --yes http://127.0.0.1:8090"));
	assert.equal(node.owner(), "gabor@github");
});

test("over the tailnet only the account that connected RemindMe gets in", async () => {
	const node = new TailscaleNode("/run/ts.sock", 8090, fakeCli({ status: () => running, serve: () => "" }).run);
	const guard = tailnetGuard(node);
	const ask = async (from: string, headers: Record<string, string>) => {
		let outcome = "next";
		const request = { socket: { remoteAddress: from }, get: (name: string) => headers[name.toLowerCase()] } as never;
		const response = { status: (code: number) => ({ type: () => ({ send: () => (outcome = String(code)) }) }) } as never;
		await guard(request, response, () => {});
		return outcome;
	};
	assert.equal(await ask("172.30.32.2", {}), "next", "the Home Assistant panel");
	assert.equal(await ask("127.0.0.1", {}), "next", "the app's own helpers");
	assert.equal(await ask("127.0.0.1", { "tailscale-user-login": "Gabor@GitHub", "x-forwarded-for": "100.64.0.7" }), "next", "the owner's phone");
	assert.equal(await ask("::ffff:127.0.0.1", { "tailscale-user-login": "someone@else", "x-forwarded-for": "100.64.0.8" }), "403", "another account on the tailnet");
	assert.equal(await ask("127.0.0.1", { "x-forwarded-for": "100.64.0.9" }), "403", "a tagged device, which comes without an account");
});
