import assert from "node:assert/strict";
import test from "node:test";
import { mergeAddonOptions } from "../src/harness/settings.ts";

test("settings updates preserve required and secret add-on options", () => {
	const current = {
		result: "ok",
		data: {
			options: {
				discord_token: "protected-discord-token",
				owner_id: "1234",
				local_llm_enabled: true,
				local_llm_url: "http://homeassistant:8080/v1/chat/completions",
				local_llm_model: "qwen3-1.7b",
				model_manager_enabled: true,
				model_manager_url: "http://homeassistant:8080/manager/v1",
			},
		},
	};

	const merged = mergeAddonOptions(current, {
		local_llm_model: "qwen3-4b",
		ha_notify_target: "mobile_app_phone",
	});

	assert.equal(merged.discord_token, "protected-discord-token");
	assert.equal(merged.owner_id, "1234");
	assert.equal(merged.model_manager_enabled, true);
	assert.equal(merged.local_llm_model, "qwen3-4b");
	assert.equal(merged.ha_notify_target, "mobile_app_phone");
});

test("settings merge rejects a malformed Supervisor response", () => {
	assert.throws(
		() => mergeAddonOptions({ result: "ok", data: {} }, { local_llm_model: "qwen3-4b" }),
		/ current add-on options/i,
	);
});
