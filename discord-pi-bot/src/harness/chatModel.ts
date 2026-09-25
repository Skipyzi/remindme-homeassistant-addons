import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Which local model the console chats with. The llama.cpp add-on serves
 * several models at once and answers unnamed requests with its default — the
 * model other apps (a dictation cleanup client, scripts) rely on. The console
 * names its own model instead, so choosing a chat model never changes what
 * anything else gets. Empty means "the add-on's default".
 */
export class ChatModelStore {
	private id = "";
	constructor(
		private readonly path = process.env.CHAT_MODEL_DATA_PATH || "./data/chat-model.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.id = typeof parsed?.id === "string" ? parsed.id : "";
		} catch {
			this.id = "";
		}
	}

	get(): string {
		return this.id;
	}

	async set(id: string): Promise<void> {
		this.id = String(id || "").trim();
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify({ id: this.id }, null, 2), "utf8");
		await rename(temporary, this.path);
	}
}
