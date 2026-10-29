import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Embed, addEmbed, embedText, mapImages, takeEmbeds } from "../src/assistant/embeds.ts";
import { PlaceSearch, openingStatus, placeEmbed, placeFrom, weekHours } from "../src/assistant/places.ts";
import { parseFeed } from "../src/assistant/news.ts";
import { geizhalsOffers } from "../src/assistant/prices.ts";
import { MediaProxy } from "../src/harness/media.ts";
import { pagePreview } from "../src/harness/reader.ts";

const offers: Embed = { kind: "offers", title: "Sony WH-1000XM5 Black", url: "https://geizhals.de/a2733874.html", image: "https://gzhls.at/xm5.webp", meta: "24 offers on Geizhals, checked 09:12", offers: [{ price: "199,99 €", shop: "expert TechnoMarkt", note: "free shipping" }, { price: "204,99 €", shop: "collect2bletcg" }], watching: "Watching, under 180,00 €" };
const article: Embed = { kind: "article", title: "Everything Smart Home joins Works with Home Assistant", url: "https://www.home-assistant.io/blog/x/", source: "Home Assistant", image: "https://www.home-assistant.io/art.webp" };

test("the answer's [[c1]] markers pick its cards, in order, once each, and leave the text clean", () => {
	const shelf = { embeds: [] as Embed[] };
	assert.equal(addEmbed(shelf, offers), "c1");
	assert.equal(addEmbed(shelf, article), "c2");
	const { text, shown } = takeEmbeds("Cheapest at expert.\n\n[[c2]]\n[[c1]] [[c2]] [[c9]]", shelf.embeds);
	assert.equal(text, "Cheapest at expert.");
	assert.deepEqual(shown, [article, offers], "unknown ids are left out, repeats too");
	assert.deepEqual(takeEmbeds("No cards here.", shelf.embeds), { text: "No cards here.", shown: [] });
	assert.deepEqual(takeEmbeds("[[c1]]", shelf.embeds), { text: "", shown: [offers] });
});

