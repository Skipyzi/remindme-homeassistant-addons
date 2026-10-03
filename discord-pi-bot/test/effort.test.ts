import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { getThinkingProfile, thinkingProfilesForBackend } from "../src/harness/thinkingProfiles";

const smallPi = 2 * 1_073_741_824;

test("legacy effort selections retain their reasoning budget after migration", () => {
	for (const [old, current, budget] of [["fast", "none", 0], ["balanced", "low", 512], ["deep", "medium", 2048], ["research", "high", 4096]] as const) {
		const profile = getThinkingProfile(old, 8 * 1_073_741_824, 8192);
		assert.equal(profile.id, current);
		assert.equal(profile.reasoningBudget, budget);
	}
});

test("cloud effort is independent of Pi RAM while local decoding stays bounded", () => {
	assert.equal(thinkingProfilesForBackend(smallPi, 4096).some((profile) => profile.id === "high"), false);
	const cloud = thinkingProfilesForBackend(smallPi, 4096, { openaiCompat: true, authProvider: "chatgpt", model: "gpt-5.6-luna" });
	assert.deepEqual(cloud.map((profile) => profile.name), ["None", "Low", "Medium", "High"]);
	assert.equal(cloud.at(-1)?.estimatedMaxSeconds, 0);
	assert.equal(getThinkingProfile("research", smallPi, 4096, { openaiCompat: true, model: "gpt-5.6-luna" }).id, "high");
});

test("backends with a minimum of Low do not advertise None", () => {
	for (const backend of [
		{ openaiCompat: true, authProvider: "claude" as const, model: "sonnet" },
		{ openaiCompat: true, authProvider: "chatgpt" as const, model: "gpt-6-astra" },
		{ openaiCompat: true, model: "gpt-6.1-sol" },
	]) {
		assert.deepEqual(thinkingProfilesForBackend(smallPi, 4096, backend).map((profile) => profile.id), ["low", "medium", "high"]);
		assert.equal(getThinkingProfile("fast", smallPi, 4096, backend).id, "low");
	}
});

test("browser migration preserves saved effort across server refresh and reload", async () => {
	const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
	for (const [old, current] of [["fast", "none"], ["balanced", "low"], ["deep", "medium"], ["research", "high"]]) {
		const storage = new Map([["remindme.profile", old]]);
		const context = {
			window: { RemindMeModelCookbook: { state: () => ({}) } },
			document: { getElementById: () => null },
			localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
			fetch: async () => Response.json({ remoteInference: true, profiles: thinkingProfilesForBackend(smallPi, 4096, { openaiCompat: true, model: "gpt-5.6-luna" }) }),
		};
		runInNewContext(script, context);
		const app = runInNewContext("harness()", context);
		assert.equal(app.thinking, current);
		assert.equal(storage.get("remindme.profile"), current);
		await app.refreshStatus();
		assert.equal(app.thinking, current);
		assert.equal(app.remoteInference, true);
		assert.equal(runInNewContext("harness()", context).thinking, current);
	}
});
