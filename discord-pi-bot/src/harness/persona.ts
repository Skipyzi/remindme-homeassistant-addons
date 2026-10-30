import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The editable base of the system prompt — the model's voice and standing
 * rules. Only this part is user-editable; the harness always appends the
 * capability instructions (memory, tools, skills) on top, so editing the
 * persona can change how the model sounds but never strips its abilities.
 */
export const DEFAULT_NAME = "RemindMe";

/** The built-in instructions, under the assistant's name. */
export const defaultPersona = (name = DEFAULT_NAME) =>
	`You are ${name}, a concise general and home assistant. Answer directly. Use tools only when needed. Confirm sensitive home actions.`;
export const DEFAULT_PERSONA = defaultPersona();

/** Keep one edit from swallowing the whole context window. */
export const MAX_PERSONA_LENGTH = 2000;
const MAX_NAME_LENGTH = 24;

/** The assistant's cat: one of the six coats, and one of six accessories or none (6). */
export interface Look {
	coat: number;
	accessory: number;
}

function lookFrom(value: unknown): Look | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { coat, accessory } = value as Record<string, unknown>;
	if (!Number.isInteger(coat) || !Number.isInteger(accessory) || (coat as number) < 0 || (coat as number) > 5 || (accessory as number) < 0 || (accessory as number) > 6) return undefined;
	return { coat: coat as number, accessory: accessory as number };
}

/** A name to call it by: one line, no brackets or markup, at most 24 characters. */
function nameFrom(value: unknown): string {
	return String(value ?? "")
		.replace(/[\u0000-\u001f<>[\]{}`*_#|\\]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LENGTH)
		.trim();
}

function isMissing(error: unknown): boolean {
	return (
		Boolean(error) &&
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

/**
 * A single-value store for the editable persona, persisted to /data so an edit
 * survives restarts. An empty value means "use the default", so resetting is
 * just clearing the field.
 */
export class PersonaStore {
	private prompt = "";
	private name = "";
	private look?: Look;
	constructor(
		private readonly path = process.env.PERSONA_DATA_PATH || "./data/persona.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.prompt =
				parsed && typeof parsed.prompt === "string" ? parsed.prompt : "";
			this.name = nameFrom(parsed?.name);
			this.look = lookFrom(parsed?.look);
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load persona:", error);
			this.prompt = "";
		}
	}

	/** The prompt to show and edit: the stored one, or the default under the assistant's name. */
	get(): string {
		return this.prompt.trim() || defaultPersona(this.assistantName());
	}

	/** What the model is given: the instructions, and its name when they were written for another. */
	forModel(): string {
		const name = this.assistantName();
		return this.isCustom() && name !== DEFAULT_NAME ? `${this.get()}\n\nYour name is ${name}.` : this.get();
	}

	/** What the user calls it: "Remi", or RemindMe. */
	assistantName(): string {
		return this.name || DEFAULT_NAME;
	}

	lookOf(): Look | undefined {
		return this.look;
	}

	/** The cat the console and notifications draw for it: the chosen look, or RemindMe's own. */
	catSeed(): string {
		return this.look ? `look:${this.look.coat}-${this.look.accessory}` : "remindme";
	}

	/** A new name or cat; an empty name goes back to RemindMe. */
	async setIdentity(change: { name?: unknown; look?: unknown }): Promise<void> {
		if (change.name !== undefined) this.name = nameFrom(change.name);
		if (change.look !== undefined) this.look = change.look === null ? undefined : lookFrom(change.look) || this.look;
		await this.persist();
	}

	/** Whether a custom persona is in effect, for the UI to show a reset. */
	isCustom(): boolean {
		return Boolean(this.prompt.trim());
	}

	/** Set the persona; an empty or whitespace value resets to the default. */
	async set(prompt: string): Promise<void> {
		this.prompt = String(prompt || "")
			.slice(0, MAX_PERSONA_LENGTH)
			.trimEnd();
		// The default saved unchanged stays the default, so a new name still reaches it.
		if (this.prompt.trim() === defaultPersona(this.assistantName())) this.prompt = "";
		await this.persist();
	}

	/** Write via a temp file and rename so a crash cannot truncate the store. */
	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify({ prompt: this.prompt, ...(this.name ? { name: this.name } : {}), ...(this.look ? { look: this.look } : {}) }, null, 2), "utf8");
		await rename(temporary, this.path);
	}
}
