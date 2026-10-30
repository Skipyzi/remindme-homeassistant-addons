import { MAX_IMPORTED_LENGTH, type SkillSource } from "./skills";

/*
 * skills.sh, the agent skills directory: its search API finds skills, its
 * pages say what each is for, and the skill itself is a SKILL.md in a GitHub
 * repository. RemindMe only uses the text; scripts that come with a skill
 * can't run here, and the console says so before adding one.
 */

type Fetch = typeof fetch;

/** skills.sh ids of skills on GitHub: owner/repo/skill. Others (a company's own host) are left out. */
const SKILL_ID = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/;
const USER_AGENT = "RemindMe/4 (Home Assistant app)";
const HOUR = 60 * 60 * 1000;

export interface FoundSkill {
	id: string;
	name: string;
	repo: string;
	installs: number;
	description?: string;
}

export interface SkillPreview {
	id: string;
	name: string;
	description: string;
	repo: string;
	path: string;
	url: string;
	license?: string;
	/** Characters of instructions. */
	size: number;
	/** It comes with scripts or code RemindMe can't run. */
	scripts: boolean;
	/** The instructions, without the SKILL.md header. */
	text: string;
}

export function parseSkillId(id: string): { repo: string; skill: string } | undefined {
	const match = SKILL_ID.exec(String(id || "").trim());
	return match ? { repo: `${match[1]}/${match[2]}`, skill: match[3] } : undefined;
}

/** A SKILL.md's YAML header (name, description, license) and the instructions after it. */
export function parseSkillMd(text: string): { name?: string; description?: string; license?: string; body: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { body: text.trim() };
	const fields: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[index]);
		if (!line) continue;
		let value = line[2].trim();
		if (/^[|>][+-]?$/.test(value)) {
			// A block: the indented lines that follow, joined (folded with > and kept with |).
			const block: string[] = [];
			while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index].trim());
			value = block.join(value.startsWith("|") ? "\n" : " ").trim();
		} else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"');
		fields[line[1].toLowerCase()] = value;
	}
	return {
		...(fields.name ? { name: fields.name } : {}),
		...(fields.description ? { description: fields.description.replace(/\s+/g, " ").trim() } : {}),
		...(fields.license ? { license: fields.license } : {}),
		body: text.slice(match[0].length).trim(),
	};
}

const CODE_FILE = /\.(py|js|mjs|cjs|ts|sh|bash|rb|go|ps1|php|pl)$/i;

