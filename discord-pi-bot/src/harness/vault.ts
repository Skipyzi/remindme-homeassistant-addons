import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/**
 * The vault is a folder of Markdown notes living at `/share/vault`, so this
 * add-on and the companion remindme-vault editor read the same real files (the
 * plain Obsidian-Markdown format keeps them portable, but the editor is
 * remindme-vault, not the Obsidian desktop app). The model treats it as an
 * editable, Hermes-style memory: notes it can read, link, tag, and rewrite. The
 * constellation view reads the same graph.
 *
 * Everything here is derived from the files on disk, never from a mirrored
 * index that could drift. A note is identified by its vault-relative path
 * (`projects/remindme.md`), so a note renamed in the vault editor is simply a
 * different note here — no hidden ids to keep in sync.
 *
 * Frontmatter is hand-parsed rather than pulling in a YAML dependency: the
 * fields a note actually carries — `title`, `type`, `tags`, `aliases` — are a
 * short, flat list, and the rest of this codebase deliberately avoids heavy
 * deps on a Pi.
 */

/* Words too common to say anything about which memory is relevant. Kept short
 * on purpose — recall leans on scoring, not an exhaustive stoplist. */
const RECALL_STOPWORDS = new Set([
	// Common short words appear in nearly every note body, so left in they make
	// recall match everything. The three-letter ones matter most.
	"the",
	"and",
	"for",
	"are",
	"but",
	"not",
	"was",
	"our",
	"out",
	"who",
	"get",
	"all",
	"can",
	"had",
	"has",
	"its",
	"did",
	"one",
	"new",
	"now",
	"use",
	"way",
	"may",
	"see",
	"let",
	"ask",
	"put",
	"yes",
	"this",
	"that",
	"with",
	"from",
	"have",
	"what",
	"when",
	"they",
	"them",
	"then",
	"your",
	"you're",
	"about",
	"there",
	"their",
	"would",
	"could",
	"should",
	"want",
	"need",
	"like",
	"just",
	"know",
	"tell",
	"give",
	"please",
	"thanks",
	"okay",
	"yeah",
	"does",
	"done",
	"here",
	"into",
	"over",
	"some",
	"than",
	"also",
	"much",
	"more",
	"most",
	"very",
	"still",
]);

export interface VaultNote {
	/** Vault-relative POSIX path, e.g. `projects/remindme.md`. The id. */
	path: string;
	title: string;
	/** Hermes-memory kind from frontmatter: user | feedback | project | reference. */
	type?: string;
	/** Raw frontmatter values, strings or string lists. */
	frontmatter: Record<string, string | string[]>;
	/** Frontmatter `tags:` plus inline `#tags`, deduped, without the leading `#`. */
	tags: string[];
	/** Paths of existing notes this note links to via `[[wikilink]]`. */
	links: string[];
	/** Wikilink targets that matched no note yet — the seeds of notes-to-write. */
	unresolvedLinks: string[];
	/** Other names this note answers to, for wikilink resolution. */
	aliases: string[];
	/** Markdown with the frontmatter block removed. */
	body: string;
	/** File mtime, ISO. */
	updatedAt: string;
}

export interface VaultGraphNode {
	id: string;
	title: string;
	type?: string;
	tags: string[];
	/** Total links in and out — how connected the note is, for sizing. */
	degree: number;
	kind: "note" | "tag";
}

export interface VaultGraphEdge {
	source: string;
	target: string;
	kind: "link" | "tag";
}

export interface VaultGraph {
	nodes: VaultGraphNode[];
	edges: VaultGraphEdge[];
}

