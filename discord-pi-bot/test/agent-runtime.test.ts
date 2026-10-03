import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, DurablePending } from "../src/agent/runtime-store.ts";
import { createToolGateway, verifyAction } from "../src/agent/tool-gateway.ts";
import { normalizeEntity } from "../src/harness/entities.ts";
import { planLightSettings } from "../src/agent/home.ts";
import { nativeEnvironment } from "../src/agent/native-process.ts";

const lamp = (state = "off", brightness = 0) => normalizeEntity({ entity_id: "light.paper", state, attributes: { friendly_name: "Paper Lamp", supported_color_modes: ["rgb"], brightness } });
const lock = normalizeEntity({ entity_id: "lock.door", state: "locked", attributes: { friendly_name: "Front Door" } });
function gateway(options: { fail?: boolean; signal?: AbortSignal } = {}) {
	const services: any[] = [], events: any[] = [], receipts: any[] = [], pending: any[] = [];
	let card = lamp();
	const home = { cards: async () => [card, lock], card: async (id: string) => id === lock.entityId ? lock : card, service: async (plan: any) => { services.push(plan); if (options.fail) throw new Error("Device unreachable"); card = lamp("on", plan.serviceData.brightness); card.rgbColor = plan.serviceData.rgb_color; } };
	const call = createToolGateway({ home: home as any, holdAction: action => { pending.push(action); return "confirmation-token"; }, holdReminder: () => "reminder-token", listReminders: async () => [] }, (event, data) => events.push({ event, data }), options.signal || new AbortController().signal, (name, result) => receipts.push({ name, result }));
	return { call, services, events, receipts, pending };
}

test("agent conversations and selected backends survive restart and stay isolated", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-agent-"));
	try {
		const store = new AgentStore(directory);
		store.configure({ backend: "codex", model: "account-listed-model" });
		const first = store.load("../conversation-one");
		first.threads.codex = "native-thread-one";
		first.history.push({ role: "user", content: "use the paper lamp" });
		store.save(first);
		const restored = new AgentStore(directory);
		assert.equal(restored.getSettings().backend, "codex");
		assert.equal(restored.load("../conversation-one").threads.codex, "native-thread-one");
		assert.equal(restored.load("conversation-two").history.length, 0);
		assert.equal((await stat(join(directory, "settings.json"))).mode & 0o777, 0o600);
		assert.throws(() => restored.configure({ backend: "made-up" }));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("confirmations survive restart, expire and are consumed exactly once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-pending-"));
	try {
		const path = join(directory, "pending.json");
		new DurablePending(path).set("token", { entity: "lock.door" });
		const restarted = new DurablePending<{ entity: string }>(path);
		assert.equal(restarted.take("token")?.entity, "lock.door");
		assert.equal(new DurablePending(path).take("token"), undefined);
		new DurablePending(path, -1).set("expired", { entity: "lock.door" });
		assert.equal(new DurablePending(path).get("expired"), undefined);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("only one agent turn can own the Pi at a time", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-lock-"));
	try {
		const store = new AgentStore(directory);
		let finish!: () => void;
		const running = store.exclusive(() => new Promise<void>(resolve => { finish = resolve; }));
		await assert.rejects(store.exclusive(async () => {}), /Another assistant turn/);
		finish(); await running;
		await store.exclusive(async () => {});
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("native tool scene execution validates real IDs and verifies returned settings", async () => {
	const g = gateway();
	const result: any = await g.call("home_lighting", { lights: [{ target: "light.paper", brightness: 30, color: "#FF6A3D" }] });
	assert.equal(g.services.length, 1);
	assert.equal(g.services[0].serviceData.brightness, 77);
	assert.equal(result.verification[0].status, "verified");
	assert.equal(result.verification[0].serviceAccepted, true);
	assert.ok(g.events.some(({ event }) => event === "tool_complete"));
});

test("a bad second target prevents every service in a scene", async () => {
	const g = gateway();
	const result: any = await g.call("home_lighting", { lights: [{ target: "light.paper", brightness: 30 }, { target: "light.invented", brightness: 30 }] });
	assert.match(result.error, /Unknown entity/);
	assert.equal(g.services.length, 0);
	const invalid: any = await g.call("home_lighting", { lights: [{ target: "light.paper", brightness: 1000 }] });
	assert.match(invalid.error, /between 0 and 100/);
	assert.equal(g.services.length, 0);
});

test("sensitive tools return confirmation cards without calling services or exposing tokens to the agent", async () => {
	const g = gateway();
	const result: any = await g.call("home_control", { targets: ["lock.door"], command: "unlock" });
	assert.equal(g.services.length, 0);
	assert.equal(g.pending.length, 1);
	assert.equal(result.confirmations[0].pending, true);
	assert.ok(!JSON.stringify(result).includes("confirmation-token"));
	assert.ok(g.events.some(({ data }) => data.result?.token === "confirmation-token"));
});

test("failed services are not marked verified, and cancelled tools execute nothing", async () => {
	const failed = gateway({ fail: true });
	const result: any = await failed.call("home_control", { targets: ["light.paper"], command: "turn_on" });
	assert.deepEqual(result.verification, []);
	assert.deepEqual(result.receipt.done, []);
	assert.match(result.receipt.problems[0], /unreachable/);
	const abort = new AbortController(); abort.abort();
	const cancelled = gateway({ signal: abort.signal });
	await assert.rejects(cancelled.call("home_control", { targets: ["light.paper"], command: "turn_on" }));
	assert.equal(cancelled.services.length, 0);
});

test("native reminder requests produce UI confirmations and keep approval tokens out of model results", async () => {
	const g = gateway();
	const result: any = await g.call("reminder_add", { request: "buy milk in 15 minutes" });
	assert.equal(result.confirmations[0].pending, true);
	assert.ok(!JSON.stringify(result).includes("reminder-token"));
	assert.ok(g.events.some(({ data }) => data.result?.kind === "reminder" && data.result.token === "reminder-token"));
});

test("service acceptance does not imply that requested physical state was observed", () => {
	const plan = planLightSettings(lamp(), { target: "light.paper", brightness: 30 });
	assert.equal(verifyAction(plan, lamp()).status, "mismatch");
	assert.equal(verifyAction(plan).status, "unavailable");
	const speaker = normalizeEntity({ entity_id: "media_player.speaker", state: "playing", attributes: { volume_level: 0.2 } });
	assert.equal(verifyAction({ ...plan, entityId: speaker.entityId, service: "volume_set", serviceData: { volume_level: 0.8 } }, speaker).status, "mismatch");
	const climate = normalizeEntity({ entity_id: "climate.room", state: "heat", attributes: { temperature: 20, target_temp_step: 0.5 } });
	assert.equal(verifyAction({ ...plan, entityId: climate.entityId, service: "set_temperature", serviceData: { temperature: 21 } }, climate).status, "mismatch");
});

test("native clients do not inherit Supervisor, Discord or unrelated API secrets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "remindme-env-"));
	const original = process.env.AGENT_DATA_DIR;
	process.env.AGENT_DATA_DIR = directory;
	try {
		const { env } = await nativeEnvironment("codex");
		assert.equal(env.SUPERVISOR_TOKEN, undefined);
		assert.equal(env.DISCORD_BOT_TOKEN, undefined);
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.HOME, join(directory, "codex"));
	} finally { if (original === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = original; await rm(directory, { recursive: true, force: true }); }
});
