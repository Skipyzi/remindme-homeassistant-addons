import assert from "node:assert/strict";
import test from "node:test";
import {
	SupervisorSettingsClient,
	SupervisorSettingsError,
} from "../src/harness/supervisorSettings.ts";

const baseOptions = {
	discord_token: "discord-secret",
	owner_id: "235480697899450368",
	pi_agent_webhook_url: "",
	local_llm_enabled: true,
	local_llm_url: "http://homeassistant:8080/v1/chat/completions",
	local_llm_model: "qwen3-1.7b",
	local_llm_context_size: 8192,
	local_llm_vision: false,
	model_manager_enabled: true,
	model_manager_url: "http://homeassistant:8080/manager/v1",
	exa_api_key: "exa-secret",
	ha_notify_target: "",
	future_option: "preserved",
};

function envelope(data: unknown, status = 200) {
	return Response.json({ result: status < 400 ? "ok" : "error", data }, { status });
}

test("loads rendered live options and redacts secrets", async () => {
	const calls: string[] = [];
	const client = new SupervisorSettingsClient(
		"http://supervisor",
		"supervisor-token",
		async (input) => {
			calls.push(String(input));
			return envelope(baseOptions);
		},
	);
	const loaded = await client.load();
	assert.deepEqual(calls, ["http://supervisor/addons/self/options/config"]);
	assert.equal(loaded.settings.ownerId, baseOptions.owner_id);
	assert.equal(loaded.settings.discordTokenConfigured, true);
	assert.equal(JSON.stringify(loaded).includes("discord-secret"), false);
});

test("save persists complete options without privileged preflight, then reloads", async () => {
	const calls: Array<{ url: string; method: string; body?: unknown }> = [];
	let stored = { ...baseOptions };
	const client = new SupervisorSettingsClient(
		"http://supervisor",
		"supervisor-token",
		async (input, init = {}) => {
			const url = String(input);
			const method = init.method || "GET";
			const body = init.body
				? await new Response(init.body).json()
				: undefined;
			calls.push({ url, method, body });
			if (url.endsWith("/options/config")) return envelope(stored);
			if (url.endsWith("/options/validate"))
				throw new Error("self token must not call privileged validation");
			if (url.endsWith("/options")) {
				stored = body.options;
				return envelope({});
			}
			return envelope({}, 404);
		},
	);
	const before = await client.load();
	calls.length = 0;
	const saved = await client.save(before.revision, {
		localLlmContextSize: 4096,
		notifyTarget: "notify.mobile_phone",
	});
	assert.deepEqual(
		calls.map((call) => `${call.method} ${call.url.split("/addons/self")[1]}`),
		["GET /options/config", "POST /options", "GET /options/config"],
	);
	const posted = calls[1].body as { options: Record<string, unknown> };
	assert.equal(posted.options.future_option, "preserved");
	assert.equal(posted.options.discord_token, "discord-secret");
	assert.equal(posted.options.local_llm_context_size, 4096);
	assert.equal(saved.settings.notifyTarget, "mobile_phone");
	assert.equal(saved.restartRequired, true);
});

test("stale revision returns conflict before validation or persistence", async () => {
	const calls: string[] = [];
	const client = new SupervisorSettingsClient(
		"http://supervisor",
		"supervisor-token",
		async (input) => {
			calls.push(String(input));
			return envelope({ ...baseOptions, owner_id: "changed-elsewhere" });
		},
	);
	await assert.rejects(
		client.save("stale", { ownerId: "mine" }),
		(error: unknown) =>
			error instanceof SupervisorSettingsError && error.status === 409,
	);
	assert.equal(calls.length, 1);
});

test("Supervisor write-time validation failures remain 422 with safe detail", async () => {
	const seedClient = new SupervisorSettingsClient(
		"http://supervisor",
		"token",
		async () => envelope(baseOptions),
	);
	const current = await seedClient.load();
	const calls: string[] = [];
	const client = new SupervisorSettingsClient(
		"http://supervisor",
		"token",
		async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/options/config")) return envelope(baseOptions);
			if (url.endsWith("/options/validate"))
				throw new Error("self token must not call privileged validation");
			return Response.json(
				{
					result: "error",
					message: "Invalid list for option 'local_llm_context_size'",
				},
				{ status: 400 },
			);
		},
	);
	await assert.rejects(
		client.save(current.revision, { ownerId: "new" }),
		(error: unknown) =>
			error instanceof SupervisorSettingsError &&
			error.code === "configuration_invalid" &&
			error.status === 422 &&
			/local_llm_context_size/.test(error.message),
	);
	assert.deepEqual(
		calls.map((url) => url.split("/addons/self")[1]),
		["/options/config", "/options"],
	);
});