export interface VaultRelated {
	/** Notes that link to this one. */
	backlinks: VaultNote[];
	/** Notes sharing at least one tag, most shared tags first. */
	byTag: VaultNote[];
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

/** POSIX-style path regardless of host, so ids are stable across Windows/Linux. */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/** Filename without directory or `.md`, lowercased — the wikilink lookup key. */
function baseName(path: string): string {
	const file = path.split("/").pop() || path;
	return file.replace(/\.md$/i, "").toLowerCase();
}

/**
 * Split a `---` frontmatter block off the top of a note.
 *
 * Only a leading block counts; a `---` further down is a horizontal rule and
 * is left in the body untouched.
 */
function splitFrontmatter(raw: string): {
	frontmatter: Record<string, string | string[]>;
	body: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { frontmatter: {}, body: raw };
	return { frontmatter: parseFrontmatter(match[1]), body: raw.slice(match[0].length) };
}

/**
 * Parse the flat subset of YAML notes actually use: `key: value`, inline
 * `key: [a, b]`, comma lists, and block lists of `- item` lines. Anything
 * nested is beyond what a memory note needs and is read as a plain string.
 */
function parseFrontmatter(text: string): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const lines = text.split(/\r?\n/);
	let key: string | undefined;
	let list: string[] | undefined;
	const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
	for (const line of lines) {
		if (!line.trim()) continue;
		const item = line.match(/^\s*-\s+(.*)$/);
		if (item && key && list) {
			list.push(unquote(item[1]));
			continue;
		}
		const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!pair) continue;
		// A block list opened on the previous key is finished by the next key.
		if (key && list) result[key] = list;
		key = pair[1];
		list = undefined;
		const value = pair[2].trim();
		if (!value) {
			// Either an empty scalar or the header of a block list; decided by
			// whether `- item` lines follow.
			list = [];
			continue;
		}
		const inline = value.match(/^\[(.*)\]$/);
		if (inline) {
			result[key] = inline[1]
				.split(",")
				.map(unquote)
				.filter(Boolean);
			key = undefined;
			continue;
		}
		if (value.includes(",")) {
			result[key] = value.split(",").map(unquote).filter(Boolean);
			key = undefined;
			continue;
		}
		result[key] = unquote(value);
		key = undefined;
	}
	if (key && list) result[key] = list;
	return result;
}

/** Serialise frontmatter back to the small YAML dialect we parse. */
function stringifyFrontmatter(
	frontmatter: Record<string, string | string[]>,
): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (!value.length) continue;
			lines.push(`${key}: [${value.join(", ")}]`);
		} else if (value != null && String(value).length) {
			lines.push(`${key}: ${value}`);
		}
	}
	return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

