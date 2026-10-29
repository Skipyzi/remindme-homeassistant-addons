import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeedWatch, feedFlag, feedLinkIn, newPostsText, wanted } from "../src/connectors/feeds.ts";
import { ConnectorStore, type StoredConnector } from "../src/connectors/store.ts";
import type { FeedItem } from "../src/assistant/news.ts";

// A real feed (tagesschau, 29 October 2026) with four posts; new ones are added in front.
const TAGESSCHAU = readFileSync(new URL("./fixtures/news/tagesschau-inland.xml", import.meta.url), "utf8");
const URL_ = "https://www.tagesschau.de/inland/index~rss2.xml";
const post = (title: string, path: string, summary = "") =>
	`<item><title>${title}</title><link>https://www.tagesschau.de/inland/${path}.html</link><description>${summary}</description><pubDate>Thu, 29 Oct 2026 09:00:00 +0100</pubDate></item>`;

function setup(options: { quiet?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "rm-feeds-"));
	const store = new ConnectorStore(join(dir, "connectors.json"));
	let xml = TAGESSCHAU;
	const told: Array<{ feed: string; posts: string[] }> = [];
	const watch = new FeedWatch({
		store,
		path: join(dir, "feeds.json"),
		fetchFeed: async (url) => {
			if (url === URL_) return xml;
			if (url.endsWith("/page")) return "<html><body>Not a feed</body></html>";
			if (url === "https://www.tagesschau.de/") return `<html><head><link rel="alternate" type="application/rss+xml" title="Inland" href="/inland/index~rss2.xml"></head></html>`;
			throw new Error("HTTP 404");
		},
		checkUrl: async (url) => {
			if (url.includes("192.168.")) throw new Error("That address is not a public one.");
		},
		notify: async (feed: StoredConnector, posts: FeedItem[]) => {
			told.push({ feed: feed.name, posts: posts.map((entry) => entry.title) });
			return true;
		},
		quietUntil: (at) => (options.quiet ? new Date(at.getTime() + 3_600_000) : at),
	});
	return { store, watch, told, publish: (...items: string[]) => (xml = TAGESSCHAU.replace(/<item>/, `${items.join("")}<item>`)) };
}
const minutes = (count: number) => new Date(Date.parse("2026-10-29T08:00:00Z") + count * 60_000);

