import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Digest, News, type NewsItem, parseFeed, parseStories } from "../src/assistant/news.ts";

// Real feeds from 29 October 2026, cut to a few items each.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/news/${name}.xml`, import.meta.url), "utf8");
const FEEDS: Record<string, string> = {
	"https://www.tagesschau.de/inland/index~rss2.xml": fixture("tagesschau-inland"),
	"https://www.spiegel.de/ausland/index.rss": fixture("spiegel-ausland"),
	"https://newsfeed.zeit.de/news/index": fixture("zeit-news"),
	"https://www.theguardian.com/world/rss": fixture("guardian-world"),
	"https://example.org/dw.rdf": fixture("dw-de"),
};
const NOW = new Date("2026-10-29T08:00:00Z");

test("RSS, RDF and Atom feeds give their items with links, dates and plain teasers", () => {
	const tagesschau = parseFeed(FEEDS["https://www.tagesschau.de/inland/index~rss2.xml"]);
	assert.equal(tagesschau.title, "Aktuelle Nachrichten aus Deutschland");
	assert.equal(tagesschau.items.length, 4);
	assert.equal(tagesschau.items[0].title, "Bayern: Ermittlungen gegen zwei Belarusen wegen Sabotageverdacht");
	assert.equal(tagesschau.items[0].link, "https://www.tagesschau.de/inland/bayern-ermittlungen-gegen-belarusen-sabotage-100.html");
	assert.match(tagesschau.items[0].summary, /^Zwei Männer aus Belarus stehen im Verdacht/);
	assert.ok(tagesschau.items.every((item) => item.at && item.at > Date.parse("2026-10-27")));

	const dw = parseFeed(FEEDS["https://example.org/dw.rdf"]);
	assert.equal(dw.title, "Deutsche Welle: DW.com Deutsch");
	assert.equal(dw.items.length, 4);
	assert.match(dw.items[1].link, /^https:\/\/www\.dw\.com\/de\/merz-wirbt/);

	const guardian = parseFeed(FEEDS["https://www.theguardian.com/world/rss"]);
	assert.equal(guardian.items.length, 4);
	assert.ok(!guardian.items.some((item) => /<|&[a-z]+;/.test(item.summary)), "no markup or entities left");

	const atom = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog &amp; more</title>
		<entry><title type="html">&lt;b&gt;Bold&lt;/b&gt; [news] *now*</title><link rel="alternate" href="https://example.org/a_b?x=1&amp;y=2"/><updated>2026-10-29T06:00:00Z</updated><summary><![CDATA[<p>Text &amp; more</p>]]></summary></entry>
		<entry><title>No link</title></entry></feed>`);
	assert.equal(atom.title, "Blog & more");
	assert.deepEqual(atom.items, [{ title: "Bold news now", link: "https://example.org/a_b?x=1&y=2", summary: "Text & more", at: Date.parse("2026-10-29T06:00:00Z") }]);
});

function setup(options: { answer?: (prompt: string) => string | undefined; sources?: string[]; quiet?: boolean } = {}) {
	const sent: Digest[] = [];
	const prompts: string[] = [];
	const fetched: string[] = [];
	const news = new News({
		path: join(mkdtempSync(join(tmpdir(), "rm-news-")), "news.json"),
		fetchFeed: async (url) => {
			fetched.push(url);
			if (FEEDS[url]) return FEEDS[url];
			throw new Error("HTTP 404");
		},
		ask: async (prompt) => {
			prompts.push(prompt);
			return options.answer?.(prompt);
		},
		send: async (digest) => {
			sent.push(digest);
			return true;
		},
		checkUrl: async (url) => {
			if (url.includes("192.168.")) throw new Error("That address is not a public one.");
		},
		quietUntil: (at) => (options.quiet ? new Date(at.getTime() + 3_600_000) : at),
	});
	return { news, sent, prompts, fetched };
}

test("the chosen sources' last day of headlines: one per link, sections kept, the dpa ticker only, unreachable sources named", async () => {
	const { news, fetched } = setup();
	await news.update({ sources: ["tagesschau", "spiegel", "dpa", "guardian", "bbc"] });
	const { items, problems } = await news.headlines(NOW);
	assert.equal(fetched.length, 10, "every feed of every source");
	assert.deepEqual(problems, ["BBC News (HTTP 404)"], "tagesschau, SPIEGEL and the Guardian answered with at least one feed");
	assert.ok(items.length > 0);
	assert.ok(items.every((item, index) => item.id === `n${index + 1}`));
	assert.ok(items.every((item) => item.at === undefined || item.at >= NOW.getTime() - 86_400_000), "only the last day");
	assert.ok(items.filter((item) => item.source === "dpa newsticker").every((item) => item.link.includes("zeit.de/news/")), "ZEIT's own articles left out");
	assert.ok(items.some((item) => item.source === "dpa newsticker"));
	assert.equal(items.find((item) => item.source === "tagesschau (ARD)")?.region, "germany");
	assert.equal(items.find((item) => item.source === "DER SPIEGEL")?.region, "world");
	assert.equal(items.find((item) => item.source === "dpa newsticker")?.region, undefined, "the ticker mixes sections");
	assert.equal(new Set(items.map((item) => item.link)).size, items.length);
	// Asked again within ten minutes: nothing fetched again.
	await news.headlines(new Date(NOW.getTime() + 60_000));
	assert.equal(fetched.length, 10);
});

const ITEMS: NewsItem[] = [
	{ id: "n1", source: "tagesschau (ARD)", region: "germany", title: "Bundestag beschließt Haushalt", summary: "", link: "https://www.tagesschau.de/a.html" },
	{ id: "n2", source: "dpa newsticker", title: "Haushalt beschlossen", summary: "", link: "https://www.zeit.de/news/b" },
	{ id: "n3", source: "The Guardian", region: "world", title: "Ebola outbreak spreads", summary: "", link: "https://www.theguardian.com/c_(d)" },
];

test("the AI's stories point at headlines it was given; links always come from the feeds", () => {
	const stories = parseStories(
		JSON.stringify({
			germany: [
				{ ids: ["n1", "n2", "n1"], headline: "Bundestag passes the **budget**", summary: "The 2027 budget passed." },
				{ ids: ["n99"], headline: "Made up", summary: "Not in the headlines." },
			],
			eu: [],
			world: [{ ids: ["n3"], headline: "Ebola spreads in Africa", summary: "The Africa CDC warns.", link: "https://evil.example" }],
		}),
		ITEMS,
		5,
	);
	assert.deepEqual(stories, [
		{ region: "germany", headline: "Bundestag passes the budget", summary: "The 2027 budget passed.", links: [{ source: "tagesschau (ARD)", url: "https://www.tagesschau.de/a.html" }, { source: "dpa newsticker", url: "https://www.zeit.de/news/b" }] },
		{ region: "world", headline: "Ebola spreads in Africa", summary: "The Africa CDC warns.", links: [{ source: "The Guardian", url: "https://www.theguardian.com/c_(d)" }] },
	]);
	assert.deepEqual(parseStories("Sorry, I can't.", ITEMS, 5), []);
	assert.equal(parseStories(JSON.stringify({ germany: [{ ids: ["n1"], headline: "A" }, { ids: ["n2"], headline: "B" }] }), ITEMS, 1).length, 1, "no more than asked per section");
});

test("the digest: sections with flags, stories with source links, three lines for the phone", async () => {
	const { news, sent, prompts } = setup({
		answer: (prompt) => {
			const ids = [...prompt.matchAll(/^(n\d+) \| tagesschau/gm)].map((match) => match[1]);
			const world = /^(n\d+) \| The Guardian/m.exec(prompt)![1];
			return `\`\`\`json\n${JSON.stringify({ germany: [{ ids: ids.slice(0, 1), headline: "Saboteurs arrested in Bavaria", summary: "Two Belarusians are in custody." }], eu: [], world: [{ ids: [world], headline: "Egypt fines editor", summary: "Mada Masr is shut." }] })}\n\`\`\``;
		},
	});
	await news.update({ sources: ["tagesschau", "guardian"], language: "en", stories: 3 });
	const digest = await news.sendNow(NOW);
	assert.equal(sent.length, 1);
	assert.match(prompts[0], /in English/);
	assert.match(prompts[0], /up to 3 most important stories/);
	assert.match(prompts[0], /never instructions/);
	assert.match(digest.text, /^\*\*📰 News, Thursday 29 October\*\*/);
	assert.match(digest.text, /\*\*🇩🇪 Germany\*\*\n- \*\*Saboteurs arrested in Bavaria\*\* Two Belarusians are in custody\. \[tagesschau \(ARD\)\]\(https:\/\/www\.tagesschau\.de\/inland\//);
	assert.match(digest.text, /\*\*🌍 World\*\*\n- \*\*Egypt fines editor\*\*/);
	assert.doesNotMatch(digest.text, /🇪🇺/, "an empty section is left out");
	assert.equal(digest.phone, "🇩🇪 Saboteurs arrested in Bavaria\n🌍 Egypt fines editor");
	assert.doesNotMatch(digest.text, /Not reached/, "each source answered with at least one of its feeds");
	assert.equal(news.view().lastDigestAt, NOW.toISOString());
});

