import type { Thread } from "../assistant/threads";
import type { LiveUpdate } from "./ha-app";

interface Live {
	started: boolean;
	at: number;
	message: string;
	progress?: { done: number; total: number };
	timer?: NodeJS.Timeout;
}

/**
 * A working job on the Lock Screen, as a Live Activity. It starts once the
 * job has run for a little while (a quick job never needs one, and iOS
 * limits how many can start), updates at most every 20 seconds with the
 * latest step, and ends as soon as the job stops working.
 */
export class LiveJobs {
	private readonly jobs = new Map<string, Live>();

	constructor(
		private readonly app: { readonly liveActivities: boolean; live(tag: string, update: LiveUpdate): Promise<boolean>; clear(tag: string): Promise<boolean> },
		private readonly timing = { after: 15_000, every: 20_000 },
	) {}

	update(thread: Thread): void {
		const job = thread.job;
		const tag = `rm-live-${thread.id}`;
		const known = this.jobs.get(thread.id);
		if (!job || (job.status !== "working" && job.status !== "queued") || !this.app.liveActivities) {
			if (known) {
				clearTimeout(known.timer);
				this.jobs.delete(thread.id);
				if (known.started) void this.app.clear(tag);
			}
			return;
		}
		const step = [...thread.messages].reverse().find((message) => message.role === "step")?.text;
		const entry = known || { started: false, at: Date.now(), message: "" };
		entry.message = (step || job.note || "Working on it").slice(0, 140);
		entry.progress = job.progress;
		this.jobs.set(thread.id, entry);
		if (entry.timer) return;
		const wait = entry.started ? this.timing.every - (Date.now() - entry.at) : this.timing.after - (Date.now() - entry.at);
		entry.timer = setTimeout(() => {
			const current = this.jobs.get(thread.id);
			if (!current) return;
			current.timer = undefined;
			const first = !current.started;
			current.started = true;
			current.at = Date.now();
			void this.app.live(tag, { title: thread.title, message: current.message, progress: current.progress, url: `./#t/${thread.id}`, first });
		}, Math.max(0, wait));
		entry.timer.unref();
	}
}
