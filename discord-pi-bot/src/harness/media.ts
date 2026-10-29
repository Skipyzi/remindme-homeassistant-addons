import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPublicUrl } from "./reader";

/**
 * Pictures on cards and map tiles, fetched by RemindMe and kept on disk, so
 * the phone never asks a shop or news site itself. Only addresses RemindMe
 * signed when it handed the card out are fetched: the proxy can't be used
 * to reach anything else, and a page can't slip a tracking pixel in.
 */

const MAX_BYTES = 6_000_000;
const KEEP_BYTES = 200_000_000;
const WEEK = 7 * 86_400_000;
const TILE_AGENT = "RemindMe/4 (Home Assistant app; personal assistant)";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface Media {
	type: string;
	body: Buffer;
}

export class MediaProxy {
	private key?: Buffer;
	private writes = 0;

	constructor(private readonly options: { dir: string; userAgent: string; fetch?: FetchLike; publicUrl?: (url: string) => Promise<URL>; key?: Buffer }) {
		this.key = options.key;
	}

	private secret(): Buffer {
		return (this.key ||= this.loadKey());
	}

	/** One key for the app's life on this Pi, so links in open pages keep working after a restart. */
	private loadKey(): Buffer {
		const file = join(this.options.dir, ".key");
		try {
			// Read once; a missing file makes a new key.
			const saved = readFileSync(file);
			if (saved.length === 32) return saved;
		} catch {
			// No key yet.
		}
		const fresh = randomBytes(32);
		void mkdir(this.options.dir, { recursive: true, mode: 0o700 }).then(() => writeFile(file, fresh, { mode: 0o600 })).catch(() => undefined);
		return fresh;
	}

	private sign(url: string): string {
		return createHmac("sha256", this.secret()).update(url).digest("base64url").slice(0, 32);
	}

	/** The console's address for a picture. */
	link(url: string): string {
		if (!/^https?:\/\//i.test(url)) return "";
		return `./api/media?u=${encodeURIComponent(url)}&s=${this.sign(url)}`;
	}

	private async cached(name: string, maxAge: number): Promise<Media | undefined> {
		try {
			const file = join(this.options.dir, name);
			const info = await stat(file);
			if (Date.now() - info.mtimeMs > maxAge) return undefined;
			const [body, type] = await Promise.all([readFile(file), readFile(`${file}.type`, "utf8")]);
			return { type, body };
		} catch {
			return undefined;
		}
	}

	private async keep(name: string, media: Media): Promise<void> {
		await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
		const file = join(this.options.dir, name);
		await writeFile(file, media.body);
		await writeFile(`${file}.type`, media.type);
		if (++this.writes % 40 === 0) await this.prune().catch(() => undefined);
	}

	/** Oldest out first, until the folder is under 200 MB. */
	async prune(): Promise<void> {
		const names = (await readdir(this.options.dir)).filter((name) => !name.startsWith(".") && !name.endsWith(".type"));
		const files = await Promise.all(names.map(async (name) => ({ name, ...(await stat(join(this.options.dir, name))) })));
		let total = files.reduce((sum, file) => sum + file.size, 0);
		for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
			if (total <= KEEP_BYTES) break;
			await rm(join(this.options.dir, file.name), { force: true });
			await rm(join(this.options.dir, `${file.name}.type`), { force: true });
			total -= file.size;
		}
	}

	/** Fetch an image, following redirects only to public addresses. */
	private async fetchImage(url: string, userAgent: string): Promise<Media> {
		const check = this.options.publicUrl || assertPublicUrl;
		let current = await check(url);
		for (let hop = 0; hop <= 4; hop++) {
			const response = await (this.options.fetch || fetch)(current, { redirect: "manual", headers: { "User-Agent": userAgent, Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" }, signal: AbortSignal.timeout(15_000) });
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				current = await check(new URL(location, current).toString());
				continue;
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
			// Pictures only, and no SVG: it can carry script.
			if (!/^image\/(png|jpe?g|webp|gif|avif)$/.test(type)) throw new Error("not a picture");
			if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("too large");
			const body = Buffer.from(await response.arrayBuffer());
			if (body.length > MAX_BYTES) throw new Error("too large");
			return { type, body };
		}
		throw new Error("too many redirects");
	}

	/** A picture RemindMe handed out: checked against its signature, then from the cache or the web. */
	async get(url: string, signature: string): Promise<Media> {
		const expected = Buffer.from(this.sign(url));
		const given = Buffer.from(signature);
		if (!url || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error("forbidden");
		const name = createHash("sha256").update(url).digest("hex").slice(0, 40);
		const hit = await this.cached(name, WEEK * 4);
		if (hit) return hit;
		const media = await this.fetchImage(url, this.options.userAgent);
		await this.keep(name, media).catch(() => undefined);
		return media;
	}

	/** An OpenStreetMap tile, kept a week as OSM's tile policy asks. */
	async tile(z: number, x: number, y: number): Promise<Media> {
		const size = 2 ** z;
		if (![z, x, y].every(Number.isInteger) || z < 3 || z > 19 || x < 0 || y < 0 || x >= size || y >= size) throw new Error("forbidden");
		const name = `tile-${z}-${x}-${y}`;
		const hit = await this.cached(name, WEEK);
		if (hit) return hit;
		const media = await this.fetchImage(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, TILE_AGENT);
		await this.keep(name, media).catch(() => undefined);
		return media;
	}
}
