import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A T3 thread linked to a Discord thread. */
export interface T3Ref {
	threadId: string;
	link?: string | null;
	/** "plan": the first, plan-mode thread; "build": the one that builds an approved plan. */
	kind: "plan" | "build";
}

/** Something to send to T3, kept until T3 takes it (the PC may be off). */
export interface PendingOp {
	id: string;
	kind: "launch" | "build" | "send";
	message: string;
	by: string;
	createdAt: number;
	attempts: number;
	nextAt: number;
	/** The thread was told it's queued. */
	queuedNotice?: boolean;
}

/** Watching one T3 thread until its runs end. */
export interface Watch {
	threadId: string;
	/** The runs to report, in order; "" for one T3 queued without naming it yet. */
	runs: string[];
	since: number;
	nextAt: number;
	failures: number;
	lastOkAt: number;
	/** "Waiting in the T3 app" was posted for this wait. */
	waitingNotice?: boolean;
	/** "Lost contact with T3" was posted. */
	lostNotice?: boolean;
}

export interface BridgeRecord {
	discordThreadId: string;
	guildId: string;
	channelId: string;
	projectId: string;
	baseRef: string;
	title: string;
	/** Link to the Discord thread. */
	link: string;
	createdAt: number;
	createdBy: string;
	/** The quoted suggestion, kept for the build thread. */
	suggestion?: string;
	t3: T3Ref[];
	/** The T3 thread follow-ups go to: the plan thread, then the build thread. */
	current?: string;
	ops: PendingOp[];
	watch?: Watch;
	/** Runs already reported, newest last. */
	posted: string[];
	/** The plan the last plan-mode run ended with, for "Build it". */
	plan?: string;
	stopped?: boolean;
}

/** Someone not on the allow list asked for T3; it waits for the owner's button. */
export interface Proposal {
	id: string;
	kind: "start" | "send";
	discordThreadId: string;
	userId: string;
	userName: string;
	text: string;
	createdAt: number;
}

interface Saved {
	records?: Record<string, BridgeRecord>;
	proposals?: Record<string, Proposal>;
	day?: { date: string; count: number };
}

/** Proposals nobody answered are dropped after a week. */
const PROPOSAL_TTL_MS = 7 * 86_400_000;

/**
 * Discord thread ↔ T3 thread(s), queued requests and open proposals, in
 * /data/t3-bridge.json so a restart or a deploy loses nothing.
 */
export class BridgeStore {
	records = new Map<string, BridgeRecord>();
	proposals = new Map<string, Proposal>();
	day = { date: "", count: 0 };
	private saving = Promise.resolve();

	constructor(private readonly path: string) {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Saved;
			for (const [id, record] of Object.entries(saved.records || {}))
				if (record && Array.isArray(record.t3) && Array.isArray(record.ops)) this.records.set(id, { ...record, posted: record.posted || [] });
			const now = Date.now();
			for (const [id, proposal] of Object.entries(saved.proposals || {})) if (proposal && now - proposal.createdAt < PROPOSAL_TTL_MS) this.proposals.set(id, proposal);
			if (saved.day) this.day = saved.day;
		} catch {
			// Nothing saved yet.
		}
	}

	/** Counts one T3 request against today's limit; false when it's used up. */
	take(limit: number, now = new Date()): boolean {
		const date = now.toISOString().slice(0, 10);
		if (this.day.date !== date) this.day = { date, count: 0 };
		if (this.day.count >= limit) return false;
		this.day.count += 1;
		return true;
	}

	left(limit: number, now = new Date()): number {
		return this.day.date === now.toISOString().slice(0, 10) ? Math.max(0, limit - this.day.count) : limit;
	}

	save(): Promise<void> {
		const data: Saved = { records: Object.fromEntries(this.records), proposals: Object.fromEntries(this.proposals), day: this.day };
		const text = JSON.stringify(data, null, 1);
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				const temp = `${this.path}.tmp`;
				await writeFile(temp, text, { mode: 0o600 });
				await rename(temp, this.path);
			})
			.catch((error) => console.error("[t3] could not save the bridge state:", error instanceof Error ? error.message : error));
		return this.saving;
	}
}
