import assert from "node:assert/strict";
import test from "node:test";
import history from "../public/components/chat-history.js";

test("history retains executed lighting receipts and marks later unexecuted claims", () => {
	const turns = history.fromMessages([
		{ kind: "user", text: "Sunset using Paper Lamp and Kitchen Counter" },
		{ kind: "tool", name: "home_lighting", state: "complete", arguments: { lights: [{ target: "Paper Lamp", brightness: 30 }] }, result: { done: ["light.paper_lamp"], problems: [] } },
		{ kind: "answer", text: "Applied sunset." },
		{ kind: "user", text: "how about cyberpunk" },
		{ kind: "answer", text: "Paper Lamp: set to violet." },
	]);
	assert.match(turns[1].content, /App action receipts/);
	assert.match(turns[1].content, /light.paper_lamp/);
	assert.match(turns[3].content, /No app device-action receipt/);
	assert.doesNotMatch(turns[3].content, /App action receipts:/);
});

test("pending confirmations are not execution receipts and private tokens stay out of history", () => {
	const turns = history.fromMessages([
		{ kind: "user", text: "unlock the door" },
		{ kind: "tool", name: "home_control", state: "complete", arguments: { targets: ["Door"], command: "unlock" }, result: { done: [], awaiting_confirmation: ["Door"], token: "private-token" } },
		{ kind: "tool", name: "home_control · Door", state: "complete", result: { confirmation_required: true, token: "private-token" } },
		{ kind: "answer", text: "Tap confirm." },
	]);
	assert.match(turns[1].content, /awaiting_confirmation/);
	assert.doesNotMatch(turns[1].content, /private-token/);
});

test("search sources survive follow-ups without replaying full search results", () => {
	const turns = history.fromMessages([
		{ kind: "user", text: "news" }, { kind: "tool", name: "web_search", result: { results: [{ title: "Story", url: "https://example.com/story", snippet: "large snippet" }] } },
		{ kind: "answer", text: "The news." },
	]);
	assert.match(turns[1].content, /https:\/\/example.com\/story/);
	assert.doesNotMatch(turns[1].content, /large snippet/);
});
