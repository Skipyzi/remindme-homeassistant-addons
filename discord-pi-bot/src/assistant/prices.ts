import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Price watches and comparisons. Geizhals compares German and Austrian shops
 * (idealo turns automated browsers away), and its product pages carry each
 * offer's price and shop in plain HTML, so a Geizhals watch is checked with
 * no AI at all. Any other shop page is read in the browser and its price
 * picked out by the cheapest model.
 */

export interface PriceOffer {
	price: number;
	shop: string;
	/** "sofort versandfertig, free shipping", as Geizhals says it. */
	delivery?: string;
}

export interface SearchResult {
	name: string;
	url: string;
	/** Geizhals' "from" price, when the result shows one. */
	price?: number;
}

export interface PricePoint {
	at: string;
	price: number;
	shop?: string;
}

export interface PriceWatch {
	id: string;
	name: string;
	url: string;
	source: "geizhals" | "shop";
	/** Tell the user once it's at or under this. */
	target?: number;
	createdAt: string;
	lastCheck?: string;
	price?: number;
	shop?: string;
	error?: string;
	lowest?: PricePoint;
	history: PricePoint[];
	/** The price last told to the user: only a lower one is news. */
	told?: number;
}

const MAX_HISTORY = 200;

export const isGeizhals = (url: string) => /^https:\/\/(www\.)?geizhals\.(de|at|eu)\/.+-a\d+\.html/i.test(url);

/** "€ 1.299,00", "199,99 €", "199.99" → 199.99. */
export function parseEuro(text: string | undefined): number | undefined {
	const match = String(text || "").replace(/\s/g, "").match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{2}))?/);
	if (!match) return undefined;
	const value = Number(`${match[1].replace(/\./g, "")}.${match[2] || "00"}`);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export const euro = (value: number | undefined) => (value === undefined ? "–" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value));

const decode = (text: string) =>
	text
		.replace(/\\u([0-9a-f]{4})/gi, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_all, dec) => String.fromCharCode(Number(dec)))
		.replace(/&euro;/g, "€")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\\(.)/g, "$1");

/** Geizhals' "checking your connection" page ("Nur einen Moment…"), which a real browser gets past after a few seconds. */
export const GEIZHALS_CHECKING = /Nur einen Moment|Sichere Verbindung wird überprüft|Just a moment|cf-challenge|captcha/i;

/** Geizhals showed its check page instead of the product. */
export const geizhalsBlocked = (html: string) => GEIZHALS_CHECKING.test(html) && !/id="offer-index-/.test(html);

const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** How soon and at what shipping cost: "sofort versandfertig, free shipping". */
function offerDelivery(part: string): string {
	let time = plain(/class="offer__delivery-time">([\s\S]*?)<\/div>/.exec(part)?.[1] || "");
	if (time.length > 60) time = `${time.slice(0, 60).replace(/[\s,;:-]+\S*$/, "")}…`;
	const payment = /class="offer__delivery-payment">([\s\S]*?)<\/div>/.exec(part)?.[1] || "";
	const cost = /GRATISVERSAND|versandkostenfrei/i.test(payment) ? "free shipping" : (() => {
		const amount = parseEuro(/(?:€|&euro;)\s*([\d.,]+)/.exec(payment)?.[1]);
		return amount ? `shipping ${euro(amount)}` : "";
	})();
	return [time, cost].filter(Boolean).join(", ");
}

const words = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 2);

/** Geizhals' search is loose ("zzqx product 9000" finds a lawnmower): a match has at least half the words asked for. */
export function matches(query: string, name: string): boolean {
	const asked = words(query);
	const joined = words(name).join("");
	return asked.length > 0 && asked.filter((word) => joined.includes(word)).length * 2 >= asked.length;
}

/** How closely a name fits: a point per word asked for, and one per two of them side by side ("white ambiance"). */
function closeness(query: string, name: string): number {
	const asked = words(query);
	const named = words(name);
	const joined = named.join("");
	const spaced = ` ${named.join(" ")} `;
	let points = asked.filter((word) => joined.includes(word)).length;
	for (let index = 0; index + 1 < asked.length; index++) if (spaced.includes(` ${asked[index]} ${asked[index + 1]} `)) points++;
	return points;
}

