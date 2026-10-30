import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyUsage } from "../src/ai/types.ts";
import { JobRunner } from "../src/assistant/jobs.ts";
import { MAIN_THREAD, ThreadStore } from "../src/assistant/threads.ts";
import { PersonaStore, defaultPersona } from "../src/harness/persona.ts";

const folder = () => mkdtempSync(join(tmpdir(), "identity-"));

test("the assistant has a name and a cat of its own, and the prompt knows the name", async () => {
	const path = join(folder(), "persona.json");
	const persona = new PersonaStore(path);
	await persona.load();
	assert.equal(persona.assistantName(), "RemindMe");
	assert.equal(persona.catSeed(), "remindme", "until a cat is picked, it keeps the one it always had");

	await persona.setIdentity({ name: "  Mochi <b>  ", look: { coat: 2, accessory: 3 } });
	assert.equal(persona.assistantName(), "Mochi b", "one plain line, no markup");
	await persona.setIdentity({ name: "Mochi" });
	assert.equal(persona.catSeed(), "look:2-3");
	assert.equal(persona.forModel(), defaultPersona("Mochi"), "the built-in instructions use its name");
	await persona.setIdentity({ look: { coat: 9, accessory: 1 } });
	assert.deepEqual(persona.lookOf(), { coat: 2, accessory: 3 }, "a look that doesn't exist is ignored");

	await persona.set(defaultPersona("Mochi"));
	assert.equal(persona.isCustom(), false, "the default saved unchanged stays the default");
	await persona.set("Be brief and dry.");
	assert.equal(persona.forModel(), "Be brief and dry.\n\nYour name is Mochi.", "own instructions still learn its name");

	const again = new PersonaStore(path);
	await again.load();
	assert.equal(again.assistantName(), "Mochi");
	assert.equal(again.catSeed(), "look:2-3");
	await again.setIdentity({ name: "", look: null });
	assert.equal(again.assistantName(), "RemindMe");
	assert.equal(again.catSeed(), "remindme");
});

test("the main chat starts over into History, and a job from it gets a thread of its own", async () => {
	const threads = new ThreadStore(join(folder(), "threads.json"));
	const main = threads.ensure(MAIN_THREAD, "Mochi");
	threads.setModel(MAIN_THREAD, { provider: "claude", model: "claude-haiku-5-5" });
	threads.append(MAIN_THREAD, { role: "user", text: "Find me a robot vacuum under 300 €" });

	const runner = new JobRunner({
		threads,
		ask: async () => ({ text: "", confirms: [], cards: [], embeds: [], artifacts: [], did: [], model: "test", usage: emptyUsage(), rounds: 1 }),
		notify: async () => {},
		runsPerGo: 1,
	});
	const job = runner.start({ title: "Robot vacuums under 300 €", instructions: "Compare.", threadId: MAIN_THREAD, origin: "console", request: "Find me a robot vacuum under 300 €" });
	assert.notEqual(job.id, MAIN_THREAD, "the main chat doesn't become the job");
	assert.equal(threads.get(MAIN_THREAD)?.job, undefined);
	assert.equal(threads.get(job.id)?.messages[0]?.text, "Find me a robot vacuum under 300 €", "the job's thread starts with the request");
	runner.stop(job.id);

	threads.append(MAIN_THREAD, { role: "assistant", text: "I've started a job for that." });
	const archived = threads.restart(MAIN_THREAD, "Chat with Mochi until 30 Oct");
	assert.ok(archived?.archivedAt, "the old chat is in History");
	assert.equal(archived?.messages.length, 2);
	assert.deepEqual(archived?.model, { provider: "claude", model: "claude-haiku-5-5" });
	assert.equal(threads.get(MAIN_THREAD)?.messages.length, 0);
	assert.equal(threads.get(MAIN_THREAD)?.model, undefined, "the next answer comes from the default AI");
	assert.equal(threads.restart(MAIN_THREAD, "again"), undefined, "an empty chat has nothing to move");
});
