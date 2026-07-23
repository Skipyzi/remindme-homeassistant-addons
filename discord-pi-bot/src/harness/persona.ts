import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The editable base of the system prompt — the model's voice and standing
 * rules. Only this part is user-editable; the harness always appends the
 * capability instructions (memory, tools, skills) on top, so editing the
 * persona can change how the model sounds but never strips its abilities.
 */
export const DEFAULT_PERSONA =
	"You are RemindMe, a concise general and home assistant. Answer directly. Use tools only when needed. Confirm sensitive home actions.";

/** Keep one edit from swallowing the whole context window. */
export const MAX_PERSONA_LENGTH = 2000;

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
	constructor(
		private readonly path = process.env.PERSONA_DATA_PATH || "./data/persona.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.prompt =
				parsed && typeof parsed.prompt === "string" ? parsed.prompt : "";
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load persona:", error);
			this.prompt = "";
		}
	}

	/** The prompt to use — the stored one, or the default when none is set. */
	get(): string {
		return this.prompt.trim() || DEFAULT_PERSONA;
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
		await this.persist();
	}

	/** Write via a temp file and rename so a crash cannot truncate the store. */
	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify({ prompt: this.prompt }, null, 2), "utf8");
		await rename(temporary, this.path);
	}
}
