import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type PriceWatch, PriceWatches, type SearchResult, geizhalsBlocked, geizhalsOffers, matches, parseEuro, parseShopPrice, searchResults } from "../src/assistant/prices.ts";

// The first three offers of a real Geizhals product page (Sony WH-1000XM5, October 2026).
const PAGE = readFileSync(new URL("./fixtures/geizhals-offers.html", import.meta.url), "utf8");
const PRODUCT = "https://geizhals.de/sony-wh-1000xm5-schwarz-a2733874.html";

test("prices in German and plain notation", () => {
	assert.equal(parseEuro("€ 1.299,00"), 1299);
	assert.equal(parseEuro("199,99 €"), 199.99);
	assert.equal(parseEuro("ab € 89,90"), 89.9);
	assert.equal(parseEuro("199.99"), 199.99);
	assert.equal(parseEuro("180"), 180);
	assert.equal(parseEuro("nicht lieferbar"), undefined);
	assert.equal(parseEuro(undefined), undefined);
});

test("a Geizhals product page gives its name and offers, cheapest first", () => {
	const page = geizhalsOffers(PAGE);
	assert.equal(page?.name, "Sony WH-1000XM5 Black");
	assert.deepEqual(page?.offers, [
		{ price: 199.99, shop: "expert TechnoMarkt", delivery: "sofort versandfertig, free shipping" },
		{ price: 204.99, shop: "collect2bletcg", delivery: "Lieferzeit 2-4 Werktage, free shipping" },
		{ price: 210.1, shop: "Netto Marken-Discount", delivery: "2 Werktage, shipping 5,95\u00a0€" },
	]);
});

test("Geizhals' connection check isn't read as a page without offers", () => {
	const check = "<html><title>Sichere Verbindung wird überprüft</title><body>Bitte warten</body></html>";
	assert.equal(geizhalsBlocked(check), true);
	assert.equal(geizhalsBlocked("<html><title>Nur einen Moment…</title></html>"), true);
	assert.equal(geizhalsBlocked(PAGE), false);
	assert.equal(geizhalsOffers(check), undefined);
});

test("search results keep only Geizhals product pages", () => {
	assert.deepEqual(
		searchResults([
			{ name: "Sony WH-1000XM5 Black", url: PRODUCT, priceText: "ab € 199,99" },
			{ name: "Sony WH-1000XM5 Silver", url: "https://geizhals.de/sony-wh-1000xm5-silber-a2733875.html", priceText: "" },
			{ name: "Kategorie Kopfhörer", url: "https://geizhals.de/?cat=sphaudio" },
			{ name: "", url: PRODUCT },
		]),
		[
			{ name: "Sony WH-1000XM5 Black", url: PRODUCT, price: 199.99 },
			{ name: "Sony WH-1000XM5 Silver", url: "https://geizhals.de/sony-wh-1000xm5-silber-a2733875.html" },
		],
	);
});

test("a comparison skips matches no shop sells any more", async () => {
	const discontinued = { name: "Sony WH-1000X M4 (old)", url: "https://geizhals.de/sony-wh-1000xm4-a2300000.html" };
	const watches = new PriceWatches({
		path: join(mkdtempSync(join(tmpdir(), "rm-prices-")), "prices.json"),
		geizhalsPage: async (url) => (url === PRODUCT ? PAGE : "<title>Old</title>"),
		search: async () => [discontinued, { name: "Sony WH-1000XM5 Black", url: PRODUCT, price: 199.99 }],
		shopPrice: async () => undefined,
		notify: async () => {},
	});
	const found = await watches.compare("Sony WH-1000X");
	assert.equal(found?.name, "Sony WH-1000XM5 Black");
	assert.equal(found?.offers.length, 3);
	assert.deepEqual(found?.others, [discontinued]);
});

test("a search match has at least half the words asked for", () => {
	assert.equal(matches("Sony WH-1000XM5", "Sony WH-1000XM5 Black"), true);
	assert.equal(matches("sony wh1000xm5", "Sony WH-1000XM5 Black"), true);
	assert.equal(matches("Sony Kopfhörer XM5", "Sony WH-1000XM5 Black"), true);
	assert.equal(matches("Philips Hue White Ambiance E27", "Philips HUE White and Color Ambiance Smart LED A60 E27 1100 8.1W"), true);
	assert.equal(matches("Bosch PSR 12", "Bosch DIY PSR 12-2 Akku-Bohrschrauber inkl. Koffer + 2 Akkus 1.5Ah"), true);
	assert.equal(matches("zzqx nonsense product 9000", "Nax Power Products 1000S Benzin-Rasenmäher"), false);
	assert.equal(matches("", "Anything"), false);
});

