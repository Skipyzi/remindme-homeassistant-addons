import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConversationMessage {
	id: string;
	role: string;
	text: string;
	createdAt: string;
	metadata?: Record<string, unknown>;
}
export interface Conversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	pinned: boolean;
	archived: boolean;
	messages: ConversationMessage[];
}

export const DEFAULT_CONVERSATION_TITLE = "New conversation";

/**
 * Derive a short label from the first thing the user said.
 *
 * Done deterministically rather than by asking the model: a title is worth
 * a few characters of string handling, not an extra inference pass on a Pi
 * that is already slow enough at the reply itself.
 */
export function deriveConversationTitle(text: string): string {
	const cleaned = String(text || "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return DEFAULT_CONVERSATION_TITLE;
	// Prefer a sentence; fall back to a word-boundary cut so titles never end
	// mid-word.
	const sentence = cleaned.split(/(?<=[.!?])\s/)[0] || cleaned;
	const candidate = sentence.length <= 60 ? sentence : cleaned;
	if (candidate.length <= 60)
		return candidate.charAt(0).toUpperCase() + candidate.slice(1);
	const clipped = candidate.slice(0, 60);
	const cut = clipped.lastIndexOf(" ");
	const trimmed = (cut > 24 ? clipped.slice(0, cut) : clipped).replace(
		/[\s,;:.-]+$/,
		"",
	);
	return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}…`;
}

export class ConversationStore {
	private conversations: Conversation[] = [];
	constructor(
		private readonly path = process.env.CONVERSATION_DATA_PATH ||
			"./data/conversations.json",
	) {}
	async load(): Promise<void> {
		try {
			this.conversations = JSON.parse(
				await readFile(this.path, "utf8"),
			) as Conversation[];
		} catch (error) {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "ENOENT"
				)
			)
				throw error;
		}
	}
	list(search = ""): Conversation[] {
		const query = search.trim().toLowerCase();
		return this.conversations
			.filter(
				(item) =>
					!query ||
					item.title.toLowerCase().includes(query) ||
					item.messages.some((message) =>
						message.text.toLowerCase().includes(query),
					),
			)
			.sort(
				(a, b) =>
					Number(b.pinned) - Number(a.pinned) ||
					b.updatedAt.localeCompare(a.updatedAt),
			);
	}
	get(id: string): Conversation | undefined {
		return this.conversations.find((item) => item.id === id);
	}
	async create(): Promise<Conversation> {
		const now = new Date().toISOString();
		const item: Conversation = {
			id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			title: DEFAULT_CONVERSATION_TITLE,
			createdAt: now,
			updatedAt: now,
			pinned: false,
			archived: false,
			messages: [],
		};
		this.conversations.unshift(item);
		await this.persist();
		return item;
	}
	async update(
		id: string,
		patch: Partial<
			Pick<Conversation, "title" | "pinned" | "archived" | "messages">
		>,
	): Promise<Conversation | undefined> {
		const item = this.get(id);
		if (!item) return undefined;
		if (typeof patch.title === "string" && patch.title.trim())
			item.title = patch.title.trim().slice(0, 120);
		if (typeof patch.pinned === "boolean") item.pinned = patch.pinned;
		if (typeof patch.archived === "boolean") item.archived = patch.archived;
		if (Array.isArray(patch.messages)) {
			item.messages = patch.messages;
			/*
			 * Name the conversation from the first user message, once. Only
			 * while the title is still the placeholder, so a title the user
			 * set by hand is never overwritten.
			 */
			if (item.title === DEFAULT_CONVERSATION_TITLE) {
				const firstUser = item.messages.find(
					(message) => message.role === "user" && message.text?.trim(),
				);
				if (firstUser) item.title = deriveConversationTitle(firstUser.text);
			}
		}
		item.updatedAt = new Date().toISOString();
		await this.persist();
		return item;
	}
	async delete(id: string): Promise<boolean> {
		const before = this.conversations.length;
		this.conversations = this.conversations.filter((item) => item.id !== id);
		if (this.conversations.length === before) return false;
		await this.persist();
		return true;
	}
	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(
			temporary,
			JSON.stringify(this.conversations, null, 2),
			"utf8",
		);
		await rename(temporary, this.path);
	}
}