/**
 * The best match: the closest one that's on sale now (it has a "from"
 * price). Geizhals ranks by popularity, so between equals its first wins.
 */
function bestMatch(query: string, results: SearchResult[]): { best?: SearchResult; others: SearchResult[] } {
	const relevant = results.filter((result) => matches(query, result.name));
	const onSale = relevant.filter((result) => result.price !== undefined);
	let best: SearchResult | undefined;
	for (const result of onSale.length ? onSale : relevant) if (!best || closeness(query, result.name) > closeness(query, best.name)) best = result;
	return { best, others: relevant.filter((result) => result !== best) };
}

/** A Geizhals product page's offers, cheapest first, the product's name and its picture. */
export function geizhalsOffers(html: string): { name: string; offers: PriceOffer[]; image?: string } | undefined {
	if (geizhalsBlocked(html)) return undefined;
	const title = decode(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
	const name = title.replace(/\s+ab\s+€[\s\S]*$/i, "").replace(/\s*\|.*$/, "").trim();
	const offers: PriceOffer[] = [];
	for (const chunk of html.split(/id="offer-index-\d+"/).slice(1)) {
		const part = chunk.slice(0, 20_000);
		const price = Number(/price:\s*'(\d+(?:\.\d+)?)'/.exec(part)?.[1] ?? parseEuro(/class="gh_price">([^<]+)</.exec(part)?.[1]));
		const shop = decode(/merchant:\s*'((?:[^'\\]|\\.)*)'/.exec(part)?.[1] || "").trim();
		const delivery = offerDelivery(part);
		if (Number.isFinite(price) && price > 0 && shop) offers.push({ price, shop, ...(delivery ? { delivery } : {}) });
	}
	if (!offers.length) return undefined;
	offers.sort((a, b) => a.price - b.price);
	const image = decode(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html)?.[1] || "");
	return { name: name || "Product", offers, ...(/^https:\/\//.test(image) ? { image } : {}) };
}

/**
 * Runs in the browser on a Geizhals search page: each result's name, link
 * and "from" price. (Plain JavaScript; this project has no DOM types.)
 */
export const GEIZHALS_SEARCH = String.raw`(() => {
	const out = [];
	for (const item of document.querySelectorAll("article")) {
		const link = item.querySelector(".galleryview__name-link, .listview__name-link, h3 a[href]");
		if (!link || !/-a\d+\.html/.test(link.getAttribute("href") || "")) continue;
		const priceElement = item.querySelector(".galleryview__price, .listview__price, .gh_price, [class*=price]");
		out.push({ name: (link.getAttribute("title") || link.textContent || "").replace(/\s+/g, " ").trim(), url: link.href, priceText: priceElement ? priceElement.textContent.replace(/\s+/g, " ").trim() : "" });
		if (out.length >= 8) break;
	}
	return out;
})()`;

export function searchResults(raw: Array<{ name?: string; url?: string; priceText?: string }>): SearchResult[] {
	return raw
		.filter((entry) => entry.name && entry.url && isGeizhals(entry.url))
		.map((entry) => {
			const price = parseEuro(entry.priceText);
			return { name: entry.name!, url: entry.url!, ...(price ? { price } : {}) };
		});
}

/** The cheapest model's answer about a shop page, checked. */
export function parseShopPrice(answer: string | undefined): { price: number; name?: string } | undefined {
	if (!answer) return undefined;
	try {
		const data = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()) as { price?: unknown; name?: unknown };
		const price = typeof data.price === "number" ? data.price : parseEuro(String(data.price ?? ""));
		if (!price || price <= 0 || price > 100_000) return undefined;
		return { price: Math.round(price * 100) / 100, ...(typeof data.name === "string" && data.name.trim() ? { name: data.name.trim().slice(0, 120) } : {}) };
	} catch {
		return undefined;
	}
}

