import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type FeedItem, parseFeed, sameLink } from "../assistant/news";
import type { ConnectorStore, StoredConnector } from "./store";

/**
 * Feeds as connectors: any RSS or Atom feed, added under Settings →
 * Connectors (a blog, a newsroom, a YouTube channel, a project's releases).
 * Each one can go into the daily news, tell the user about new posts
 * (checked every half hour outside quiet hours, no AI), and be read by the
 * assistant when asked.
 */
export const FEED_KIND = {
	id: "feed",
	label: "Feed",
	description:
		"Any RSS or Atom feed: a blog, a newsroom, a YouTube channel, a project's releases. RemindMe can put it in the daily news, tell you about new posts, and read it when you ask.",
	presets: [{ id: "rss", label: "RSS or Atom feed" }],
};

export interface FeedStatus {
	ok: boolean;
	at: string;
	error?: string;
	/** Posts in the feed now, and when the newest came out. */
	posts?: number;
	newest?: string;
}

interface FeedState {
	/** Links already seen (or told), newest last. */
	seen: string[];
	status?: FeedStatus;
	/** When it was last looked at for new posts. */
	checkedAt?: string;
}

export interface FeedInput {
	url?: string;
	name?: string;
	/** In the daily news digest. */
	news?: boolean;
	/** A notice for each check that finds new posts. */
	alerts?: boolean;
	/** Only new posts with one of these, comma-separated: "Zigbee, Matter". */
	words?: string;
	enabled?: boolean;
}

export interface FeedDeps {
	store: ConnectorStore;
	/** A feed's XML. */
	fetchFeed(url: string): Promise<string>;
	/** Throws for a link RemindMe mustn't open (a private address). */
	checkUrl?(url: string): Promise<unknown>;
	/** Tell the user about a feed's new posts, newest first. */
	notify(feed: StoredConnector, posts: FeedItem[]): Promise<boolean>;
	/** A time moved out of the quiet hours. */
	quietUntil?(at: Date): Date;
	path?: string;
	/** Minutes between looks at a feed with alerts on. */
	everyMinutes?: number;
}

const MAX_SEEN = 400;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const feedFlag = (connector: StoredConnector, key: "news" | "alerts") => connector.values[key] === "on";
const flag = (value: boolean | undefined, fallback: string) => (value === undefined ? fallback : value ? "on" : "off");

/** A web page's own feed, as its head names it: `<link rel="alternate" type="application/rss+xml" href="…">`. */
export function feedLinkIn(html: string, base: string): string | undefined {
	for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
		if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
		const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
		if (!href) continue;
		try {
			return new URL(href.replace(/&amp;/g, "&"), base).toString();
		} catch {
			// A broken link: try the next one.
		}
	}
	return undefined;
}

/** The words a post must have, if any were given. */
export function wanted(post: FeedItem, words: string | undefined): boolean {
	const asked = String(words || "")
		.split(",")
		.map((word) => word.trim().toLowerCase())
		.filter(Boolean);
	if (!asked.length) return true;
	const text = `${post.title} ${post.summary}`.toLowerCase();
	return asked.some((word) => text.includes(word));
}

export class FeedWatch {
	private state: Record<string, FeedState> = {};
	private running = false;
	private cache = new Map<string, { at: number; posts: FeedItem[] }>();

	constructor(private readonly deps: FeedDeps) {}