test("a feed is added by its link: checked, named after itself, new-post notices on, not in the news", async () => {
	const { watch, store } = setup();
	const feed = await watch.add({ url: URL_ }, minutes(0));
	assert.equal(feed.kind, "feed");
	assert.equal(feed.name, "Aktuelle Nachrichten aus Deutschland");
	assert.deepEqual(feed.values, { url: URL_, news: "off", alerts: "on", words: "" });
	assert.equal(store.list("mail").length, 0);
	assert.deepEqual(watch.status(feed.id), { ok: true, at: minutes(0).toISOString(), posts: 4, newest: watch.status(feed.id)!.newest });
	await assert.rejects(() => watch.add({ url: URL_ }), /connected already/);
	await assert.rejects(() => watch.add({ url: "https://example.org/page" }), /No posts at that address/);
	await assert.rejects(() => watch.add({ url: "https://example.org/gone" }), /didn't answer: HTTP 404/);
	await assert.rejects(() => watch.add({ url: "http://192.168.178.49/feed" }), /not a public one/);
	await assert.rejects(() => watch.add({ url: "feed.xml" }), /isn't a link/);
	// A site's address works when its page names the feed.
	const fromSite = setup();
	const found = await fromSite.watch.add({ url: "https://www.tagesschau.de/" });
	assert.equal(found.values.url, URL_);
	await assert.rejects(() => fromSite.watch.add({ url: "https://www.tagesschau.de/" }), /connected already/);
	assert.equal(feedLinkIn(`<link type="application/atom+xml" rel="alternate" href="https://a.example/atom.xml?x=1&amp;y=2">`, "https://a.example/"), "https://a.example/atom.xml?x=1&y=2");
	assert.equal(feedLinkIn(`<link rel="stylesheet" href="/style.css">`, "https://a.example/"), undefined);
	const named = await setup().watch.add({ url: URL_, name: "Inland", news: true, alerts: false });
	assert.deepEqual([named.name, feedFlag(named, "news"), feedFlag(named, "alerts")], ["Inland", true, false]);
});

test("new posts are told once, every half hour, never in quiet hours; the posts there at the start aren't news", async () => {
	const { watch, told, publish } = setup();
	await watch.add({ url: URL_ }, minutes(0));
	await watch.tick(minutes(31));
	assert.deepEqual(told, [], "nothing new");
	publish(post("Bundestag beschließt Haushalt", "haushalt-100"));
	await watch.tick(minutes(40));
	assert.deepEqual(told, [], "not due yet");
	await watch.tick(minutes(62));
	assert.deepEqual(told, [{ feed: "Aktuelle Nachrichten aus Deutschland", posts: ["Bundestag beschließt Haushalt"] }]);
	await watch.tick(minutes(93));
	assert.equal(told.length, 1, "the same post isn't told twice");

	const quiet = setup({ quiet: true });
	await quiet.watch.add({ url: URL_ }, minutes(0));
	quiet.publish(post("Neu", "neu-100"));
	await quiet.watch.tick(minutes(60));
	assert.deepEqual(quiet.told, []);
});

test("only posts with the words asked for; turning notices back on doesn't tell what came meanwhile", async () => {
	const { watch, told, publish, store } = setup();
	const feed = await watch.add({ url: URL_, words: "Bahn, Streik" }, minutes(0));
	publish(post("Bundestag beschließt Haushalt", "haushalt-100"), post("GDL kündigt Streik an", "streik-100", "Die Bahn"));
	await watch.check(store.get(feed.id)!, minutes(31));
	assert.deepEqual(told.map((entry) => entry.posts), [["GDL kündigt Streik an"]]);

	await watch.update(feed.id, { alerts: false }, minutes(32));
	publish(post("Bahn: neuer Fahrplan", "fahrplan-100"));
	await watch.tick(minutes(120));
	assert.equal(told.length, 1, "notices off");
	await watch.update(feed.id, { alerts: true }, minutes(121));
	await watch.tick(minutes(200));
	assert.equal(told.length, 1, "what came while they were off is seen, not told");

	assert.equal(wanted({ title: "Zigbee 4.0", link: "", summary: "" }, ""), true);
	assert.equal(wanted({ title: "Release", link: "", summary: "now with Matter" }, "zigbee, matter"), true);
	assert.equal(wanted({ title: "Release", link: "", summary: "" }, "zigbee"), false);
});

test("a notice: one post with its link, several as a short list", () => {
	const feed = { name: "Home Assistant" } as StoredConnector;
	const item = (title: string, link: string): FeedItem => ({ title, link, summary: "" });
	assert.equal(newPostsText(feed, [item("2026.11 is out", "https://www.home-assistant.io/blog/2026/11/(x)")]), "📰 New on Home Assistant: [2026.11 is out](https://www.home-assistant.io/blog/2026/11/%28x%29)");
	const many = newPostsText(feed, Array.from({ length: 7 }, (_, index) => item(`Post ${index + 1}`, `https://a.example/${index}`)));
	assert.match(many, /^📰 7 new on Home Assistant:\n- \[Post 1\]\(https:\/\/a\.example\/0\)/);
	assert.match(many, /- \[Post 5\][^\n]+\n- and 2 more$/);
});

test("the assistant reads the latest posts, of one feed or all; a failing feed is named; removing forgets it", async () => {
	const { watch, store } = setup();
	const feed = await watch.add({ url: URL_, name: "Inland" }, minutes(0));
	const broken = await store.create({ kind: "feed", preset: "rss", name: "Broken", enabled: true, values: { url: "https://example.org/gone" }, secrets: {} });
	const all = await watch.latest(undefined, minutes(1));
	assert.equal(all.posts.length, 4);
	assert.ok(all.posts.every((entry) => entry.feed === "Inland"));
	assert.deepEqual(all.problems, ["Broken (HTTP 404)"]);
	assert.equal(watch.status(broken.id)?.ok, false);
	assert.equal((await watch.latest("inl", minutes(2))).posts.length, 4);
	assert.equal(await watch.remove(feed.id), true);
	assert.equal(watch.status(feed.id), undefined);
	assert.equal(store.list("feed").length, 1);
});
