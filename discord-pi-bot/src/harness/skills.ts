import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A skill is a named block of instructions injected into the system prompt
 * when enabled — a house style, a room glossary, a habit you want honoured on
 * every turn. Deliberately not a tool: skills change how the model behaves,
 * they do not give it new capabilities.
 *
 * They cost context on every request, which matters on a small window, so the
 * store tracks an explicit enabled flag rather than sending everything.
 */
export interface Skill {
	id: string;
	name: string;
	instructions: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Guard against one skill swallowing the whole context window. */
export const MAX_SKILL_LENGTH = 2000;

function isMissing(error: unknown): boolean {
	return (
		Boolean(error) &&
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

export class SkillStore {
	private skills: Skill[] = [];
	constructor(
		private readonly path = process.env.SKILL_DATA_PATH || "./data/skills.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.skills = Array.isArray(parsed) ? (parsed as Skill[]) : [];
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load skills:", error);
			this.skills = [];
		}
	}

	/** Write via a temp file and rename so a crash cannot truncate the store. */
	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(this.skills, null, 2), "utf8");
		await rename(temporary, this.path);
	}

	list(): Skill[] {
		return this.skills;
	}

	/** Only enabled skills reach the prompt. */
	enabled(): Skill[] {
		return this.skills.filter((skill) => skill.enabled);
	}

	async create(values: Partial<Skill>): Promise<Skill> {
		const now = new Date().toISOString();
		const skill: Skill = {
			id: randomUUID(),
			name: String(values.name || "Untitled skill").slice(0, 80),
			instructions: String(values.instructions || "").slice(0, MAX_SKILL_LENGTH),
			enabled: values.enabled !== false,
			createdAt: now,
			updatedAt: now,
		};
		this.skills.unshift(skill);
		await this.persist();
		return skill;
	}

	async update(id: string, values: Partial<Skill>): Promise<Skill | undefined> {
		const skill = this.skills.find((entry) => entry.id === id);
		if (!skill) return undefined;
		if (typeof values.name === "string") skill.name = values.name.slice(0, 80);
		if (typeof values.instructions === "string")
			skill.instructions = values.instructions.slice(0, MAX_SKILL_LENGTH);
		if (typeof values.enabled === "boolean") skill.enabled = values.enabled;
		skill.updatedAt = new Date().toISOString();
		await this.persist();
		return skill;
	}

	async delete(id: string): Promise<boolean> {
		const before = this.skills.length;
		this.skills = this.skills.filter((entry) => entry.id !== id);
		if (this.skills.length === before) return false;
		await this.persist();
		return true;
	}
}

/**
 * Render enabled skills as a system-prompt section. Returns an empty string
 * when nothing is enabled so the base prompt is left untouched.
 */
export function skillPrompt(skills: Skill[]): string {
	const usable = skills.filter((skill) => skill.instructions.trim());
	if (!usable.length) return "";
	return `\n\nActive skills — follow these for every reply:\n${usable
		.map((skill) => `- ${skill.name}: ${skill.instructions.trim()}`)
		.join("\n")}`;
}