test("between matches on sale, the one closest to the words asked for wins", async () => {
	const results = [
		{ name: "Philips HUE White and Color Ambiance Smart LED A60 E27 1100 8.1W", url: "https://geizhals.de/philips-hue-white-and-color-ambiance-a3636679.html", price: 49.37 },
		{ name: "Philips HUE White Ambiance Smart LED A60 E27 1600 11.8W", url: "https://geizhals.de/philips-hue-white-ambiance-a3636712.html", price: 44.22 },
		{ name: "Philips HUE White Ambiance Filament E27", url: "https://geizhals.de/philips-hue-filament-a2608246.html" },
	];
	const watches = new PriceWatches({
		path: join(mkdtempSync(join(tmpdir(), "rm-prices-")), "prices.json"),
		geizhalsPage: async () => PAGE,
		search: async () => results,
		shopPrice: async () => undefined,
		notify: async () => {},
	});
	assert.equal((await watches.compare("Philips Hue White Ambiance E27"))?.url, results[1].url);
	assert.equal((await watches.compare("Hue White and Color E27"))?.url, results[0].url);
	// Equals: Geizhals' order.
	assert.equal((await watches.compare("Philips Hue E27"))?.url, results[0].url);
});

test("the cheap model's answer about a shop page is checked", () => {
	assert.deepEqual(parseShopPrice('{"price": 249.0, "name": "Bosch PSB 18 LI-2"}'), { price: 249, name: "Bosch PSB 18 LI-2" });
	assert.deepEqual(parseShopPrice('```json\n{"price": "1.049,95 €"}\n```'), { price: 1049.95 });
	assert.equal(parseShopPrice('{"price": null}'), undefined);
	assert.equal(parseShopPrice('{"price": 0}'), undefined);
	assert.equal(parseShopPrice("I couldn't find a price"), undefined);
	assert.equal(parseShopPrice(undefined), undefined);
});

/** Geizhals with a price the test sets; every notice the user would get. */
function setup(options: { quietUntil?: (at: Date) => Date } = {}) {
	const page = { cheapest: 199.99 };
	const told: string[] = [];
	const searched: string[] = [];
	const results: SearchResult[] = [{ name: "Sony WH-1000XM5 Black", url: PRODUCT, price: 199.99 }];
	const watches = new PriceWatches({
		path: join(mkdtempSync(join(tmpdir(), "rm-prices-")), "prices.json"),
		geizhalsPage: async () => PAGE.replace("price: '199.99'", `price: '${page.cheapest.toFixed(2)}'`),
		search: async (query) => {
			searched.push(query);
			return /xm5/i.test(query) ? results : [];
		},
		shopPrice: async () => ({ price: 89.9, name: "Shop name" }),
		notify: async (_watch: PriceWatch, text: string) => void told.push(text),
		...options,
	});
	return { watches, page, told, searched };
}
const hours = (count: number, from = new Date("2026-10-28T10:00:00Z")) => new Date(from.getTime() + count * 3_600_000);

test("watching a product by name finds it on Geizhals and notes its price without a notice", async () => {
	const { watches, told, searched } = setup();
	const watch = await watches.add({ query: "Sony WH-1000XM5", target: 180 }, hours(0));
	assert.deepEqual(searched, ["Sony WH-1000XM5"]);
	assert.equal(watch.name, "Sony WH-1000XM5 Black");
	assert.equal(watch.source, "geizhals");
	assert.equal(watch.price, 199.99);
	assert.equal(watch.shop, "expert TechnoMarkt");
	assert.equal(watch.target, 180);
	assert.deepEqual(told, []);
	await assert.rejects(() => watches.add({ query: "Zzz nothing" }), /Geizhals has nothing for "Zzz nothing"/);
	// The same link again only changes the target.
	const again = await watches.add({ url: PRODUCT, target: 175 });
	assert.equal(again.id, watch.id);
	assert.equal(watches.list().length, 1);
	assert.equal(watches.get(watch.id)?.target, 175);
});

test("with a target, one notice when it falls under it, another only when it's lower still or after going back up", async () => {
	const { watches, page, told } = setup();
	const watch = await watches.add({ url: PRODUCT, target: 180 }, hours(0));
	page.cheapest = 185;
	await watches.check(watch, hours(6));
	assert.deepEqual(told, []);
	page.cheapest = 179;
	await watches.check(watch, hours(12));
	assert.equal(told.length, 1);
	assert.match(told[0], /Sony WH-1000XM5 Black is 179,00\s€ at expert TechnoMarkt \(was 185,00\s€\), under your 180,00\s€/);
	await watches.check(watch, hours(18));
	assert.equal(told.length, 1, "the same price again isn't news");
	page.cheapest = 175;
	await watches.check(watch, hours(24));
	assert.equal(told.length, 2);
	assert.match(told[1], /The lowest since RemindMe started watching/);
	page.cheapest = 190;
	await watches.check(watch, hours(30));
	page.cheapest = 178;
	await watches.check(watch, hours(36));
	assert.equal(told.length, 3, "back under the target after going above it is news again");
});

