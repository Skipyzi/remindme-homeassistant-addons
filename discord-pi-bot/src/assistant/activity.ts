import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Embed } from "./embeds";

/**
 * What a ledger row is: the assistant answered, changed something, sent a
 * message first, failed, or is waiting for a tap (and how that ended).
 */
export type ActivityKind = "answered" | "did" | "sent" | "failed" | "waiting" | "confirmed" | "cancelled";

/** Where it happened. */
export type ActivityChannel = "console" | "discord" | "task" | "brief" | "nudge" | "reminder" | "job" | "memory" | "news";

/** One changed thing: "Desk lamp: on at 40%", with the lamp's colour when it has one. */
export interface Receipt {
	text: string;
	color?: string;
}

/** A button under one of RemindMe's own messages, in its thread: what it does, and on what. */
export interface EntryAction {
	label: string;
	kind: "battery-remind" | "battery-hide" | "reminder-later" | "price-stop";
	/** The battery's entity id, the reminder's text, or the price watch's id. */
	ref: string;
}

export interface ActivityEntry {
	id: string;
	at: string;
	kind: ActivityKind;
	channel: ActivityChannel;
	text: string;
	/** For answers: what was asked. */
	question?: string;
	receipts?: Receipt[];
	/** For waiting rows: the confirmation token, until it is used. */
	token?: string;
	/** Buttons under it in the RemindMe thread. */
	actions?: EntryAction[];
	/** What a tap on one of them did; the buttons go then. */
	acted?: string;
	/** Cards under it in the RemindMe thread, such as the news digest's stories. */
	embeds?: Embed[];
}

const MAX_ENTRIES = 1_000;
const MAX_AGE_MS = 30 * 86_400_000;
const MAX_TEXT = 4_000;

/**
 * Everything RemindMe said, did and sent, for the console's ledger. Kept for
 * a month in /data; the newest thousand rows at most.
 */
export class ActivityLog {
	private entries: ActivityEntry[] = [];
	private saving = Promise.resolve();

	constructor(private readonly path = process.env.ACTIVITY_DATA_PATH || "./data/activity.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as ActivityEntry[];
			this.entries = Array.isArray(saved) ? saved.filter((entry) => entry && typeof entry.at === "string") : [];
		} catch {
			this.entries = [];
		}
	}

	add(entry: Omit<ActivityEntry, "id" | "at"> & { at?: Date }): ActivityEntry {
		const saved: ActivityEntry = {
			...entry,
			id: randomUUID(),
			at: (entry.at || new Date()).toISOString(),
			text: entry.text.slice(0, MAX_TEXT),
			...(entry.question ? { question: entry.question.slice(0, MAX_TEXT) } : {}),
		};
		this.entries.push(saved);
		this.trim();
		this.save();
		return saved;
	}

	get(id: string): ActivityEntry | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	/** A button was tapped: the entry says what came of it, and its buttons go. */
	acted(id: string, text: string): void {
		const entry = this.get(id);
		if (!entry) return;
		entry.acted = text;
		this.save();
	}

	/** The same done from elsewhere (the phone, the inbox card): entries with buttons on it say so too. */
	settle(ref: string, text: string): void {
		let changed = false;
		for (const entry of this.entries)
			if (!entry.acted && entry.actions?.some((action) => action.ref === ref)) {
				entry.acted = text;
				changed = true;
			}
		if (changed) this.save();
	}

	/** A waiting row's outcome: it turns into what happened, and its token is spent. */
	resolve(token: string, kind: "confirmed" | "cancelled" | "failed", text: string): void {
		const entry = this.entries.find((item) => item.token === token);
		if (!entry) return;
		entry.kind = kind;
		entry.text = text;
		delete entry.token;
		this.save();
	}

	/** Newest first, over the last `days` days. */
	recent(days = 7, now = new Date()): ActivityEntry[] {
		const since = now.getTime() - days * 86_400_000;
		return this.entries.filter((entry) => Date.parse(entry.at) >= since).sort((a, b) => b.at.localeCompare(a.at));
	}

	private trim(now = Date.now()): void {
		this.entries = this.entries.filter((entry) => now - Date.parse(entry.at) < MAX_AGE_MS).slice(-MAX_ENTRIES);
	}

	private save(): void {
		const snapshot = JSON.stringify(this.entries);
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(`${this.path}.tmp`, snapshot);
				await rename(`${this.path}.tmp`, this.path);
			})
			.catch((error) => console.warn("Could not save the activity log:", error instanceof Error ? error.message : error));
	}
}
