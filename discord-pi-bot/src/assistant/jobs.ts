import type { PriorTurn } from "../ai/types";
import type { AskInput, AskResult } from "./agent";
import type { Thread, ThreadStore } from "./threads";
import { titleFrom } from "./threads";

/** What a running job may do besides the ordinary tools. */
export interface JobTools {
	update(step: string, progress?: { done: number; total: number }, note?: string): void;
	ask(question: string, options: string[]): void;
	finish(result: string): void;
	/** End this run and look again later: after `hours`, or sooner when a matching email arrives. */
	checkBack(input: { hours: number; mailWords: string[]; tell?: string; note?: string }): void;
}

export interface JobDeps {
	threads: ThreadStore;
	ask(input: AskInput): Promise<AskResult>;
	/** Tell the user: a question, the result, or that the job stopped. */
	notify(thread: Thread, text: string): Promise<void>;
	/** Runs (of up to ten tool rounds each) before a job stops to check in. */
	runsPerGo?: number;
	/** A wake-up time moved out of the quiet hours. */
	quietUntil?(at: Date): Date;
	/** How long a watch keeps going before it stops on its own. */
	watchDays?: number;
}

const RUNS_PER_GO = 6;
const WATCH_DAYS = 7;
/* A watch that ends a run without saying when to look again looks again in three hours. */
const DEFAULT_CHECK_HOURS = 3;

function clock(at: string): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The job's brief for each run: what it is for, and what it has found so far. */
export function jobBrief(thread: Thread): string {
	const job = thread.job!;
	const steps = thread.messages.filter((message) => message.role === "step").slice(-40);
	return [
		`You are working on a background job: "${thread.title}".`,
		`What to do: ${job.instructions}`,
		`This is run ${job.runs + 1}. Each run allows about ten tool rounds, and the job gets several runs, so work steadily.`,
		"If the job watches for something to change (a parcel, a price, a reply), look once, note what you saw with job_update, then call check_back with when to look again and mail_words that should wake you sooner. Never look twice in a row: nothing changes in a minute, and every look costs money. Tell the user only what is new.",
		...(job.wokeBy ? [`You were woken by ${job.wokeBy}.`] : []),
		steps.length ? `Steps so far (you don't keep tool results between runs; these are your notes):\n${steps.map((step) => `- ${clock(step.at)} ${step.text}`).join("\n")}` : "No steps yet.",
	].join("\n");
}

function optionsLine(options: string[]): string {
	return options.length ? `\n${options.map((option) => `• ${option}`).join("\n")}` : "";
}

/**
 * Background jobs: work that takes many steps runs here, one job at a time,
 * after the turn that started it. A job writes its steps into its thread,
 * asks when it needs a decision, and finishes with a result; each of those
 * reaches the user on Discord too.
 */
export class JobRunner {
	private queue: string[] = [];
	private current?: { id: string; abort: AbortController };
	private pumping?: Promise<void>;

	constructor(private readonly deps: JobDeps) {}

	/** Jobs that were queued or working when the app stopped carry on. */
	resume(): void {
		for (const thread of this.deps.threads.list())
			if (thread.job && (thread.job.status === "queued" || thread.job.status === "working")) this.enqueue(thread.id);
	}

	/**
	 * Hand work to a job. From a console thread, that thread becomes the job;
	 * from anywhere else, the job gets a thread of its own.
	 */
	start(input: { title: string; instructions: string; threadId?: string; origin: Thread["origin"]; request?: string }): Thread {
		const { threads } = this.deps;
		const title = titleFrom(input.title);
		let thread = input.threadId ? threads.makeJob(input.threadId, title, input.instructions) : undefined;
		if (!thread) {
			thread = threads.create({ title, origin: input.origin, job: { status: "queued", instructions: input.instructions, runs: 0 } });
			if (input.request) threads.append(thread.id, { role: "user", text: input.request });
		}
		this.enqueue(thread.id);
		return thread;
	}

	/** The user's answer or follow-up: the job picks up again with it. */
	answer(id: string, text: string): boolean {
		const { threads } = this.deps;
		const thread = threads.get(id);
		if (!thread?.job || !text.trim()) return false;
		threads.append(id, { role: "user", text });
		if (thread.job.status === "queued" || thread.job.status === "working") return true;
		threads.updateJob(id, { status: "queued", question: undefined, error: undefined, result: undefined, wakeAt: undefined, wokeBy: "the user's reply" });
		this.enqueue(id);
		return true;
	}