test("without a target, a drop of 5 % or more is news, small wobbles aren't", async () => {
	const { watches, page, told } = setup();
	const watch = await watches.add({ url: PRODUCT }, hours(0));
	page.cheapest = 194;
	await watches.check(watch, hours(6));
	assert.deepEqual(told, [], "3 % less isn't worth a notice");
	page.cheapest = 189;
	await watches.check(watch, hours(12));
	assert.equal(told.length, 1);
	assert.match(told[0], /dropped to 189,00\s€/);
	// Taking a target away keeps watching for drops from the price now.
	await watches.setTarget(watch.id, 170);
	await watches.setTarget(watch.id, undefined);
	page.cheapest = 188;
	await watches.check(watch, hours(18));
	page.cheapest = 179;
	await watches.check(watch, hours(24));
	assert.equal(told.length, 1, "4.8 % under 188 € isn't enough");
	page.cheapest = 178;
	await watches.check(watch, hours(30));
	assert.equal(told.length, 2);
	assert.match(told[1], /dropped to 178,00\s€/);
});

test("history keeps changes and a point every 12 hours; the lowest price is remembered", async () => {
	const { watches, page } = setup();
	const watch = await watches.add({ url: PRODUCT }, hours(0));
	await watches.check(watch, hours(6));
	assert.equal(watch.history.length, 1, "unchanged within 12 hours: no new point");
	await watches.check(watch, hours(13));
	assert.equal(watch.history.length, 2);
	page.cheapest = 189.5;
	await watches.check(watch, hours(14));
	page.cheapest = 202;
	await watches.check(watch, hours(15));
	assert.deepEqual(
		watch.history.map((point) => point.price),
		[199.99, 199.99, 189.5, 202],
	);
	assert.equal(watch.lowest?.price, 189.5);
});

test("a failed check keeps the last price and says why", async () => {
	const { watches } = setup();
	const watch = await watches.add({ url: PRODUCT }, hours(0));
	(watches as unknown as { deps: { geizhalsPage: () => Promise<string> } }).deps.geizhalsPage = async () => "<title>Sichere Verbindung wird überprüft</title>";
	await watches.check(watch, hours(6));
	assert.equal(watch.price, 199.99);
	assert.equal(watch.error, "Geizhals showed no offers.");
	// A product nobody sells any more isn't watched.
	await assert.rejects(() => watches.add({ query: "Sony WH-1000XM5 Silver", url: "https://geizhals.de/sony-wh-1000xm5-silber-a2733875.html" }), /Geizhals lists no shop selling Sony WH-1000XM5 Silver right now/);
	assert.equal(watches.list().length, 1);
});

test("a shop page is read by the cheap model and takes the name it found; one without a price isn't kept", async () => {
	const { watches } = setup();
	const watch = await watches.add({ url: "https://www.bauhaus.info/akkuschrauber/bosch/p/12345" });
	assert.equal(watch.source, "shop");
	assert.equal(watch.price, 89.9);
	assert.equal(watch.name, "Shop name");
	(watches as unknown as { deps: { shopPrice: () => Promise<undefined> } }).deps.shopPrice = async () => undefined;
	await assert.rejects(() => watches.add({ url: "https://www.bauhaus.info/p/404" }), /No price could be read there: No price found on the page\. Try the product's name/);
	assert.equal(watches.list().length, 1);
});

test("a link RemindMe mustn't open is refused before anything is saved", async () => {
	const { watches } = setup();
	(watches as unknown as { deps: { checkUrl: (url: string) => Promise<void> } }).deps.checkUrl = async (url) => {
		if (url.includes("192.168.")) throw new Error("That address is not a public one.");
	};
	await assert.rejects(() => watches.add({ url: "http://192.168.178.49:3030/x" }), /not a public one/);
	assert.equal(watches.list().length, 0);
});

test("checks run every six hours, not in quiet hours, and survive a restart", async () => {
	let quiet = false;
	const { watches, page, told } = setup({ quietUntil: (at) => (quiet ? hours(8, at) : at) });
	const watch = await watches.add({ url: PRODUCT, target: 190 }, hours(0));
	page.cheapest = 185;
	await watches.tick(hours(3));
	assert.deepEqual(told, [], "not due yet");
	quiet = true;
	await watches.tick(hours(7));
	assert.deepEqual(told, [], "quiet hours");
	quiet = false;
	await watches.tick(hours(7));
	assert.equal(told.length, 1);
	const path = (watches as unknown as { path: string }).path;
	const again = new PriceWatches({ path, geizhalsPage: async () => PAGE, search: async () => [], shopPrice: async () => undefined, notify: async () => {} });
	await again.load();
	assert.equal(again.get(watch.id)?.price, 185);
	assert.equal(again.get(watch.id)?.told, 185);
	assert.equal((await again.remove(watch.id))?.id, watch.id);
	assert.equal(again.list().length, 0);
});