function asList(value: string | string[] | undefined): string[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

/**
 * Inline `#tags` from the body, minus fenced code and headings.
 *
 * Fenced blocks are dropped first so a `#include` in a code sample is not read
 * as a tag. A heading (`# Title`) has whitespace after the `#`; a tag does not,
 * which the lookbehind-free boundary check enforces.
 */
function inlineTags(body: string): string[] {
	const withoutCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
	const found = new Set<string>();
	const pattern = /(^|[^\w#])#([A-Za-z][\w/-]*)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(withoutCode))) found.add(match[2].toLowerCase());
	return [...found];
}

/** `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` → the target names. */
function wikilinkTargets(body: string): string[] {
	const withoutCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
	const targets = new Set<string>();
	const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(withoutCode))) {
		const name = match[1].trim();
		if (name) targets.add(name);
	}
	return [...targets];
}

function firstHeading(body: string): string | undefined {
	const match = body.match(/^#{1,6}\s+(.+?)\s*$/m);
	return match ? match[1].trim() : undefined;
}

export class VaultStore {
	private notes = new Map<string, VaultNote>();
	/**
	 * Every wikilink target a note wrote, before resolution. Kept apart from the
	 * note's resolved `links`/`unresolvedLinks` so reindexing is idempotent: a
	 * link that resolves this pass but dangles the next (its target deleted) is
	 * re-derived from here rather than from the last split, which had already
	 * dropped it.
	 */
	private rawLinks = new Map<string, string[]>();
	/** Lowercased basename or alias → note path, for resolving wikilinks. */
	private nameIndex = new Map<string, string>();
	private backlinks = new Map<string, Set<string>>();
	private byTag = new Map<string, Set<string>>();

	constructor(
		private readonly root = process.env.VAULT_DATA_PATH || "/share/vault",
	) {}

	/** Guard against a wikilink or a supplied path escaping the vault root. */
	private resolveInside(notePath: string): string {
		const clean = toPosix(notePath).replace(/^\/+/, "");
		const absolute = join(this.root, clean);
		const rel = relative(this.root, absolute);
		if (rel.startsWith("..") || rel === "") {
			throw new Error(`Path escapes the vault: ${notePath}`);
		}
		return absolute;
	}

	private async walk(directory: string): Promise<string[]> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		const files: string[] = [];
		for (const entry of entries) {
			// A dotfolder like `.obsidian` holds app config, never notes.
			if (entry.name.startsWith(".")) continue;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) files.push(...(await this.walk(full)));
			else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
		}
		return files;
	}

	private async parseFile(absolute: string): Promise<VaultNote> {
		const raw = await readFile(absolute, "utf8");
		const info = await stat(absolute);
		const path = toPosix(relative(this.root, absolute));
		const { frontmatter, body } = splitFrontmatter(raw);
		const tags = [
			...new Set([
				...asList(frontmatter.tags).map((tag) => tag.replace(/^#/, "").toLowerCase()),
				...inlineTags(body),
			]),
		];
		const type =
			typeof frontmatter.type === "string" ? frontmatter.type : undefined;
		const title =
			(typeof frontmatter.title === "string" && frontmatter.title) ||
			firstHeading(body) ||
			baseName(path);
		return {
			path,
			title,
			type,
			frontmatter,
			tags,
			links: [],
			unresolvedLinks: wikilinkTargets(body),
			aliases: asList(frontmatter.aliases),
			body,
			updatedAt: info.mtime.toISOString(),
		};
	}

	/**
	 * Read every note and rebuild the indexes. Two passes: parse all notes so
	 * every name is known, then resolve wikilinks against that name table —
	 * a note can link to one written after it in the scan.
	 */
	async load(): Promise<void> {
		this.notes.clear();
		this.rawLinks.clear();
		this.nameIndex.clear();
		this.backlinks.clear();
		this.byTag.clear();
		const files = await this.walk(this.root);
		const parsed = await Promise.all(files.map((file) => this.parseFile(file)));
		for (const note of parsed) {
			this.notes.set(note.path, note);
			this.rawLinks.set(note.path, note.unresolvedLinks);
		}
		this.reindex();
	}

	/** Rebuild name, tag, and link indexes from the current note set. */
	private reindex(): void {
		this.nameIndex.clear();
		this.backlinks.clear();
		this.byTag.clear();
		for (const note of this.notes.values()) {
			// Full relative path (minus .md) resolves an unambiguous link;
			// basename and aliases resolve the common short form. First writer
			// of a name wins, so a later collision does not silently retarget.
			for (const key of [
				baseName(note.path),
				note.path.replace(/\.md$/i, "").toLowerCase(),
				...note.aliases.map((alias) => alias.toLowerCase()),
			]) {
				if (!this.nameIndex.has(key)) this.nameIndex.set(key, note.path);
			}
		}
		for (const note of this.notes.values()) {
			const links: string[] = [];
			const unresolved: string[] = [];
			for (const target of this.rawLinks.get(note.path) || []) {
				const resolved = this.nameIndex.get(target.toLowerCase());
				if (resolved && resolved !== note.path) {
					links.push(resolved);
					if (!this.backlinks.has(resolved)) this.backlinks.set(resolved, new Set());
					this.backlinks.get(resolved)?.add(note.path);
				} else if (!resolved) {
					unresolved.push(target);
				}
			}
			note.links = [...new Set(links)];
			note.unresolvedLinks = unresolved;
			for (const tag of note.tags) {
				if (!this.byTag.has(tag)) this.byTag.set(tag, new Set());
				this.byTag.get(tag)?.add(note.path);
			}
		}
	}

	get(path: string): VaultNote | undefined {
		return this.notes.get(toPosix(path));
	}

	/** All tags with how many notes carry each, most-used first. */
	tags(): { tag: string; count: number }[] {
		return [...this.byTag.entries()]
			.map(([tag, paths]) => ({ tag, count: paths.size }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	}

	list(filter: { tag?: string; type?: string; search?: string } = {}): VaultNote[] {
		const tag = filter.tag?.replace(/^#/, "").toLowerCase();
		const type = filter.type?.toLowerCase();
		const query = filter.search?.trim().toLowerCase();
		return [...this.notes.values()]
			.filter((note) => {
				if (tag && !note.tags.includes(tag)) return false;
				if (type && note.type?.toLowerCase() !== type) return false;
				if (
					query &&
					!note.title.toLowerCase().includes(query) &&
					!note.body.toLowerCase().includes(query)
				)
					return false;
				return true;
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * Notes most relevant to a free-text prompt, for proactively surfacing
	 * long-term memory before the model asks. Each note is scored by how many
	 * of the prompt's salient words it mentions — a title or tag hit counts
	 * double, since those are what a note is *about* — so a passing remark can
	 * still pull back what was saved on the subject. Recency breaks ties. Unlike
	 * `list({search})`, which needs the whole phrase as one substring, this
	 * matches word by word, which is what makes it useful for recall.
	 */
	recall(prompt: string, limit = 5): VaultNote[] {
		const words = [
			...new Set(
				(prompt.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []).filter(
					(word) => !RECALL_STOPWORDS.has(word),
				),
			),
		];
		if (!words.length) return [];
		const scored: Array<{ note: VaultNote; score: number }> = [];
		for (const note of this.notes.values()) {
			const title = note.title.toLowerCase();
			const body = note.body.toLowerCase();
			const tags = note.tags.map((tag) => tag.toLowerCase());
			let score = 0;
			for (const word of words) {
				if (title.includes(word) || tags.some((tag) => tag.includes(word)))
					score += 2;
				else if (body.includes(word)) score += 1;
			}
			if (score > 0) scored.push({ note, score });
		}
		return scored
			.sort(
				(a, b) =>
					b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt),
			)
			.slice(0, limit)
			.map((entry) => entry.note);
	}

	/** Backlinks plus tag-neighbours — what the model should pull in as context. */
	related(path: string): VaultRelated {
		const note = this.get(path);
		if (!note) return { backlinks: [], byTag: [] };
		const backlinks = [...(this.backlinks.get(note.path) || [])]
			.map((linkPath) => this.notes.get(linkPath))
			.filter((entry): entry is VaultNote => Boolean(entry));
		const shared = new Map<string, number>();
		for (const tag of note.tags) {
			for (const other of this.byTag.get(tag) || []) {
				if (other === note.path) continue;
				shared.set(other, (shared.get(other) || 0) + 1);
			}
		}
		const byTag = [...shared.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([otherPath]) => this.notes.get(otherPath))
			.filter((entry): entry is VaultNote => Boolean(entry));
		return { backlinks, byTag };
	}

	/**
	 * Nodes and edges for the constellation view. Notes are always nodes and
	 * links are always edges; `includeTags` adds a node per tag with an edge to
	 * every note carrying it — Obsidian's "show tags in graph" — so tag
	 * clusters are visible without an O(n²) note-to-note tag mesh.
	 */
	graph(options: { includeTags?: boolean } = {}): VaultGraph {
		const nodes: VaultGraphNode[] = [];
		const edges: VaultGraphEdge[] = [];
		const degree = new Map<string, number>();
		const bump = (id: string) => degree.set(id, (degree.get(id) || 0) + 1);
		for (const note of this.notes.values()) {
			for (const target of note.links) {
				edges.push({ source: note.path, target, kind: "link" });
				bump(note.path);
				bump(target);
			}
			if (options.includeTags) {
				for (const tag of note.tags) {
					edges.push({ source: note.path, target: `#${tag}`, kind: "tag" });
					bump(note.path);
					bump(`#${tag}`);
				}
			}
		}
		for (const note of this.notes.values()) {
			nodes.push({
				id: note.path,
				title: note.title,
				type: note.type,
				tags: note.tags,
				degree: degree.get(note.path) || 0,
				kind: "note",
			});
		}
		if (options.includeTags) {
			for (const { tag } of this.tags()) {
				nodes.push({
					id: `#${tag}`,
					title: `#${tag}`,
					tags: [],
					degree: degree.get(`#${tag}`) || 0,
					kind: "tag",
				});
			}
		}
		return { nodes, edges };
	}

	/**
	 * Write a note and refresh the index. Frontmatter and body are stored as the
	 * `---` block the parser reads, so a note the model writes is a note the
	 * remindme-vault editor opens. Returns the reparsed note with links resolved.
	 */
	async write(
		path: string,
		values: {
			body?: string;
			frontmatter?: Record<string, string | string[]>;
		},
	): Promise<VaultNote> {
		let notePath = toPosix(path).replace(/^\/+/, "");
		if (!/\.md$/i.test(notePath)) notePath += ".md";
		const absolute = this.resolveInside(notePath);
		const existing = this.notes.get(notePath);
		const frontmatter = {
			...(existing?.frontmatter || {}),
			...(values.frontmatter || {}),
		};
		const body = values.body ?? existing?.body ?? "";
		const contents = stringifyFrontmatter(frontmatter) + body;
		await mkdir(dirname(absolute), { recursive: true });
		const temporary = `${absolute}.tmp`;
		await writeFile(temporary, contents, "utf8");
		await rename(temporary, absolute);
		const note = await this.parseFile(absolute);
		this.notes.set(note.path, note);
		this.rawLinks.set(note.path, note.unresolvedLinks);
		this.reindex();
		return this.notes.get(note.path) as VaultNote;
	}

	async delete(path: string): Promise<boolean> {
		const notePath = toPosix(path);
		if (!this.notes.has(notePath)) return false;
		await rm(this.resolveInside(notePath), { force: true });
		this.notes.delete(notePath);
		this.rawLinks.delete(notePath);
		this.reindex();
		return true;
	}
}
