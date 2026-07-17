import assert from "node:assert/strict";
import test from "node:test";
import {
	AddonSettingsError,
	applySettingsPatch,
	normalizeAddonOptions,
	publicAddonSettings,
	settingsRevision,
} from "../src/harness/addonSettings.ts";

const completeOptions = {
	discord_token: "discord-secret",
	owner_id: "235480697899450368",
	pi_agent_webhook_url: "http://homeassistant:8099/api/webhook",
	local_llm_enabled: true,
	local_llm_url: "http://homeassistant:8080/v1/chat/completions",
	local_llm_model: "qwen3-1.7b",
	local_llm_context_size: 8192,
	local_llm_vision: false,
	model_manager_enabled: true,
	model_manager_url: "http://homeassistant:8080/manager/v1",
	exa_api_key: "exa-secret",
	ha_notify_target: "mobile_app_phone",
	future_option: "preserve-me",
};

test("normalizes every add-on field and redacts secrets", () => {
	const normalized = normalizeAddonOptions(completeOptions);
	const publicValue = publicAddonSettings(normalized);
	assert.equal(publicValue.discordTokenConfigured, true);
	assert.equal(publicValue.exaApiKeyConfigured, true);
	assert.equal(publicValue.ownerId, "235480697899450368");
	assert.equal(publicValue.piAgentWebhookUrl, completeOptions.pi_agent_webhook_url);
	assert.equal(publicValue.localLlmEnabled, true);
	assert.equal(publicValue.localLlmUrl, completeOptions.local_llm_url);
	assert.equal(publicValue.localLlmModel, "qwen3-1.7b");
	assert.equal(publicValue.localLlmContextSize, 8192);
	assert.equal(publicValue.localLlmVision, false);
	assert.equal(publicValue.modelManagerEnabled, true);
	assert.equal(publicValue.modelManagerUrl, completeOptions.model_manager_url);
	assert.equal(publicValue.notifyTarget, "mobile_app_phone");
	assert.equal(JSON.stringify(publicValue).includes("discord-secret"), false);
	assert.equal(JSON.stringify(publicValue).includes("exa-secret"), false);
});

test("revision is stable across key order and changes with values", () => {
	const reordered = Object.fromEntries(Object.entries(completeOptions).reverse());
	assert.equal(settingsRevision(completeOptions), settingsRevision(reordered));
	assert.notEqual(
		settingsRevision(completeOptions),
		settingsRevision({ ...completeOptions, owner_id: "different" }),
	);
});

test("patch maps public fields, preserves secrets and unknown options", () => {
	const merged = applySettingsPatch(completeOptions, {
		localLlmContextSize: 4096,
		discordToken: "",
		exaApiKey: "new-exa-secret",
		notifyTarget: "notify.mobile_app_tablet",
	});
	assert.equal(merged.local_llm_context_size, 4096);
	assert.equal(merged.discord_token, "discord-secret");
	assert.equal(merged.exa_api_key, "new-exa-secret");
	assert.equal(merged.ha_notify_target, "mobile_app_tablet");
	assert.equal(merged.future_option, "preserve-me");
});

test("rejects missing fields, invalid context and unknown patch fields", () => {
	assert.throws(
		() => normalizeAddonOptions({ ...completeOptions, owner_id: undefined }),
		(error: unknown) =>
			error instanceof AddonSettingsError && error.code === "invalid_settings",
	);
	assert.throws(() =>
		applySettingsPatch(completeOptions, { localLlmContextSize: 64 }),
	);
	assert.throws(() => applySettingsPatch(completeOptions, { surprise: true }));
});
