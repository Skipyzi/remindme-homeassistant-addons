import assert from "node:assert/strict";
import test from "node:test";
import { publicSettings } from "../src/harness/settings";

test("public settings expose capability flags but no credentials", () => {
	const settings = publicSettings({
		LOCAL_LLM_URL: "http://homeassistant:8080/v1/chat/completions",
		LOCAL_LLM_MODEL: "qwen3-4b",
		MODEL_MANAGER_ENABLED: "true",
		MODEL_MANAGER_TOKEN_PATH: "/data/model-manager-token",
		SUPERVISOR_TOKEN: "supervisor_test_value",
		HF_TOKEN: "hf_test_value_that_is_not_real",
		EXA_API_KEY: "exa_test_value",
	});
	assert.equal(settings.modelManagerEnabled, true);
	assert.equal(settings.exaConfigured, true);
	const serialized = JSON.stringify(settings);
	for (const forbidden of [
		"model-manager-token",
		"supervisor_test_value",
		"hf_test_value",
		"exa_test_value",
	]) {
		assert.equal(serialized.includes(forbidden), false, forbidden);
	}
});
