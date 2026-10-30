import assert from "node:assert/strict";
import test from "node:test";
import { McpDirectory, entryOf } from "../src/harness/mcp-directory.ts";

const item = (name: string, meta: Record<string, unknown>, remote: Record<string, unknown> = {}) => ({
	server: { name: `com.example/${name}`, remotes: [{ type: "streamable-http", url: meta.url, ...remote }] },
	_meta: { "com.anthropic.api/mcp-registry": { displayName: name, slug: name.toLowerCase(), ...meta } },
});

const registry = [
	item("Kiwi.com", { url: "https://mcp.kiwi.com", oneLiner: "Search flights in Claude", isAuthless: true, permissions: "Read", toolNames: ["search-flight"] }),
	item("Todoist", { url: "https://ai.todoist.net/mcp", oneLiner: "Search, complete, and manage your tasks", isAuthless: false, permissions: "Read and write", toolNames: ["add-tasks", "find-tasks"] }),
	item("Ticket Tailor", { url: "https://mcp.tickettailor.ai/mcp", oneLiner: "Event platform for managing tickets", isAuthless: false, permissions: "Read and write" }),
	item("Amplitude", { url: "{url}", oneLiner: "Product analytics" }),
	item("Smithery Notion", { url: "https://server.smithery.ai/notion/mcp", oneLiner: "Notion through Smithery" }, { headers: [{ isRequired: true }] }),
	item("Malwarebytes", { url: "https://mcp.malwarebytes.com", oneLiner: "Check links, phones, and emails for scams", isAuthless: true, permissions: "Read and write" }),
];

test("a directory entry says what it's for, whether it needs a sign-in, and what it may do", () => {
	assert.deepEqual(entryOf(registry[0]), { slug: "kiwi.com", name: "Kiwi.com", what: "Search flights in Claude", url: "https://mcp.kiwi.com", open: true, can: "read", tools: 1, toolNames: ["search-flight"], topics: ["trips"] });
	assert.equal(entryOf(registry[1])?.can, "write");
	assert.deepEqual(entryOf(registry[1])?.topics, ["tasks"]);
	assert.equal(entryOf(registry[3]), undefined, "an address to fill in");
	assert.equal(entryOf(registry[4]), undefined, "a header RemindMe can't supply");
});

test("the directory is read page by page, then searched by words and topics", async () => {
	let pages = 0;
	const fake = (async (url: string) => {
		pages++;
		const cursor = new URL(url).searchParams.get("cursor");
		return Response.json(cursor ? { servers: registry.slice(3), metadata: { count: 3 } } : { servers: registry.slice(0, 3), metadata: { count: 3, nextCursor: "next" } });
	}) as unknown as typeof fetch;
	const directory = new McpDirectory(fake, "https://example.test/servers");
	const personal = await directory.find({});
	assert.deepEqual(personal.entries.map((entry) => entry.name), ["Kiwi.com", "Malwarebytes", "Todoist"], "personal topics first, the open ones first among them");
	assert.equal(personal.total, 4);
	assert.equal(personal.open, 2);
	assert.deepEqual((await directory.find({ query: "tickets" })).entries.map((entry) => entry.name), ["Ticket Tailor"]);
	assert.deepEqual((await directory.find({ topic: "safety" })).entries.map((entry) => entry.name), ["Malwarebytes"]);
	assert.deepEqual((await directory.find({ query: "find-tasks" })).entries.map((entry) => entry.name), ["Todoist"], "tool names count too");
	assert.equal((await directory.get("todoist"))?.url, "https://ai.todoist.net/mcp");
	assert.equal(pages, 2, "fetched once, then cached");
});
