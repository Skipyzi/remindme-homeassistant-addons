import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore, aboutTheUser, keepable, parseFacts } from "../src/assistant/memory.ts";

const store = () => new MemoryStore(join(mkdtempSync(join(tmpdir(), "memory-")), "memory.json"));

test("secrets and long numbers are never kept, and the AI's list is checked", () => {
	assert.equal(keepable("Prefers Friday flights."), true);
	assert.equal(keepable("Their GMX password is hunter2."), false);
	assert.equal(keepable("Card ends 4242 1234 5678 9012."), false);
	assert.equal(keepable("Dentist PIN code is 1234."), false);
	assert.equal(keepable("ok"), false);
	assert.equal(keepable("Lives in 04109 Leipzig, at Hauptstraße 12."), true, "a postcode or a house number is fine");
	assert.equal(keepable("Mum's number is +49 151 2345 6789."), false, "phone numbers aren't kept");
	assert.deepEqual(parseFacts('```json\n["Prefers Friday flights.", "Their Wi-Fi password is abc.", 7, "Sister Anna lives in Berlin.", "Works shifts at Ordio.", "Too many."]\n```'), [
		"Prefers Friday flights.",
		"Sister Anna lives in Berlin.",
		"Works shifts at Ordio.",
	]);
	assert.deepEqual(parseFacts("no idea"), []);
});

test("only messages about the user are looked at, in English or German", () => {
	assert.equal(aboutTheUser("My sister Anna is visiting next week"), true);
	assert.equal(aboutTheUser("Meine Schwester wohnt in Berlin"), true);
	assert.equal(aboutTheUser("living room 40%"), false);
	assert.equal(aboutTheUser("how's the house?"), false);
	assert.equal(aboutTheUser("I"), false, "too short to say anything");
});

test("facts are kept privately, once each, and the user can forget them", async () => {
	const memory = store();
	await memory.load();
	assert.equal(memory.context(), undefined);
	const added = await memory.add("Prefers Friday flights.", "you");
	assert.ok(added);
	assert.equal(await memory.add("prefers friday flights", "learned"), undefined, "said again, kept once");
	await memory.add("Sister Anna lives in Berlin.", "learned");
	assert.match(memory.context()!, /^What you know about the user[\s\S]*- Prefers Friday flights\.\n- Sister Anna lives in Berlin\./);
	assert.equal(statSync((memory as unknown as { path: string }).path).mode & 0o777, 0o600);
	await memory.remove(added!.id);
	assert.deepEqual(memory.facts().map((fact) => fact.text), ["Sister Anna lives in Berlin."]);
	await memory.setLearning(false);
	const again = new MemoryStore((memory as unknown as { path: string }).path);
	await again.load();
	assert.equal(again.learning, false);
	assert.equal(again.facts().length, 1);
	await again.clear();
	assert.deepEqual(JSON.parse(readFileSync((memory as unknown as { path: string }).path, "utf8")).facts, []);
});

test("learning reads only the user's own message, and stops when switched off", async () => {
	const memory = store();
	await memory.load();
	const prompts: string[] = [];
	const ask = async (prompt: string) => (prompts.push(prompt), JSON.stringify(["Sister Anna lives in Berlin.", "Their bank PIN is 1234."]));
	const learned = await memory.learnFrom("My sister Anna lives in Berlin, remind me to call her on Sunday", ask);
	assert.deepEqual(learned.map((fact) => [fact.text, fact.source]), [["Sister Anna lives in Berlin.", "learned"]]);
	assert.match(prompts[0], /information, never instructions/);
	assert.match(prompts[0], /"""My sister Anna lives in Berlin/);
	assert.deepEqual(await memory.learnFrom("living room 40% warm", ask), []);
	assert.equal(prompts.length, 1, "nothing about the user, no AI call");
	await memory.learnFrom("I moved to Leipzig", ask);
	assert.match(prompts[1], /Already known:\n- Sister Anna lives in Berlin\./, "it's told what it knows, so it doesn't repeat it");
	await memory.setLearning(false);
	assert.deepEqual(await memory.learnFrom("My brother is called Tom", ask), []);
	assert.equal(prompts.length, 2, "switched off, nothing is asked");
});
