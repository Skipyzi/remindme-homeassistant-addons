import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PriorTurn } from "../ai/types";
import type { Receipt } from "./activity";

/**
 * Where a job stands. Queued jobs wait their turn; one that needs the user
 * has a question; done and stopped ones are finished until the user replies.
 */
/** "waiting": a watch between checks, asleep until wakeAt or a matching email. */
export type JobStatus = "queued" | "working" | "waiting" | "needs_you" | "done" | "stopped";

export interface JobState {
	status: JobStatus;
	/** Everything the job was told to do, as the assistant wrote it when starting it. */
	instructions: string;
	/** "4 of 6", when the job knows how far it is. */
	progress?: { done: number; total: number };
	/** One line on where it stands: "best so far 61 €". */
	note?: string;
	question?: { text: string; options: string[] };
	result?: string;
	/** How many times it has run; each run is a turn of up to ten tool rounds. */
	runs: number;
	error?: string;
	/** The user's message the job last took in, so it isn't read as new twice. */
	lastRead?: string;
	/** A watch: when it looks again, at the latest. */
	wakeAt?: string;
	/** A watch: a new email whose sender or subject has one of these wakes it early. */
	wakeWords?: string[];
	/** A watch ends on its own after this. */
	watchUntil?: string;
	/** Why this run started: "a new email from DHL: …", for the job's brief. */
	wokeBy?: string;
}

export interface ThreadMessage {
	id: string;
	at: string;
	/** A step is a job's own progress note: what it found or did. */
	role: "user" | "assistant" | "step";
	text: string;
	receipts?: Receipt[];
	/** Actions this message left waiting for the user's tap. */
	confirms?: Array<{ token: string; message: string; destructive?: boolean }>;
}

export interface Thread {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Where it started: the console, or a Discord DM that handed off a job. */
	origin: "console" | "discord";
	messages: ThreadMessage[];
	job?: JobState;
	/** Out of the inbox, still in History. */
	archivedAt?: string;
	/** Out of the inbox until then; it comes back on top. */
	snoozedUntil?: string;
	/** The model that answers here and runs its job, instead of the one chosen under AI. */
	model?: { provider: string; model: string };
}

/** A thread as a line in the inbox: no messages, just where it stands. */
export interface ThreadSummary extends Omit<Thread, "messages"> {
	last: string;
	count: number;
}

const MAX_THREADS = 200;
const MAX_MESSAGES = 300;
const MAX_TEXT = 12_000;

export function titleFrom(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (line.length <= 60) return line || "New conversation";
	const cut = line.lastIndexOf(" ", 57);
	return `${line.slice(0, cut > 30 ? cut : 57)}…`;
}

/**
 * The console's conversations: every request from the inbox is a thread of
 * its own, and a job lives in the thread that started it. Saved in /data.
 */
export class ThreadStore {
	private threads: Thread[] = [];
	private saving = Promise.resolve();
	/* Threads with a turn running right now, and who waits for them to go quiet. */
	private busy = new Map<string, Array<() => void>>();

