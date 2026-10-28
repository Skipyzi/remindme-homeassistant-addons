import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HaApp, appLink, plainText, safeTag } from "../src/phone/ha-app.ts";
import { HaEvents, websocketUrl } from "../src/phone/ha-events.ts";
import { LiveJobs } from "../src/phone/live-jobs.ts";
import type { Thread } from "../src/assistant/threads.ts";

type Call = { domain: string; service: string; data: Record<string, any> };

function app(fallbackTarget?: string) {
	const calls: Call[] = [];
	const home = { callService: async (domain: string, service: string, data: Record<string, unknown>) => void calls.push({ domain, service, data: data as Record<string, any> }) };
	const phone = new HaApp(home, { path: join(mkdtempSync(join(tmpdir(), "ha-app-")), "ha-app.json"), fallbackTarget, link: (url) => (url ? new URL(url, "https://remindme.tail.ts.net/").toString() : undefined) });
	return { phone, calls };
}

test("a notification goes to the picked phone with one-time buttons, a reply field, a picture and a link", async () => {
	const { phone, calls } = app("notify.mobile_app_old_phone");
	await phone.load();
	assert.equal(phone.target, "mobile_app_old_phone", "the ha_notify_target option until a phone is picked");
	await phone.choose({ target: "mobile_app_iphone_von_gabor" });
	assert.equal(await phone.send({ title: "Flights", body: "Thursday or Friday?", url: "./#t/abc", tag: "job abc!", badge: 2, image: "https://remindme.tail.ts.net/api/cats/abc/asking.png", buttons: [
		{ title: "Thursday", run: async () => "Thursday it is." },
		{ title: "Reply", reply: { button: "Send", placeholder: "Your answer" }, run: async (reply) => `You said ${reply}` },
		{ title: "Unlock", unlocked: true, destructive: true, run: async () => "Unlocked." },
	] }), true);
	const [call] = calls;
	assert.equal(call.domain, "notify");
	assert.equal(call.service, "mobile_app_iphone_von_gabor");
	assert.equal(call.data.title, "Flights");
	assert.equal(call.data.message, "Thursday or Friday?");
	assert.equal(call.data.data.tag, "job-abc-");
	assert.equal(call.data.data.url, "https://remindme.tail.ts.net/#t/abc");
	assert.equal(call.data.data.image, "https://remindme.tail.ts.net/api/cats/abc/asking.png");
	assert.deepEqual(call.data.data.push, { badge: 2 });
	const [thursday, reply, unlock] = call.data.data.actions;
	assert.match(thursday.action, /^REMINDME_[0-9a-f]{24}$/);
	assert.equal(thursday.title, "Thursday");
	assert.deepEqual({ ...reply, action: "" }, { action: "", title: "Reply", behavior: "textInput", textInputButtonTitle: "Send", textInputPlaceholder: "Your answer" });
	assert.equal(unlock.authenticationRequired, true);
	assert.equal(unlock.destructive, true);

	// A tap: the answer replaces the notification, quietly; the other buttons are gone with it.
	await phone.tapped({ action: reply.action, reply_text: "  Friday please " });
	assert.equal(calls[1].data.message, "You said Friday please");
	assert.equal(calls[1].data.data.tag, "job-abc-");
	assert.deepEqual(calls[1].data.data.push, { "interruption-level": "passive" });
	assert.equal(calls[1].data.data.actions, undefined);
	await phone.tapped({ action: thursday.action });
	assert.match(calls[2].data.message, /expired/);
	await phone.tapped({ action: "SOMETHING_ELSE" });
	assert.equal(calls.length, 3, "other apps' buttons are left alone");

	// A button that fails says so in place.
	await phone.send({ title: "Door", body: "Unlock?", tag: "held", buttons: [{ title: "Unlock", run: async () => Promise.reject(new Error("The lock didn't answer")) }] });
	await phone.tapped({ action: calls[3].data.data.actions[0].action });
	assert.equal(calls[4].data.message, "That didn't work: The lock didn't answer");

	await phone.choose({ target: "" });
	assert.equal(phone.on, false, "switched off in Settings, even with the option set");
	assert.equal(await phone.send({ title: "x", body: "y" }), false);
	assert.equal(safeTag("rm-live-ä/1"), "rm-live---1");
});

test("a Live Activity starts, updates quietly with progress, and ends", async () => {
	const { phone, calls } = app("mobile_app_iphone");
	await phone.load();
	await phone.live("rm-live-abc", { title: "Flights", message: "Eurowings: 84 €", progress: { done: 2, total: 6 }, url: "./#t/abc", first: true });
	await phone.live("rm-live-abc", { title: "Flights", message: "Wizz: 61 €", progress: { done: 4, total: 6 }, first: false });
	await phone.clear("rm-live-abc");
	assert.equal(calls[0].data.data.live_update, true);
	assert.equal(calls[0].data.data.progress, 2);
	assert.equal(calls[0].data.data.progress_max, 6);
	assert.equal(calls[0].data.data.notification_icon, "mdi:cat");
	assert.equal(calls[0].data.data.silent, undefined, "the start may make a sound");
	assert.equal(calls[1].data.data.silent, true);
	assert.deepEqual(calls[2].data, { message: "clear_notification", data: { tag: "rm-live-abc" } });
});