test("Discord and the phone get cards as plain lines", () => {
	assert.equal(embedText(offers), "**Sony WH-1000XM5 Black** (24 offers on Geizhals, checked 09:12)\n- 199,99 € at expert TechnoMarkt, free shipping\n- 204,99 € at collect2bletcg\n[Open](https://geizhals.de/a2733874.html)");
	assert.equal(embedText(article), "- [Everything Smart Home joins Works with Home Assistant](https://www.home-assistant.io/blog/x/) (Home Assistant)");
	const place = placeEmbed({ name: "Saturn", lat: 51.3436, lon: 12.377, address: "Brühl 1, 04109 Leipzig", status: { text: "Open now, until 20:00", open: true } });
	assert.match(embedText(place), /^\*\*Saturn\*\*: Open now, until 20:00\nBrühl 1, 04109 Leipzig\n\[Directions\]\(https:\/\/maps\.apple\.com/);
	const changed = mapImages(offers, (url) => `proxy:${url}`);
	assert.equal((changed as { image: string }).image, "proxy:https://gzhls.at/xm5.webp");
	assert.equal((offers as { image: string }).image, "https://gzhls.at/xm5.webp", "the stored card is left as it was");
});

test("opening hours read for right now: today, past midnight, tomorrow, and what's beyond this reader", () => {
	const at = (day: string, time: string) => new Date(`${day}T${time}:00`);
	// 29 October 2026 is a Thursday.
	assert.deepEqual(openingStatus("Mo-Sa 10:00-20:00; PH off", at("2026-10-29", "14:00")), { text: "Open now, until 20:00", open: true });
	assert.deepEqual(openingStatus("Mo-Sa 10:00-20:00", at("2026-10-29", "08:30")), { text: "Closed, opens at 10:00", open: false });
	assert.deepEqual(openingStatus("Mo-Sa 10:00-20:00", at("2026-10-31", "21:00")), { text: "Closed, opens Monday at 10:00", open: false }, "Saturday night");
	assert.deepEqual(openingStatus("Mo-Fr 08:00-12:00,14:00-18:00", at("2026-10-29", "12:30")), { text: "Closed, opens at 14:00", open: false });
	assert.deepEqual(openingStatus("Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off", at("2026-10-29", "19:00")), { text: "Closed, opens tomorrow at 09:00", open: false });
	assert.deepEqual(openingStatus("Fr-Sa 18:00-02:00", at("2026-10-31", "01:30")), { text: "Open now, until 02:00", open: true }, "Friday night, past midnight");
	assert.deepEqual(openingStatus("Mo-Su 00:00-24:00", at("2026-10-29", "23:00")), { text: "Open now, until midnight", open: true });
	assert.deepEqual(openingStatus("24/7", at("2026-10-29", "03:00")), { text: "Open now, until midnight", open: true });
	assert.deepEqual(openingStatus("Mo-Fr 09:00-18:00; We off", at("2026-10-28", "10:00"))?.open, false, "a later rule wins");
	assert.equal(openingStatus("Jan-Mar Mo-Fr 09:00-17:00", at("2026-10-29", "10:00")), undefined);
	assert.equal(openingStatus("sunrise-sunset", at("2026-10-29", "10:00")), undefined);
	assert.equal(weekHours("Mo-Fr 09:00-18:00, Sa 10:00-14:00"), undefined, "comma-joined rules: left to the raw text");
});

const hit = {
	lat: "51.3436",
	lon: "12.3770",
	name: "Saturn",
	type: "electronics",
	address: { road: "Brühl", house_number: "1", postcode: "04109", city: "Leipzig" },
	extratags: { opening_hours: "Mo-Sa 10:00-20:00", phone: "+49 341 1234 567; +49 341 7654", website: "https://www.saturn.de/de/store/leipzig-hoefe-am-bruehl" },
};

test("an OpenStreetMap result as a place and a card: address, hours now, distance from home, links", () => {
	const place = placeFrom(hit, new Date("2026-10-29T14:00:00"), { lat: 51.3555, lon: 12.37 });
	assert.deepEqual(
		{ ...place, away: Math.round((place.away || 0) / 100) * 100 },
		{ name: "Saturn", kind: "electronics", lat: 51.3436, lon: 12.377, address: "Brühl 1, 04109 Leipzig", hours: "Mo-Sa 10:00-20:00", status: { text: "Open now, until 20:00", open: true }, phone: "+49 341 1234 567", website: "https://www.saturn.de/de/store/leipzig-hoefe-am-bruehl", away: 1400 },
	);
	const card = placeEmbed(place);
	assert.equal(card.kind, "place");
	assert.deepEqual(
		(card as { links: Array<{ label: string; url: string }> }).links.map((link) => link.label),
		["Directions", "Website", "Call"],
	);
	assert.equal((card as { links: Array<{ url: string }> }).links[2].url, "tel:+493411234567");
	assert.deepEqual((card as { lines: string[] }).lines, ["Brühl 1, 04109 Leipzig", "1.4 km from home"]);
	const odd = placeEmbed(placeFrom({ ...hit, extratags: { opening_hours: "Jan-Mar 09:00-17:00", website: "javascript:alert(1)" } }));
	assert.deepEqual((odd as { lines: string[] }).lines, ["Brühl 1, 04109 Leipzig", "Hours: Jan-Mar 09:00-17:00"]);
	assert.deepEqual((odd as { links: Array<{ label: string }> }).links.map((link) => link.label), ["Directions"], "only web links");
});

test("place search asks Nominatim near home, as its rules ask", async () => {
	const asked: Array<{ url: URL; agent: string }> = [];
	const search = new PlaceSearch({
		home: async () => ({ lat: 51.34, lon: 12.37 }),
		spacingMs: 0,
		fetch: async (input, init) => {
			asked.push({ url: new URL(String(input)), agent: String((init?.headers as Record<string, string>)["User-Agent"]) });
			return new Response(JSON.stringify([{ lat: "51.36", lon: "12.39", name: "Saturnstraße", category: "highway", type: "residential" }, hit]), { headers: { "Content-Type": "application/json" } });
		},
	});
	const found = await search.find("Saturn Leipzig Brühl");
	assert.deepEqual(found.map((place) => place.name), ["Saturn"], "a street of the same name is left out");
	assert.equal(asked[0].url.searchParams.get("q"), "Saturn Leipzig Brühl");
	assert.equal(asked[0].url.searchParams.get("extratags"), "1");
	assert.equal(asked[0].url.searchParams.get("viewbox"), "11.9700,51.5900,12.7700,51.0900");
	assert.match(asked[0].agent, /^RemindMe\//);
});

test("feed items carry their pictures: media:content (the size nearest 600), enclosures, a picture in the text", () => {
	const feed = (name: string) => parseFeed(readFileSync(new URL(`./fixtures/news/${name}.xml`, import.meta.url), "utf8")).items;
	assert.match(String(feed("guardian-world")[0].image), /^https:\/\/i\.guim\.co\.uk\/.*width=700/);
	assert.match(String(feed("spiegel-ausland")[0].image), /^https:\/\/cdn\.prod\.www\.spiegel\.de\/images\//);
	assert.match(String(feed("tagesschau-inland")[0].image), /^https:\/\/images\.tagesschau\.de\/image\//);
	assert.equal(feed("dw-de")[0].image, undefined);
	const video = parseFeed(`<rss><channel><item><title>A</title><link>https://a.example/1</link><media:content url="https://a.example/v.mp4" medium="video"/></item></channel></rss>`).items[0];
	assert.equal(video.image, undefined);
});

test("a Geizhals page's picture and a web page's preview tags", () => {
	const page = `<html><head><title>Sony WH-1000XM5 Black ab € 199,99 | Geizhals</title><meta property="og:image" content="https://gzhls.at/pix/xm5.webp?ogircp"></head><body><div id="offer-index-0"><span class="gh_price">€ 199,99</span> price: '199.99', merchant: 'expert TechnoMarkt',</div></body></html>`;
	assert.equal(geizhalsOffers(page)?.image, "https://gzhls.at/pix/xm5.webp?ogircp");
	assert.deepEqual(
		pagePreview(`<head><meta property="og:site_name" content="Home Assistant"><meta content="/images/art.webp" property="og:image"><meta name="description" content="Three mmWave sensors &amp; more"></head>`, "https://www.home-assistant.io/blog/x/"),
		{ image: "https://www.home-assistant.io/images/art.webp", site: "Home Assistant", description: "Three mmWave sensors & more" },
	);
	assert.deepEqual(pagePreview(`<meta property="og:image" content="javascript:alert(1)">`, "https://a.example/"), {});
});

test("the picture proxy fetches only what RemindMe signed, only pictures, and keeps them", async () => {
	const fetched: string[] = [];
	const answers: Record<string, { type: string; body: string; status?: number }> = {
		"https://gzhls.at/xm5.webp": { type: "image/webp", body: "WEBP" },
		"https://evil.example/x.svg": { type: "image/svg+xml", body: "<svg onload=alert(1)>" },
		"https://tile.openstreetmap.org/16/35021/21840.png": { type: "image/png", body: "PNG" },
	};
	const media = new MediaProxy({
		dir: mkdtempSync(join(tmpdir(), "rm-media-")),
		userAgent: "test",
		key: Buffer.alloc(32, 7),
		publicUrl: async (url) => new URL(url),
		fetch: async (input, init) => {
			fetched.push(`${String(input)} ${(init?.headers as Record<string, string>)["User-Agent"]}`);
			const answer = answers[String(input)];
			return new Response(answer?.body || "", { status: answer ? answer.status || 200 : 404, headers: { "Content-Type": answer?.type || "text/html" } });
		},
	});
	const link = media.link("https://gzhls.at/xm5.webp");
	const query = new URLSearchParams(link.split("?")[1]);
	assert.equal(query.get("u"), "https://gzhls.at/xm5.webp");
	const first = await media.get(query.get("u")!, query.get("s")!);
	assert.deepEqual([first.type, first.body.toString()], ["image/webp", "WEBP"]);
	await media.get(query.get("u")!, query.get("s")!);
	assert.equal(fetched.length, 1, "the second time from the cache");
	await assert.rejects(() => media.get("https://gzhls.at/other.webp", query.get("s")!), /forbidden/);
	await assert.rejects(() => media.get("https://gzhls.at/xm5.webp", "x"), /forbidden/);
	const svg = new URLSearchParams(media.link("https://evil.example/x.svg").split("?")[1]);
	await assert.rejects(() => media.get(svg.get("u")!, svg.get("s")!), /not a picture/);
	assert.equal(media.link("javascript:alert(1)"), "");
	const tile = await media.tile(16, 35021, 21840);
	assert.equal(tile.body.toString(), "PNG");
	assert.match(fetched.at(-1)!, /RemindMe\/4/, "OpenStreetMap is told who's asking");
	await assert.rejects(() => media.tile(16, -1, 3), /forbidden/);
	await assert.rejects(() => media.tile(25, 1, 1), /forbidden/);
});

test("a thread keeps a message's cards, even a message that is only cards", async () => {
	const { ThreadStore } = await import("../src/assistant/threads.ts");
	const store = new ThreadStore(join(mkdtempSync(join(tmpdir(), "rm-threads-")), "threads.json"));
	const thread = store.create({ title: "Headphones", origin: "console" });
	store.append(thread.id, { role: "assistant", text: "Cheapest at expert.", embeds: [offers] });
	store.append(thread.id, { role: "assistant", text: "", embeds: [article] });
	assert.deepEqual(store.get(thread.id)?.messages.map((message) => message.embeds?.[0]?.kind), ["offers", "article"]);
});
