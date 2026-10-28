import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiscordChats, splitMessage } from "../src/discord/chats.ts";
import { confirmRows, isReset, promptFrom } from "../src/discord/assistantChat.ts";

test("the prompt loses the mention and the old !chat prefix", () => {
	assert.equal(promptFrom("<@123> turn off the lamp", "123"), "turn off the lamp");
	assert.equal(promptFrom("<@!123>   is it raining", "123"), "is it raining");
	assert.equal(promptFrom("!chat what's on today"), "what's on today");
	assert.equal(promptFrom("plain DM"), "plain DM");
});

test("'new' and 'reset' start a fresh chat; sentences with those words don't", () => {
	assert.equal(isReset("new"), true);
	assert.equal(isReset("Start over!"), true);
	assert.equal(isReset("new batteries for the remote?"), false);
});

test("long replies split at line breaks under Discord's limit", () => {
	const text = Array.from({ length: 80 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
	const chunks = splitMessage(text, 1900);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((chunk) => chunk.length <= 1900));
	assert.equal(chunks.join("\n"), text);
	assert.deepEqual(splitMessage("   "), ["(empty reply)"]);
});

test("a chat keeps its turns, forgets after a quiet spell, and survives a restart", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "chats-")), "chats.json");
	const chats = new DiscordChats(path);
	const t0 = 1_000_000;
	chats.append("dm1", [{ role: "assistant", text: "☀️ Brief" }], t0);
	chats.append("dm1", [{ role: "user", text: "thanks" }, { role: "assistant", text: "  " }], t0 + 60_000);
	assert.deepEqual(chats.history("dm1", t0 + 120_000), [
		{ role: "assistant", text: "☀️ Brief" },
		{ role: "user", text: "thanks" },
	]);
	assert.deepEqual(chats.history("dm1", t0 + 7 * 3_600_000), []);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const reloaded = new DiscordChats(path);
	await reloaded.load();
	assert.equal(reloaded.history("dm1", t0 + 120_000).length, 2);
	reloaded.reset("dm1");
	assert.deepEqual(reloaded.history("dm1", t0 + 120_000), []);
});

test("each held action gets a confirm and a cancel button", () => {
	const rows = confirmRows([
		{ confirmation_required: true, token: "abc", destructive: true, message: "Unlock Front door", entityId: "lock.front" },
	]).map((row) => row.toJSON());
	assert.equal(rows.length, 1);
	const [confirm, cancel] = rows[0].components as Array<{ custom_id: string; label: string; style: number }>;
	assert.equal(confirm.custom_id, "assistant:ok:abc");
	assert.equal(confirm.label, "Unlock Front door");
	assert.equal(confirm.style, 4, "danger for anything that opens the house");
	assert.equal(cancel.custom_id, "assistant:no:abc");
});