	stop(id: string): boolean {
		const { threads } = this.deps;
		const thread = threads.get(id);
		if (!thread?.job || thread.job.status === "done" || thread.job.status === "stopped") return false;
		this.queue = this.queue.filter((queued) => queued !== id);
		if (this.current?.id === id) this.current.abort.abort();
		threads.updateJob(id, { status: "stopped", note: "Stopped by you", question: undefined, wakeAt: undefined, wakeWords: undefined });
		threads.append(id, { role: "assistant", text: "Stopped. Reply to start it again." });
		return true;
	}

	/** Jobs waiting for the user's answer, for the assistant's context. */
	waiting(): Array<{ id: string; title: string; question: string }> {
		return this.deps.threads
			.list()
			.filter((thread) => thread.job?.status === "needs_you" && thread.job.question)
			.map((thread) => ({ id: thread.id, title: thread.title, question: thread.job!.question!.text }));
	}

	/** Resolves when nothing is queued or running; for tests. */
	async settled(): Promise<void> {
		while (this.pumping) await this.pumping;
	}

	/** A watch between checks: tell what's new, then sleep until the time or a matching email. */
	private async sleep(id: string, later: { hours: number; mailWords: string[]; tell?: string; note?: string }, say: (text: string) => Promise<void>, now = new Date()): Promise<void> {
		const { threads } = this.deps;
		const job = threads.get(id)!.job!;
		if (later.tell?.trim()) await say(later.tell.trim());
		const until = job.watchUntil ? new Date(job.watchUntil) : new Date(now.getTime() + (this.deps.watchDays ?? WATCH_DAYS) * 86_400_000);
		const hours = Math.min(72, Math.max(0.5, Number.isFinite(later.hours) ? later.hours : DEFAULT_CHECK_HOURS));
		const wake = this.deps.quietUntil ? this.deps.quietUntil(new Date(now.getTime() + hours * 3_600_000)) : new Date(now.getTime() + hours * 3_600_000);
		if (wake > until) {
			threads.updateJob(id, { status: "done", result: "Stopped watching after a week.", wakeAt: undefined, wakeWords: undefined });
			return say("I've watched this for a week, so I've stopped. Reply if you want me to keep going.");
		}
		const words = later.mailWords.map((word) => word.trim()).filter((word) => word.length >= 3).slice(0, 8);
		const when = `${clock(wake.toISOString())}${wake.toDateString() === now.toDateString() ? "" : ` ${wake.toLocaleDateString("en-GB", { weekday: "short" })}`}`;
		threads.updateJob(id, {
			status: "waiting",
			wakeAt: wake.toISOString(),
			wakeWords: words.length ? words : undefined,
			watchUntil: until.toISOString(),
			note: `${later.note?.trim() ? `${later.note.trim().slice(0, 60)}; ` : ""}next look ${when}${words.length ? `, or when an email mentions ${words.slice(0, 2).join(" or ")}` : ""}`,
		});
	}

	/** Wake the watches that are due. Called every minute. */
	tick(now = new Date()): void {
		for (const thread of this.deps.threads.list())
			if (thread.job?.status === "waiting" && thread.job.wakeAt && Date.parse(thread.job.wakeAt) <= now.getTime()) this.wake(thread.id, "the time it set to look again");
	}

	/** New mail: wake the watches whose words are in a sender or subject. */
	mailArrived(mails: Array<{ from: string; subject: string }>): void {
		for (const thread of this.deps.threads.list()) {
			const words = thread.job?.status === "waiting" ? thread.job.wakeWords || [] : [];
			const match = mails.find((mail) => words.some((word) => `${mail.from} ${mail.subject}`.toLowerCase().includes(word.toLowerCase())));
			if (match) this.wake(thread.id, `a new email from ${match.from}: "${match.subject}"`);
		}
	}

	private wake(id: string, why: string): void {
		this.deps.threads.updateJob(id, { status: "queued", wakeAt: undefined, wokeBy: why });
		this.enqueue(id);
	}

	/** Look for due watches every minute, for as long as the app runs. */
	startClock(): void {
		this.tick();
		setInterval(() => this.tick(), 60_000).unref();
	}

	private enqueue(id: string): void {
		if (this.current?.id === id || this.queue.includes(id)) return;
		this.queue.push(id);
		if (!this.pumping)
			this.pumping = (async () => {
				// Let the turn that started the job finish first.
				await new Promise((resolve) => setImmediate(resolve));
				while (this.queue.length) {
					const next = this.queue.shift()!;
					await this.run(next).catch((error) => console.error(`Job ${next} failed:`, error));
				}
			})().finally(() => (this.pumping = undefined));
	}