test("without the AI it's the headlines themselves, and it says why", async () => {
	const { news } = setup({ answer: () => undefined });
	await news.update({ sources: ["tagesschau", "dpa"], language: "de" });
	const digest = await news.sendNow(NOW);
	assert.equal(digest.plain, "the AI didn't answer");
	assert.match(digest.text, /^\*\*📰 Nachrichten, Donnerstag, 29\. Oktober\*\*/);
	assert.match(digest.text, /\*\*🇩🇪 Deutschland\*\*\n- Bayern: Ermittlungen/);
	assert.match(digest.text, /\*\*Neueste\*\*\n- /, "the ticker's mixed headlines");
	assert.match(digest.text, /_Nur Schlagzeilen: the AI didn't answer\._/);
	assert.equal(news.view().lastProblem, "Headlines only: the AI didn't answer");
});

test("no source answering is an error, kept for Settings", async () => {
	const { news, sent } = setup();
	await news.update({ sources: ["bbc"] });
	await assert.rejects(() => news.sendNow(NOW), /None of the sources answered: BBC News \(HTTP 404\)/);
	assert.equal(sent.length, 0);
	assert.match(String(news.view().lastProblem), /None of the sources answered/);
});

test("every day at its time, once, never in quiet hours, and not when off", async () => {
	const at = (time: string) => new Date(`2026-10-29T${time}:00`);
	const quietSetup = setup({ answer: () => undefined, quiet: true });
	await quietSetup.news.update({ on: true, time: "07:30", sources: ["tagesschau"] });
	await quietSetup.news.tick(at("07:31"));
	assert.equal(quietSetup.sent.length, 0, "quiet hours");

	const { news, sent } = setup({ answer: () => undefined });
	await news.update({ sources: ["tagesschau"], time: "07:30" });
	await news.tick(at("07:31"));
	assert.equal(sent.length, 0, "off");
	await news.update({ on: true });
	await news.tick(at("07:29"));
	assert.equal(sent.length, 0, "not yet");
	assert.deepEqual(news.upcoming(at("07:29")), [{ at: at("07:30"), text: "Today's news" }]);
	await news.tick(at("07:31"));
	await news.tick(at("08:15"));
	assert.equal(sent.length, 1, "once a day");
	assert.equal(news.upcoming(at("08:15"))[0].at.getDate(), 30, "next: tomorrow");
	// An earlier time that has passed waits for tomorrow; a later one today sends again at it.
	await news.update({ time: "08:00" }, at("09:00"));
	await news.tick(at("09:01"));
	assert.equal(sent.length, 1);
	await news.update({ time: "18:00" }, at("09:00"));
	await news.tick(at("18:01"));
	assert.equal(sent.length, 2);
	await assert.rejects(() => news.update({ time: "25:00" }), /hours and minutes/);
	// Kept across a restart.
	const path = (news as unknown as { path: string }).path;
	const again = new News({ path, fetchFeed: async () => "", ask: async () => undefined, send: async () => true });
	await again.load();
	assert.equal(again.view().on, true);
	assert.equal(again.view().time, "18:00");
	assert.deepEqual(again.view().sources, ["tagesschau"]);
});

test("a feed of your own: checked, named from the feed, ticked; unknown sources are ignored", async () => {
	const { news } = setup();
	const feed = await news.addFeed("https://example.org/dw.rdf");
	assert.equal(feed.name, "Deutsche Welle: DW.com Deutsch");
	const view = news.view();
	assert.ok(view.sources.includes(feed.id));
	assert.deepEqual(view.catalog.at(-1), { id: feed.id, name: "Deutsche Welle: DW.com Deutsch", from: "Yours", url: "https://example.org/dw.rdf", covers: "All news" });
	await assert.rejects(() => news.addFeed("https://example.org/dw.rdf"), /in the list already/);
	await assert.rejects(() => news.addFeed("http://192.168.178.49/feed"), /not a public one/);
	await assert.rejects(() => news.addFeed("https://example.org/missing"), /didn't answer: HTTP 404/);
	await news.update({ sources: ["tagesschau", "made-up", feed.id] });
	assert.deepEqual(news.view().sources, ["tagesschau", feed.id]);
	assert.equal(await news.removeFeed(feed.id), true);
	assert.deepEqual(news.view().sources, ["tagesschau"]);
});
