import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reader mode: fetch a page server-side and hand back its readable text.
 *
 * The artifact frame is network-isolated on purpose, and most sites refuse
 * to be framed at all, so "open a link in the panel" cannot mean embedding
 * the live page. Instead the harness fetches it here, strips it to title and
 * prose, and the console renders that through the same DOM-building markdown
 * path as a reply — no iframe, no third-party script, no network reaching
 * into the sandbox.
 *
 * Fetching an arbitrary URL from the server is an SSRF risk: a clicked link
 * could point a request at the HA Supervisor, the llama.cpp box, or the
 * cloud metadata endpoint. So every hop — the original URL and each redirect
 * it follows — is resolved and checked, and anything landing on a private,
 * loopback, link-local or otherwise non-public address is refused.
 */

export class ReaderError extends Error {}

const MAX_BYTES = 2_000_000; // stop reading a page past ~2 MB
const MAX_TEXT = 40_000; // characters of readable text kept
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;

export interface ReaderResult {
	title: string;
	byline?: string;
	text: string;
	truncated: boolean;
	finalUrl: string;
}

/** An IPv4 literal that is a normal, routable public address. */
function ipv4IsPublic(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
		return false;
	const [a, b] = parts;
	if (a === 0 || a === 127) return false; // this-network, loopback
	if (a === 10) return false; // private
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false; // private
	if (a === 192 && b === 168) return false; // private
	if (a === 192 && b === 0) return false; // 192.0.0/24, 192.0.2/24 (test)
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if (a >= 224) return false; // multicast, reserved, broadcast
	return true;
}

/** An address literal — v4 or v6 — that a reader fetch is allowed to reach. */
export function ipIsPublic(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return ipv4IsPublic(ip);
	if (kind === 6) {
		const host = ip.toLowerCase();
		if (host === "::1" || host === "::") return false; // loopback, unspecified
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host); // IPv4-mapped
		if (mapped) return ipv4IsPublic(mapped[1]);
		if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // unique-local fc00::/7
		if (host.startsWith("fe80:")) return false; // link-local
		if (host.startsWith("ff")) return false; // multicast ff00::/8
		return true;
	}
	return false;
}

/**
 * Resolve the host and refuse anything that is not plain public http/https.
 * A literal IP is checked directly; a name is looked up and rejected if any
 * of its answers is a private address, which is what stops a public-looking
 * hostname from pointing the fetch at the LAN.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ReaderError("That is not a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ReaderError("Only http and https pages can be read.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) {
		if (!ipIsPublic(host)) throw new ReaderError("That address is not a public one.");
		return url;
	}
	let addresses: Array<{ address: string }>;
	try {
		addresses = await lookup(host, { all: true });
	} catch {
		throw new ReaderError("That host could not be resolved.");
	}
	if (!addresses.length || addresses.some((entry) => !ipIsPublic(entry.address)))
		throw new ReaderError("That host resolves to a non-public address.");
	return url;
}

/** Read a response body, giving up once it passes the byte cap. */
async function readCapped(response: Response, cap: number): Promise<string> {
	const stream = response.body;
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			chunks.push(Buffer.from(value));
			if (total > cap) {
				await reader.cancel().catch(() => {});
				break;
			}
		}
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Decode the handful of HTML entities that survive tag-stripping. */
function decodeEntities(input: string): string {
	return input
		.replace(/&#(\d+);/g, (_, dec) => codePoint(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(parseInt(hex, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&(?:#39|apos|rsquo|lsquo);/gi, "'")
		.replace(/&(?:ldquo);/gi, "“")
		.replace(/&(?:rdquo);/gi, "”")
		.replace(/&mdash;/gi, "—")
		.replace(/&ndash;/gi, "–")
		.replace(/&hellip;/gi, "…")
		.replace(/&amp;/gi, "&"); // last, so &amp;lt; does not become <
}

function codePoint(value: number): string {
	try {
		return Number.isFinite(value) ? String.fromCodePoint(value) : "";
	} catch {
		return "";
	}
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, " ");
}

/** The one same-tag block with the most text — the article amid the chrome. */
function pickLargest(html: string, tag: string): string | null {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
	let best: string | null = null;
	let bestLength = 0;
	for (const match of html.matchAll(re)) {
		const length = match[1].replace(/<[^>]+>/g, "").length;
		if (length > bestLength) {
			bestLength = length;
			best = match[1];
		}
	}
	return bestLength > 200 ? best : null;
}

/** Turn a page's HTML into a title and readable, lightly-structured text. */
export function extractReadable(html: string): {
	title: string;
	byline?: string;
	text: string;
} {
	const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
	let title = decodeEntities(stripTags(rawTitle)).replace(/\s+/g, " ").trim();
	if (!title) {
		const og =
			/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
		title = og ? decodeEntities(og[1]).trim() : "";
	}
	const author =
		/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];

	// Drop everything that is not article prose before looking for the body.
	const cleaned = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<head[\s\S]*?<\/head>/gi, " ")
		.replace(/<nav[\s\S]*?<\/nav>/gi, " ")
		.replace(/<header[\s\S]*?<\/header>/gi, " ")
		.replace(/<footer[\s\S]*?<\/footer>/gi, " ")
		.replace(/<aside[\s\S]*?<\/aside>/gi, " ")
		.replace(/<form[\s\S]*?<\/form>/gi, " ");

	const main = pickLargest(cleaned, "article") || pickLargest(cleaned, "main") || cleaned;

	const text = decodeEntities(
		stripTags(
			main
				.replace(/<h[12][^>]*>/gi, "\n\n## ")
				.replace(/<h[3-6][^>]*>/gi, "\n\n### ")
				.replace(/<\/h[1-6]>/gi, "\n\n")
				.replace(/<li[^>]*>/gi, "\n- ")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/(p|div|section|article|ul|ol|li|tr|blockquote)>/gi, "\n\n"),
		),
	)
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trimEnd())
		.join("\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { title: title || "Untitled", byline: author, text };
}

/** Fetch a URL, follow redirects with a fresh SSRF check on each, extract. */
export async function readablePage(rawUrl: string): Promise<ReaderResult> {
	let current = await assertPublicUrl(rawUrl);
	let response: Response | undefined;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const res = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: {
				"User-Agent": "RemindMe-Reader/1.0 (+home-assistant-add-on)",
				Accept: "text/html,application/xhtml+xml",
			},
		});
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			await res.arrayBuffer().catch(() => {}); // free the socket
			current = await assertPublicUrl(new URL(location, current).toString());
			continue;
		}
		response = res;
		break;
	}
	if (!response) throw new ReaderError("That link redirects too many times.");
	if (!response.ok) throw new ReaderError(`The page returned HTTP ${response.status}.`);
	const type = response.headers.get("content-type") || "";
	if (!/text\/html|application\/xhtml\+xml/i.test(type))
		throw new ReaderError("That link is not an HTML page.");
	const declared = Number(response.headers.get("content-length") || 0);
	if (declared && declared > MAX_BYTES)
		throw new ReaderError("That page is too large to read.");

	const html = await readCapped(response, MAX_BYTES);
	const extracted = extractReadable(html);
	if (!extracted.text) throw new ReaderError("No readable text was found on that page.");
	return {
		title: extracted.title,
		byline: extracted.byline,
		text: extracted.text.slice(0, MAX_TEXT),
		truncated: extracted.text.length > MAX_TEXT,
		finalUrl: current.toString(),
	};
}