export interface PriceDeps {
	/** A Geizhals product page's HTML, with a browser when Geizhals asks for one. */
	geizhalsPage(url: string): Promise<string>;
	/** Geizhals' search, in the browser. */
	search(query: string): Promise<SearchResult[]>;
	/** Any shop page's price, read by the cheapest model. */
	shopPrice(url: string, name?: string): Promise<{ price: number; name?: string } | undefined>;
	/** Tell the user about a price drop. */
	notify(watch: PriceWatch, text: string): Promise<void>;
	/** Throws for a link RemindMe mustn't open (a private address). */
	checkUrl?(url: string): Promise<unknown>;
	/** A check time moved out of the quiet hours. */
	quietUntil?(at: Date): Date;
	path?: string;
	everyHours?: number;
}

/**
 * The user's price watches: each checked every few hours (six by default),
 * never in quiet hours, and only news is told: a price under the target, or,
 * without one, a drop of at least five percent since last told.
 */
export class PriceWatches {
	private watches: PriceWatch[] = [];
	private running = false;

	constructor(private readonly deps: PriceDeps) {}

	private get path(): string {
		return this.deps.path || process.env.PRICES_DATA_PATH || "./data/prices.json";
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as PriceWatch[];
			this.watches = Array.isArray(saved) ? saved.filter((watch) => watch && typeof watch.url === "string").map((watch) => ({ ...watch, history: watch.history || [] })) : [];
		} catch {
			this.watches = [];
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.watches));
		await rename(`${this.path}.tmp`, this.path);
	}

	list(): PriceWatch[] {
		return [...this.watches];
	}

	get(id: string): PriceWatch | undefined {
		return this.watches.find((watch) => watch.id === id);
	}

	/** Where a product is cheapest now, from Geizhals: the best match's offers, and the other matches. */
	async compare(query: string): Promise<{ name: string; url: string; offers: PriceOffer[]; others: SearchResult[]; image?: string; count: number } | undefined> {
		const { best, others } = bestMatch(query, await this.deps.search(query));
		if (!best) return undefined;
		const page = geizhalsOffers(await this.deps.geizhalsPage(best.url));
		return { name: page?.name || best.name, url: best.url, offers: page?.offers.slice(0, 6) || [], others: others.slice(0, 4), count: page?.offers.length || 0, ...(page?.image ? { image: page.image } : {}) };
	}

	/** Start watching a product (found on Geizhals) or a link, with its first price; a link whose price can't be read is refused. */
	async add(input: { query?: string; url?: string; target?: number }, now = new Date()): Promise<PriceWatch> {
		let url = input.url?.trim() || "";
		let name = "";
		if (!url) {
			const query = String(input.query || "").trim();
			const found = bestMatch(query, await this.deps.search(query)).best;
			if (!found) throw new Error(`Geizhals has nothing for "${input.query}". Try other words, or a link to the product.`);
			({ url, name } = found);
		}
		if (!/^https?:\/\//i.test(url)) throw new Error("That isn't a link to a product page.");
		await this.deps.checkUrl?.(url);
		const known = this.watches.find((watch) => watch.url === url);
		if (known) {
			if (input.target !== undefined) known.target = input.target;
			await this.save();
			return known;
		}
		const watch: PriceWatch = { id: randomUUID().slice(0, 8), name: name || input.query?.trim() || url, url, source: isGeizhals(url) ? "geizhals" : "shop", createdAt: now.toISOString(), history: [], ...(input.target ? { target: input.target } : {}) };
		this.watches.push(watch);
		await this.check(watch, now, { quiet: true });
		if (watch.price === undefined) {
			await this.remove(watch.id);
			if (watch.source === "geizhals") throw new Error(`Geizhals lists no shop selling ${watch.name === url ? "it" : watch.name} right now, so there's no price to watch.`);
			throw new Error(`No price could be read there: ${(watch.error || "nothing found").replace(/\.$/, "")}. Try the product's name instead, so RemindMe finds it on Geizhals.`);
		}
		return watch;
	}

	async remove(id: string): Promise<PriceWatch | undefined> {
		const watch = this.get(id);
		if (!watch) return undefined;
		this.watches = this.watches.filter((entry) => entry.id !== id);
		await this.save();
		return watch;
	}

	async setTarget(id: string, target: number | undefined): Promise<PriceWatch | undefined> {
		const watch = this.get(id);
		if (!watch) return undefined;
		if (target && target > 0) watch.target = target;
		else delete watch.target;
		delete watch.told;
		await this.save();
		return watch;
	}

	/** Look at one product now. `quiet`: just note the price (the first look). */
	async check(watch: PriceWatch, now = new Date(), options: { quiet?: boolean } = {}): Promise<PriceWatch> {
		watch.lastCheck = now.toISOString();
		try {
			let price: number;
			let shop: string | undefined;
			if (watch.source === "geizhals") {
				const page = geizhalsOffers(await this.deps.geizhalsPage(watch.url));
				if (!page) throw new Error("Geizhals showed no offers.");
				[{ price, shop }] = page.offers;
				if (watch.name === watch.url || !watch.name) watch.name = page.name;
			} else {
				const read = await this.deps.shopPrice(watch.url, watch.name === watch.url ? undefined : watch.name);
				if (!read) throw new Error("No price found on the page.");
				price = read.price;
				if (read.name && watch.name === watch.url) watch.name = read.name;
			}
			const before = watch.price;
			Object.assign(watch, { price, shop, error: undefined });
			const last = watch.history[watch.history.length - 1];
			if (!last || last.price !== price || now.getTime() - Date.parse(last.at) > 12 * 3_600_000) watch.history = [...watch.history, { at: now.toISOString(), price, ...(shop ? { shop } : {}) }].slice(-MAX_HISTORY);
			if (!watch.lowest || price < watch.lowest.price) watch.lowest = { at: now.toISOString(), price, ...(shop ? { shop } : {}) };
			const news = options.quiet ? undefined : this.news(watch, price, before);
			if (options.quiet) watch.told = price;
			if (news) {
				await this.deps.notify(watch, news);
				watch.told = price;
			}
		} catch (error) {
			watch.error = error instanceof Error ? error.message : String(error);
		}
		await this.save();
		return watch;
	}

	/** What's worth telling about a new price, if anything. */
	private news(watch: PriceWatch, price: number, before: number | undefined): string | undefined {
		const at = watch.shop ? ` at ${watch.shop}` : "";
		const was = before !== undefined && before !== price ? ` (was ${euro(before)})` : "";
		const lowest = watch.lowest && watch.history.length > 2 && price <= watch.lowest.price ? " The lowest since RemindMe started watching." : "";
		if (watch.target !== undefined) {
			if (price > watch.target) {
				// Back above the target: the next time under it is news again.
				delete watch.told;
				return undefined;
			}
			if (watch.told !== undefined && price >= watch.told - 0.009) return undefined;
			return `📉 ${watch.name} is ${euro(price)}${at}${was}, under your ${euro(watch.target)}.${lowest}`;
		}
		// No price told yet (the target was just taken away): this one is the baseline.
		if (watch.told === undefined) {
			watch.told = price;
			return undefined;
		}
		if (price > watch.told * 1.05) watch.told = price;
		if (price > watch.told * 0.95) return undefined;
		return `📉 ${watch.name} dropped to ${euro(price)}${at}${was}.${lowest}`;
	}

	/** Look at every watch that's due. */
	async tick(now = new Date()): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const every = (this.deps.everyHours ?? 6) * 3_600_000;
			if (this.deps.quietUntil && this.deps.quietUntil(now).getTime() > now.getTime()) return;
			for (const watch of this.watches) if (!watch.lastCheck || now.getTime() - Date.parse(watch.lastCheck) >= every) await this.check(watch, now);
		} finally {
			this.running = false;
		}
	}

	startClock(): void {
		setTimeout(() => void this.tick(), 60_000).unref();
		setInterval(() => void this.tick(), 15 * 60_000).unref();
	}
}