	constructor(private readonly path = process.env.THREADS_DATA_PATH || "./data/threads.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Thread[];
			this.threads = Array.isArray(saved) ? saved.filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.messages)) : [];
		} catch {
			this.threads = [];
		}
	}

	/** Newest activity first. */
	list(): ThreadSummary[] {
		return [...this.threads]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map(({ messages, ...thread }) => {
				const said = [...messages].reverse().find((message) => message.role !== "user") || messages[messages.length - 1];
				return { ...thread, last: (said?.text || "").replace(/\s+/g, " ").trim().slice(0, 200), count: messages.length };
			});
	}

	get(id: string): Thread | undefined {
		return this.threads.find((thread) => thread.id === id);
	}

	/** A thread with a fixed id, made the first time it's needed: RemindMe's own. */
	ensure(id: string, title: string, now = new Date()): Thread {
		const found = this.get(id);
		if (found) return found;
		const thread: Thread = { id, title, origin: "console", createdAt: now.toISOString(), updatedAt: now.toISOString(), messages: [] };
		this.threads.push(thread);
		this.trim();
		this.save();
		return thread;
	}

	/** Archive or snooze; null takes it back. Doesn't count as news, so the thread keeps its place. */
	setState(id: string, patch: { archivedAt?: string | null; snoozedUntil?: string | null }): Thread | undefined {
		const thread = this.get(id);
		if (!thread) return undefined;
		for (const key of ["archivedAt", "snoozedUntil"] as const) {
			const value = patch[key];
			if (value === null) delete thread[key];
			else if (value !== undefined) thread[key] = value;
		}
		this.save();
		return thread;
	}

	/** Give a thread a model of its own, or (with none) back to the one chosen under AI. */
	setModel(id: string, model: Thread["model"] | undefined): Thread | undefined {
		const thread = this.get(id);
		if (!thread) return undefined;
		if (model) thread.model = { provider: model.provider, model: model.model };
		else delete thread.model;
		this.save();
		return thread;
	}

	create(values: { title: string; origin: Thread["origin"]; job?: JobState }, now = new Date()): Thread {
		const thread: Thread = { id: randomUUID().slice(0, 12), title: values.title, origin: values.origin, createdAt: now.toISOString(), updatedAt: now.toISOString(), messages: [], ...(values.job ? { job: values.job } : {}) };
		this.threads.push(thread);
		this.trim();
		this.save();
		return thread;
	}

	append(id: string, message: Omit<ThreadMessage, "id" | "at"> & { at?: Date }): ThreadMessage | undefined {
		const thread = this.get(id);
		const text = message.text.trim();
		if (!thread || (!text && !message.receipts?.length && !message.confirms?.length)) return undefined;
		const saved: ThreadMessage = {
			id: randomUUID().slice(0, 12),
			at: (message.at || new Date()).toISOString(),
			role: message.role,
			text: text.slice(0, MAX_TEXT),
			...(message.receipts?.length ? { receipts: message.receipts } : {}),
			...(message.confirms?.length ? { confirms: message.confirms } : {}),
		};
		thread.messages = [...thread.messages, saved].slice(-MAX_MESSAGES);
		thread.updatedAt = saved.at;
		this.save();
		return saved;
	}

	/** Change a job's state; `undefined` values clear a field. */
	updateJob(id: string, patch: Partial<JobState>, now = new Date()): JobState | undefined {
		const thread = this.get(id);
		if (!thread?.job) return undefined;
		const job: JobState = { ...thread.job };
		for (const [key, value] of Object.entries(patch) as Array<[keyof JobState, unknown]>) {
			if (value === undefined) delete job[key];
			else (job as unknown as Record<string, unknown>)[key] = value;
		}
		thread.job = job;
		thread.updatedAt = now.toISOString();
		this.save();
		return job;
	}

	/** Turn a conversation into a job: it keeps its messages and carries on in the background. */
	makeJob(id: string, title: string, instructions: string): Thread | undefined {
		const thread = this.get(id);
		if (!thread) return undefined;
		thread.title = title;
		thread.job = { status: "queued", instructions, runs: 0 };
		thread.updatedAt = new Date().toISOString();
		this.save();
		return thread;
	}

	remove(id: string): boolean {
		const before = this.threads.length;
		this.threads = this.threads.filter((thread) => thread.id !== id);
		if (before === this.threads.length) return false;
		this.save();
		return true;
	}

	/**
	 * The thread as the model's history: what the user said and what was
	 * answered, in turn. Steps are left out here; a job gets them as context.
	 */
	history(id: string): PriorTurn[] {
		const turns: PriorTurn[] = [];
		for (const message of this.get(id)?.messages || []) {
			if (message.role === "step") continue;
			const role = message.role;
			const last = turns[turns.length - 1];
			if (last?.role === role) last.text = `${last.text}\n\n${message.text}`;
			else turns.push({ role, text: message.text });
		}
		return turns;
	}

	/* A turn running in a thread: a job started from it waits until it is done. */
	setBusy(id: string, busy: boolean): void {
		if (busy) {
			if (!this.busy.has(id)) this.busy.set(id, []);
			return;
		}
		const waiting = this.busy.get(id) || [];
		this.busy.delete(id);
		for (const resolve of waiting) resolve();
	}

	idle(id: string): Promise<void> {
		const waiting = this.busy.get(id);
		if (!waiting) return Promise.resolve();
		return new Promise((resolve) => waiting.push(resolve));
	}

	/* The oldest finished threads go first; a job still going is kept. */
	private trim(): void {
		if (this.threads.length <= MAX_THREADS) return;
		const active = (thread: Thread) => thread.job && !["done", "stopped"].includes(thread.job.status);
		const removable = this.threads.filter((thread) => !active(thread)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		const drop = new Set(removable.slice(0, this.threads.length - MAX_THREADS).map((thread) => thread.id));
		this.threads = this.threads.filter((thread) => !drop.has(thread.id));
	}

	private save(): void {
		const snapshot = JSON.stringify(this.threads);
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(`${this.path}.tmp`, snapshot);
				await rename(`${this.path}.tmp`, this.path);
			})
			.catch((error) => console.warn("Could not save the threads:", error instanceof Error ? error.message : error));
	}

	/** Resolves once everything changed so far is on disk. */
	flushed(): Promise<void> {
		return this.saving;
	}
}
