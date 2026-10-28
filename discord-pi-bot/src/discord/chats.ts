import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PriorTurn } from "../ai/types";

interface Chat {
	turns: PriorTurn[];
	updatedAt: number;
}

/* A chat that has been quiet this long starts fresh: yesterday's lamp talk
 * shouldn't steer today's questions. */
const IDLE_RESET_MS = 6 * 60 * 60_000;
const MAX_TURNS = 40;

/**
 * The running conversation in each Discord DM, so "and the other one too"
 * means something. Messages the assistant sends first (the brief, nudges)
 * are part of it, so a reply to them has context. Saved to /data so a
 * restart doesn't forget the thread.
 */
export class DiscordChats {
	private chats = new Map<string, Chat>();
	private saving = Promise.resolve();

	constructor(private readonly path = process.env.DISCORD_CHAT_PATH || "./data/discord-chats.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Chat>;
			for (const [id, chat] of Object.entries(saved))
				if (Array.isArray(chat?.turns)) this.chats.set(id, { turns: chat.turns, updatedAt: Number(chat.updatedAt) || 0 });
		} catch {
			// No saved chats yet.
		}
	}

	history(channelId: string, now = Date.now()): PriorTurn[] {
		const chat = this.chats.get(channelId);
		if (!chat || now - chat.updatedAt > IDLE_RESET_MS) return [];
		return [...chat.turns];
	}

	append(channelId: string, turns: PriorTurn[], now = Date.now()): void {
		const kept = this.history(channelId, now);
		kept.push(...turns.filter((turn) => turn.text.trim()));
		this.chats.set(channelId, { turns: kept.slice(-MAX_TURNS), updatedAt: now });
		this.save();
	}

	reset(channelId: string): void {
		this.chats.delete(channelId);
		this.save();
	}

	private save(): void {
		const snapshot = JSON.stringify(Object.fromEntries(this.chats));
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(`${this.path}.tmp`, snapshot);
				await rename(`${this.path}.tmp`, this.path);
			})
			.catch((error) => console.warn("Could not save Discord chats:", error instanceof Error ? error.message : error));
	}
}

/** Split a reply into Discord-sized messages, preferring line breaks. */
export function splitMessage(text: string, limit = 1900): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks.length ? chunks : ["(empty reply)"];
}