/** Where a skill's SKILL.md is in its repository, and the code files beside it (relative to its folder). */
export function locateSkill(paths: string[], skill: string): { path: string; code: string[] } | undefined {
	const name = skill.toLowerCase();
	const candidates = paths.filter((path) => {
		const lower = path.toLowerCase();
		return lower === `${name}/skill.md` || lower.endsWith(`/${name}/skill.md`);
	});
	const usable = candidates.filter((path) => !/(^|\/)(node_modules|dist|build)\//.test(path));
	const path = (usable.length ? usable : candidates).sort((a, b) => a.length - b.length)[0] || (paths.includes("SKILL.md") ? "SKILL.md" : undefined);
	if (!path) return undefined;
	const folder = path.slice(0, -"SKILL.md".length);
	const files = paths.filter((entry) => entry.startsWith(folder) && entry !== path && (folder || entry.split("/").length <= 2));
	return { path, code: files.filter((file) => CODE_FILE.test(file)).map((file) => file.slice(folder.length)) };
}

/** The skill tells the AI to run code that comes with it: a repository's own tooling beside it doesn't count. */
export function needsScripts(body: string, code: string[]): boolean {
	return code.some((file) => body.includes(file) || body.includes(file.split("/").pop() as string));
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export class SkillsSh {
	private descriptions = new Map<string, { at: number; text?: string }>();
	private trees = new Map<string, { at: number; paths: string[] }>();

	constructor(private readonly fetchImpl: Fetch = fetch) {}

	private async get(url: string, accept = "*/*", timeoutMs = 8000): Promise<Response> {
		return this.fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
	}

	/** Skills on GitHub that match, most installed first as skills.sh ranks them, with what each is for. */
	async search(query: string): Promise<FoundSkill[]> {
		const words = String(query || "").trim().slice(0, 80);
		if (words.length < 2) return [];
		const response = await this.get(`https://skills.sh/api/search?${new URLSearchParams({ q: words, limit: "16" })}`, "application/json");
		if (!response.ok) throw new Error(`skills.sh answered HTTP ${response.status}.`);
		const body = (await response.json()) as { skills?: Array<{ id?: string; name?: string; installs?: number }> };
		const found = (body.skills || [])
			.map((entry) => ({ entry, id: parseSkillId(String(entry.id || "")) }))
			.filter((item) => item.id)
			.slice(0, 8)
			.map(({ entry, id }) => ({ id: String(entry.id), name: String(entry.name || id!.skill), repo: id!.repo, installs: Number(entry.installs) || 0 }));
		const described = await Promise.all(found.map((skill) => this.describe(skill.id).catch(() => undefined)));
		return found.map((skill, index) => ({ ...skill, ...(described[index] ? { description: described[index] } : {}) }));
	}

	/** What a skill is for, from its skills.sh page. */
	async describe(id: string): Promise<string | undefined> {
		const cached = this.descriptions.get(id);
		if (cached && Date.now() - cached.at < 24 * HOUR) return cached.text;
		const response = await this.get(`https://skills.sh/${id.split("/").map(encodeURIComponent).join("/")}`, "text/html", 6000);
		const html = response.ok ? await response.text() : "";
		const meta = /<meta name="description" content="([^"]*)"/.exec(html);
		const text = meta ? decodeEntities(meta[1]).trim() || undefined : undefined;
		this.descriptions.set(id, { at: Date.now(), text });
		if (this.descriptions.size > 500) this.descriptions.delete(this.descriptions.keys().next().value as string);
		return text;
	}

	private async tree(repo: string): Promise<string[] | undefined> {
		const cached = this.trees.get(repo);
		if (cached && Date.now() - cached.at < 6 * HOUR) return cached.paths;
		const response = await this.get(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, "application/vnd.github+json");
		if (response.status === 403 || response.status === 429) return undefined;
		if (!response.ok) throw new Error(response.status === 404 ? `${repo} isn't on GitHub any more.` : `GitHub answered HTTP ${response.status}.`);
		const body = (await response.json()) as { tree?: Array<{ path?: string; type?: string }> };
		const paths = (body.tree || []).filter((entry) => entry.type === "blob" && typeof entry.path === "string").map((entry) => entry.path as string);
		this.trees.set(repo, { at: Date.now(), paths });
		return paths;
	}

	private async raw(repo: string, path: string): Promise<string | undefined> {
		const response = await this.get(`https://raw.githubusercontent.com/${repo}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`, "text/plain");
		return response.ok ? response.text() : undefined;
	}

	/** The skill itself: its SKILL.md, read from GitHub. */
	async preview(id: string): Promise<SkillPreview> {
		const parsed = parseSkillId(id);
		if (!parsed) throw new Error("That isn't a skill on GitHub.");
		const paths = await this.tree(parsed.repo);
		let found: { path: string; code: string[] } | undefined = paths ? locateSkill(paths, parsed.skill) : undefined;
		let text: string | undefined;
		if (found) text = await this.raw(parsed.repo, found.path);
		else if (!paths) {
			// GitHub's hourly limit for lookups is used up: try where skills usually are.
			for (const path of [`skills/${parsed.skill}/SKILL.md`, `${parsed.skill}/SKILL.md`, "SKILL.md"]) {
				text = await this.raw(parsed.repo, path);
				if (text) {
					found = { path, code: [] };
					break;
				}
			}
		}
		if (!found || !text) throw new Error(`RemindMe couldn't find ${parsed.skill}'s SKILL.md in ${parsed.repo}.`);
		const skill = parseSkillMd(text);
		if (!skill.body) throw new Error("That skill has no instructions.");
		if (skill.body.length > MAX_IMPORTED_LENGTH) throw new Error(`That skill is ${Math.round(skill.body.length / 1000)} KB, more than RemindMe takes (${MAX_IMPORTED_LENGTH / 1000} KB).`);
		return {
			id,
			name: (skill.name || parsed.skill).slice(0, 80),
			description: skill.description || (await this.describe(id).catch(() => undefined)) || "",
			repo: parsed.repo,
			path: found.path,
			url: `https://github.com/${parsed.repo}/blob/HEAD/${found.path}`,
			...(skill.license ? { license: skill.license.slice(0, 40) } : {}),
			size: skill.body.length,
			scripts: needsScripts(skill.body, found.code),
			text: skill.body,
		};
	}
}

/** Where an imported skill came from, as the skill store keeps it. */
export function sourceOf(preview: SkillPreview, installs?: number): SkillSource {
	return { kind: "skills.sh", id: preview.id, repo: preview.repo, path: preview.path, url: preview.url, ...(installs ? { installs } : {}), ...(preview.scripts ? { scripts: true } : {}) };
}