	private async run(id: string): Promise<void> {
		const { threads } = this.deps;
		await threads.idle(id);
		const initial = threads.get(id);
		if (!initial?.job || (initial.job.status !== "queued" && initial.job.status !== "working")) return;
		const abort = new AbortController();
		this.current = { id, abort };
		threads.updateJob(id, { status: "working", error: undefined });
		const say = async (text: string, message = text) => {
			threads.append(id, { role: "assistant", text });
			await this.deps.notify(threads.get(id)!, message).catch((error) => console.warn("Could not send a job update:", error instanceof Error ? error.message : error));
		};
		try {
			for (let go = 0; go < (this.deps.runsPerGo ?? RUNS_PER_GO); go++) {
				const thread = threads.get(id)!;
				let outcome: "asked" | "finished" | "waiting" | undefined;
				let later: { hours: number; mailWords: string[]; tell?: string; note?: string } | undefined;
				const tools: JobTools = {
					update: (step, progress, note) => {
						if (step.trim()) threads.append(id, { role: "step", text: step });
						threads.updateJob(id, { ...(progress ? { progress } : {}), ...(note ? { note } : {}) });
					},
					ask: (question, options) => {
						if (outcome) return;
						outcome = "asked";
						threads.updateJob(id, { status: "needs_you", question: { text: question, options } });
					},
					finish: (result) => {
						if (outcome) return;
						outcome = "finished";
						const progress = threads.get(id)?.job?.progress;
						threads.updateJob(id, { status: "done", result, question: undefined, wakeAt: undefined, wakeWords: undefined, ...(progress ? { progress: { done: progress.total, total: progress.total } } : {}) });
					},
					checkBack: (input) => {
						if (outcome) return;
						outcome = "waiting";
						later = input;
					},
				};
				// The user's latest words, if new and last, are this run's prompt.
				const history: PriorTurn[] = threads.history(id);
				const first = thread.job!.runs === 0;
				const lastUser = [...thread.messages].reverse().find((message) => message.role === "user");
				const fresh = Boolean(lastUser && lastUser.id !== thread.job!.lastRead);
				let prompt = first ? `Start the job "${thread.title}".` : "Carry on with the job from where you left off.";
				if (history[history.length - 1]?.role === "user") {
					const said = history.pop()!.text;
					prompt = fresh && !first ? said : `${said}\n\n${prompt}`;
				}
				if (lastUser) threads.updateJob(id, { lastRead: lastUser.id });
				const watching = Boolean(thread.job!.watchUntil);
				const result = await this.deps.ask({
					prompt,
					channel: "job",
					history,
					extra: jobBrief(threads.get(id)!),
					conversationId: `thread:${id}`,
					threadId: id,
					signal: abort.signal,
					tools: { job: tools },
				});
				threads.updateJob(id, { runs: (threads.get(id)?.job?.runs || 0) + 1, wokeBy: undefined });
				if (abort.signal.aborted) return;
				if (result.did.length) threads.append(id, { role: "step", text: result.did.map((item) => item.text).join("; "), receipts: result.did });
				if (result.confirms.length)
					threads.append(id, {
						role: "step",
						text: "Waiting for your tap",
						confirms: result.confirms.map((item) => ({ token: item.token, message: item.message, destructive: item.destructive })),
					});
				if (result.problem) {
					threads.updateJob(id, { status: "stopped", error: result.problem });
					await say(`I had to stop: ${result.problem}`);
					return;
				}
				const job = threads.get(id)!.job!;
				if (outcome === "asked" && job.question) return void (await say(job.question.text, `${job.question.text}${optionsLine(job.question.options)}`));
				if (outcome === "finished") return void (await say(job.result || result.text));
				// A watch never loops: if it didn't say when to look again, it looks again in a few hours.
				if (outcome === "waiting" || watching) return void (await this.sleep(id, later || { hours: DEFAULT_CHECK_HOURS, mailWords: job.wakeWords || [] }, say));
			}
			threads.updateJob(id, { status: "stopped", note: "Paused to check in" });
			await say("I've worked on this for a while without finishing. Reply \"carry on\" and I'll keep going, or tell me what to change.");
		} catch (error) {
			if (abort.signal.aborted) return;
			threads.updateJob(id, { status: "stopped", error: error instanceof Error ? error.message : String(error) });
			await say(`I had to stop: ${error instanceof Error ? error.message : error}`);
		} finally {
			if (this.current?.id === id) this.current = undefined;
		}
	}
}