	private get path(): string {
		return this.deps.path || process.env.FEEDS_DATA_PATH || "./data/feeds.json";
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Record<string, FeedState>;
			this.state = saved && typeof saved === "object" ? saved : {};
		} catch {
			this.state = {};
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.state));
		await rename(`${this.path}.tmp`, this.path);
	}

	list(): StoredConnector[] {
		return this.deps.store.list("feed");
	}

	status(id: string): FeedStatus | undefined {
		return this.state[id]?.status;
	}

	/** A feed's posts now, newest first; read at most every five minutes. */
	async posts(feed: StoredConnector, now = new Date()): Promise<FeedItem[]> {
		const url = feed.values.url;
		const cached = this.cache.get(url);
		if (cached && now.getTime() - cached.at < 5 * 60_000) return cached.posts;
		const state = (this.state[feed.id] ||= { seen: [] });
		try {
			const posts = parseFeed(await this.deps.fetchFeed(url)).items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
			state.status = { ok: true, at: now.toISOString(), posts: posts.length, ...(posts[0]?.at ? { newest: new Date(posts[0].at).toISOString() } : {}) };
			this.cache.set(url, { at: now.getTime(), posts });
			return posts;
		} catch (error) {
			state.status = { ok: false, at: now.toISOString(), error: message(error) };
			throw error;
		}
	}

	/**
	 * Add a feed by its link, or by a site's address when the site names its
	 * feed: checked to be one, named after it, its posts so far counted as seen.
	 */
	async add(input: FeedInput, now = new Date()): Promise<StoredConnector> {
		let url = String(input.url || "").trim();
		if (!/^https?:\/\//i.test(url)) throw new Error("That isn't a link to a feed.");
		if (this.list().length >= 40) throw new Error("Forty feeds at most. Remove one first.");
		const read = async (link: string) => {
			await this.deps.checkUrl?.(link);
			try {
				return await this.deps.fetchFeed(link);
			} catch (error) {
				throw new Error(`That address didn't answer: ${message(error)}`);
			}
		};
		let body = await read(url);
		let feed = parseFeed(body);
		const named = feed.items.length ? undefined : feedLinkIn(body, url);
		if (named) {
			url = named;
			body = await read(url);
			feed = parseFeed(body);
		}
		if (!feed.items.length && (named || /<(rss|feed|rdf:RDF)\b/i.test(body))) throw new Error(`${named ? `The site's feed (${url})` : "That feed"} has no posts yet.`);
		if (!feed.items.length) throw new Error("No posts at that address. Is it an RSS or Atom feed? A site's feed is often at /feed, /rss or /atom.xml.");
		if (this.list().some((existing) => existing.values.url === url)) throw new Error("That feed is connected already.");
		const name = (input.name?.trim() || feed.title || new URL(url).hostname).slice(0, 80);
		const saved = await this.deps.store.create({
			kind: "feed",
			preset: "rss",
			name,
			enabled: true,
			values: { url, news: flag(input.news, "off"), alerts: flag(input.alerts, "on"), words: String(input.words || "").slice(0, 200) },
			secrets: {},
		});
		const newest = feed.items.reduce((latest, item) => Math.max(latest, item.at ?? 0), 0);
		this.state[saved.id] = {
			seen: feed.items.map((item) => sameLink(item.link)).reverse().slice(-MAX_SEEN),
			checkedAt: now.toISOString(),
			status: { ok: true, at: now.toISOString(), posts: feed.items.length, ...(newest ? { newest: new Date(newest).toISOString() } : {}) },
		};
		await this.save();
		return saved;
	}

	async update(id: string, input: FeedInput, now = new Date()): Promise<StoredConnector | undefined> {
		const feed = this.list().find((entry) => entry.id === id);
		if (!feed) return undefined;
		const alertsBefore = feedFlag(feed, "alerts") && feed.enabled;
		const values: Record<string, string> = {};
		if (input.news !== undefined) values.news = flag(input.news, "off");
		if (input.alerts !== undefined) values.alerts = flag(input.alerts, "off");
		if (input.words !== undefined) values.words = String(input.words).slice(0, 200);
		const saved = await this.deps.store.update(id, { ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), values });
		// Alerts back on: what came while they were off isn't news.
		if (saved && !alertsBefore && feedFlag(saved, "alerts") && saved.enabled) await this.check(saved, now, { quiet: true }).catch(() => undefined);
		return saved;
	}

	async remove(id: string): Promise<boolean> {
		delete this.state[id];
		await this.save();
		return this.deps.store.remove(id);
	}

	/** Look at a feed: new posts are told (unless `quiet`) and then remembered as seen. */
	async check(feed: StoredConnector, now = new Date(), options: { quiet?: boolean } = {}): Promise<FeedItem[]> {
		const state = (this.state[feed.id] ||= { seen: [] });
		state.checkedAt = now.toISOString();
		let fresh: FeedItem[] = [];
		try {
			const posts = await this.posts(feed, now);
			const seen = new Set(state.seen);
			fresh = posts.filter((post) => !seen.has(sameLink(post.link)));
			state.seen = [...state.seen, ...fresh.map((post) => sameLink(post.link)).reverse()].slice(-MAX_SEEN);
			fresh = fresh.filter((post) => wanted(post, feed.values.words));
			if (fresh.length && !options.quiet) await this.deps.notify(feed, fresh);
		} catch {
			// The status says what went wrong; the next look tries again.
		}
		await this.save();
		return options.quiet ? [] : fresh;
	}

	/** Every feed with alerts on, each every half hour, never in quiet hours. */
	async tick(now = new Date()): Promise<void> {
		if (this.running) return;
		if (this.deps.quietUntil && this.deps.quietUntil(now).getTime() > now.getTime()) return;
		this.running = true;
		try {
			const every = (this.deps.everyMinutes ?? 30) * 60_000;
			for (const feed of this.list()) {
				if (!feed.enabled || !feedFlag(feed, "alerts")) continue;
				const last = Date.parse(this.state[feed.id]?.checkedAt || "");
				if (Number.isFinite(last) && now.getTime() - last < every) continue;
				await this.check(feed, now);
			}
		} finally {
			this.running = false;
		}
	}

	/** The latest posts of one feed (by name or id) or of all, for the assistant. */
	async latest(which?: string, now = new Date()): Promise<{ posts: Array<FeedItem & { feed: string }>; problems: string[] }> {
		const wantedFeed = which?.trim().toLowerCase();
		const feeds = this.list().filter((feed) => feed.enabled && (!wantedFeed || feed.id === which || feed.name.toLowerCase().includes(wantedFeed)));
		const problems: string[] = [];
		const posts: Array<FeedItem & { feed: string }> = [];
		await Promise.all(
			feeds.map(async (feed) => {
				try {
					for (const post of (await this.posts(feed, now)).slice(0, 15)) posts.push({ ...post, feed: feed.name });
				} catch (error) {
					problems.push(`${feed.name} (${message(error)})`);
				}
			}),
		);
		await this.save();
		posts.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
		return { posts, problems };
	}

	startClock(): void {
		setTimeout(() => void this.tick(), 75_000).unref();
		setInterval(() => void this.tick(), 5 * 60_000).unref();
	}
}

/** A notice about new posts: one with its link, or a few in a list. */
export function newPostsText(feed: StoredConnector, posts: FeedItem[]): string {
	const link = (post: FeedItem) => `[${post.title}](${post.link.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
	if (posts.length === 1) return `📰 New on ${feed.name}: ${link(posts[0])}`;
	const shown = posts.slice(0, 5);
	const more = posts.length - shown.length;
	return `📰 ${posts.length} new on ${feed.name}:\n${shown.map((post) => `- ${link(post)}`).join("\n")}${more ? `\n- and ${more} more` : ""}`;
}