test("a quick job gets no Live Activity; a long one starts after a while, updates sparingly, and ends", async () => {
	const pushed: Array<{ tag: string; message?: string; first?: boolean; cleared?: boolean }> = [];
	const fake = { liveActivities: true, live: async (tag: string, update: { message: string; first: boolean }) => (pushed.push({ tag, message: update.message, first: update.first }), true), clear: async (tag: string) => (pushed.push({ tag, cleared: true }), true) };
	const live = new LiveJobs(fake, { after: 40, every: 60 });
	const thread = (status: string, step?: string) => ({ id: "abc", title: "Flights", messages: step ? [{ id: "1", at: "", role: "step", text: step }] : [], job: { status, instructions: "", runs: 0 } }) as unknown as Thread;
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	live.update(thread("working"));
	live.update(thread("done"));
	await wait(60);
	assert.deepEqual(pushed, [], "done before it would have started");

	live.update(thread("working", "Looking at Eurowings"));
	await wait(60);
	assert.deepEqual(pushed, [{ tag: "rm-live-abc", message: "Looking at Eurowings", first: true }]);
	live.update(thread("working", "Eurowings: 84 €"));
	live.update(thread("working", "Wizz: 61 €"));
	await wait(20);
	assert.equal(pushed.length, 1, "not more often than every 60 ms here (20 s live)");
	await wait(70);
	assert.deepEqual(pushed[1], { tag: "rm-live-abc", message: "Wizz: 61 €", first: false }, "the latest step wins");
	live.update(thread("needs_you"));
	assert.deepEqual(pushed[2], { tag: "rm-live-abc", cleared: true });
});

test("the WebSocket address sits next to the REST one", () => {
	assert.equal(websocketUrl("http://supervisor/core/api"), "ws://supervisor/core/websocket");
	assert.equal(websocketUrl("http://127.0.0.1:8798/api"), "ws://127.0.0.1:8798/api/websocket");
	assert.equal(websocketUrl("https://ha.example.com/api/"), "wss://ha.example.com/api/websocket");
});

/* Just enough of a WebSocket server: the handshake, unmasked frames out, masked frames in. */
function frame(text: string): Buffer {
	const body = Buffer.from(text);
	return Buffer.concat([Buffer.from(body.length < 126 ? [0x81, body.length] : [0x81, 126, body.length >> 8, body.length & 255]), body]);
}
function readFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
	const texts: string[] = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		let length = buffer[offset + 1] & 127;
		let head = 2;
		if (length === 126) {
			length = buffer.readUInt16BE(offset + 2);
			head = 4;
		}
		if (buffer.length - offset < head + 4 + length) break;
		const mask = buffer.subarray(offset + head, offset + head + 4);
		const payload = Buffer.from(buffer.subarray(offset + head + 4, offset + head + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
		if ((buffer[offset] & 15) === 1) texts.push(payload.toString());
		offset += head + 4 + length;
	}
	return { texts, rest: buffer.subarray(offset) };
}

test("button taps arrive over Home Assistant's WebSocket API, and the connection comes back when dropped", async (context) => {
	const received: string[] = [];
	const sockets: Socket[] = [];
	let connections = 0;
	const server = createServer();
	server.on("upgrade", (request, socket: Socket) => {
		connections++;
		sockets.push(socket);
		const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		socket.write(frame(JSON.stringify({ type: "auth_required" })));
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			const read = readFrames(Buffer.concat([buffer, chunk]));
			buffer = read.rest;
			for (const text of read.texts) {
				received.push(text);
				const message = JSON.parse(text);
				if (message.type === "auth") socket.write(frame(JSON.stringify({ type: message.access_token === "supervisor-token" ? "auth_ok" : "auth_invalid" })));
				if (message.type === "subscribe_events") {
					socket.write(frame(JSON.stringify({ id: message.id, type: "result", success: true })));
					socket.write(frame(JSON.stringify({ id: message.id, type: "event", event: { event_type: "mobile_app_notification_action", data: { action: "REMINDME_abc", reply_text: "Friday" } } })));
				}
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const events: Array<Record<string, unknown>> = [];
	const stream = new HaEvents(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/websocket`, "supervisor-token", ["mobile_app_notification_action"], (_type, data) => events.push(data));
	context.after(() => {
		stream.stop();
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	stream.start();
	const until = async (check: () => boolean) => {
		for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(check());
	};
	await until(() => events.length === 1);
	assert.deepEqual(events[0], { action: "REMINDME_abc", reply_text: "Friday" });
	assert.deepEqual(JSON.parse(received[0]), { type: "auth", access_token: "supervisor-token" });
	assert.deepEqual(JSON.parse(received[1]), { id: 1, type: "subscribe_events", event_type: "mobile_app_notification_action" });

	sockets[0].destroy();
	await until(() => events.length === 2);
	assert.equal(connections, 2, "it reconnected on its own");
});

test("notifications show plain text: Markdown's marks come off", () => {
	assert.equal(plainText("**Wizz Air, Friday 06:10: 61 €.** Back _Sunday_. [Booking](https://wizzair.com/x) and `BER`.\n## Next"), "Wizz Air, Friday 06:10: 61 €. Back Sunday. Booking and BER.\nNext");
	assert.equal(plainText("sensor_battery_level stays"), "sensor_battery_level stays");
});

test("a tap opens RemindMe's panel in the Home Assistant app, on the thread", () => {
	assert.equal(appLink("./#t/abc-123", "835ec51f_remindme_discord_bot"), "/app/835ec51f_remindme_discord_bot/t/abc-123");
	assert.equal(appLink("./", "835ec51f_remindme_discord_bot"), "/app/835ec51f_remindme_discord_bot");
	assert.equal(appLink("./#t/abc", "", "https://remindme.tail.ts.net"), "https://remindme.tail.ts.net/#t/abc", "without the slug, the phone app's address");
	assert.equal(appLink("./", ""), undefined);
});
