import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { splitMessage } from "../discord/chats";
import type { BridgeConfig, ChannelRoute } from "./config";
import { FINISHED, T3AuthError, T3ToolError, T3Unreachable, type T3Api, type ThreadItem, type ThreadView } from "./mcp";
import { buildPrompt, followUpPrompt, suggestionContext, suggestionPrompt, summaryPrompt, type Suggestion } from "./prompt";
import type { BridgeRecord, BridgeStore, PendingOp, Proposal, T3Ref } from "./store";

export interface OutMessage {
	content: string;
	components?: ActionRowBuilder<ButtonBuilder>[];
}

/** Posts into a Discord thread (never pinging anyone). */
export interface Poster {
	post(discordThreadId: string, message: OutMessage): Promise<void>;
}

export interface BridgeDeps {
	config: BridgeConfig;
	api: T3Api;
	store: BridgeStore;
	poster: Poster;
	/** Shortens a long answer (mochi's own AI, without tools); optional. */
	summarize?: (prompt: string) => Promise<string | undefined>;
	now?: () => number;
}

export interface StartRequest {
	discordThreadId: string;
	guildId: string;
	channelId: string;
	route: ChannelRoute;
	suggestion: Suggestion;
	by: string;
}

/** Proposals a person not on the allow list may make a day. */
export const PROPOSALS_PER_DAY = 3;
const MAX_BACKOFF_MS = 15 * 60_000;
const QUEUE_RETRY_MS = 60_000;
/** Far past any thread's last item: T3 reads newest-first from here. */
const NEWEST = 1_000_000_000;

/** A T3 link as a Discord link that doesn't unfold into a preview. */
export function t3Link(ref: { link?: string | null } | undefined, label = "the T3 thread"): string {
	return ref?.link && /^https?:\/\//.test(ref.link) ? `[${label}](<${ref.link}>)` : label;
}

export function buildButton(discordThreadId: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`t3:build:${discordThreadId}`).setLabel("Build it").setEmoji("🔨").setStyle(ButtonStyle.Success),
	);
}

/** The run's final answer: its plan in plan mode, else its last message. */
export function answerOf(items: ThreadItem[] | undefined, runId: string): { text: string; truncated: boolean } | undefined {
	const own = (items || []).filter((item) => item.runId === runId && typeof item.text === "string" && item.text.trim());
	const pick = [...own].reverse().find((item) => item.type === "proposed_plan") || [...own].reverse().find((item) => item.type === "assistant_message");
	return pick ? { text: (pick.text as string).trim(), truncated: Boolean(pick.textTruncated) } : undefined;
}

/**
 * Discord threads ↔ T3 threads. Requests go to T3 at once or wait in a queue
 * while T3 is out of reach; a watcher reads the T3 thread until its run ends
 * and posts what changed and the answer back into the Discord thread.
 */
export class T3Bridge {
	private timer?: NodeJS.Timeout;
	private ticking = false;
	private readonly proposalCounts = new Map<string, { day: string; count: number }>();
	/** Discord threads whose queue is being sent right now: a command and the timer never send the same request twice. */
	private readonly sending = new Set<string>();

	constructor(private readonly deps: BridgeDeps) {}

	get config(): BridgeConfig {
		return this.deps.config;
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	isAllowed(userId: string): boolean {
		return this.config.allowedUsers.includes(userId);
	}

	isOwner(userId: string): boolean {
		return userId === this.config.ownerId;
	}

	/** The project for a thread's parent channel, by id or (in the configured server) by name. */
	route(channel: { id: string | null; name?: string | null }, guildId: string | null): ChannelRoute | undefined {
		if (this.config.guildId && guildId !== this.config.guildId) return undefined;
		const byId = channel.id ? this.config.channels.get(channel.id) : undefined;
		if (byId) return byId;
		if (!this.config.guildId || !channel.name) return undefined;
		return this.config.channels.get(channel.name.toLowerCase());
	}

	record(discordThreadId: string): BridgeRecord | undefined {
		return this.deps.store.records.get(discordThreadId);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), Math.min(this.config.pollMs, 10_000));
		this.timer.unref?.();
	}

	stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Start a plan-mode thread for a forum post. The reply says what happened. */
	async launch(request: StartRequest): Promise<string> {
		const { store } = this.deps;
		const existing = store.records.get(request.discordThreadId);
		if (existing) {
			const links = existing.t3.map((ref) => t3Link(ref, ref.kind === "plan" ? "plan thread" : "build thread")).join(", ") || "a queued request";
			if (existing.stopped) {
				existing.stopped = false;
				await store.save();
				return `Relaying again. This thread is linked to ${links}. Use \`/t3 send\` for a follow-up.`;
			}
			return `This thread is already linked to ${links}. Use \`/t3 send\` for a follow-up, or \`/t3 status\`.`;
		}
		if (!store.take(this.config.dailyLimit)) return this.limitText();
		const now = this.now();
		const record: BridgeRecord = {
			discordThreadId: request.discordThreadId,
			guildId: request.guildId,
			channelId: request.channelId,
			projectId: request.route.projectId,
			baseRef: request.route.baseRef,
			title: request.suggestion.title.slice(0, 200),
			link: request.suggestion.link,
			createdAt: now,
			createdBy: request.by,
			suggestion: suggestionContext(request.suggestion),
			t3: [],
			ops: [this.op("launch", suggestionPrompt(request.suggestion), request.by)],
			posted: [],
		};
		store.records.set(record.discordThreadId, record);
		console.log(`[t3] ${request.by} asked for a T3 thread for Discord thread ${record.discordThreadId}`);
		return (await this.runOps(record)).join("\n") || "Queued for T3.";
	}

	/** A follow-up into the linked T3 thread (the build thread once there is one). */
	async send(discordThreadId: string, text: string, by: string, untrusted?: { by: string }): Promise<string> {
		const record = this.record(discordThreadId);
		if (!record) return "This thread isn't linked to T3 yet. Start with `/t3 start`.";
		if (record.stopped) return "Relaying is stopped in this thread. `/t3 start` turns it back on.";
		if (!text.trim()) return "There's nothing to send.";
		if (!this.deps.store.take(this.config.dailyLimit)) return this.limitText();
		record.ops.push(this.op("send", followUpPrompt({ text, by, link: record.link, untrusted }), by));
		return (await this.runOps(record)).join("\n") || "Queued for T3.";
	}

	/** "Build it": T3 can't take a thread out of plan mode over MCP, so a second thread builds the plan. */
	async build(discordThreadId: string, by: string): Promise<string> {
		const record = this.record(discordThreadId);
		if (!record) return "This thread isn't linked to T3.";
		const built = record.t3.find((ref) => ref.kind === "build");
		if (built || record.ops.some((op) => op.kind === "build")) return `It's already being built: ${t3Link(built, "build thread")}.`;
		if (record.watch || record.ops.length) return "T3 is still working on this thread. Wait for it to finish, or `/t3 stop`.";
		if (!record.plan) return "There's no finished plan to build yet.";
		if (!this.deps.store.take(this.config.dailyLimit)) return this.limitText();
		record.stopped = false;
		const planRef = record.t3.find((ref) => ref.kind === "plan");
		record.ops.push(this.op("build", buildPrompt({ plan: record.plan, suggestion: record.suggestion, link: record.link, approvedBy: by, planLink: planRef?.link }), by));
		return (await this.runOps(record)).join("\n") || "Queued for T3.";
	}

	/** Stop relaying, drop what's queued, and interrupt T3's run if one is going. */
	async stop(discordThreadId: string, by: string): Promise<string> {
		const record = this.record(discordThreadId);
		if (!record) return "This thread isn't linked to T3.";
		const dropped = record.ops.length;
		const watched = record.watch?.threadId;
		record.stopped = true;
		record.ops = [];
		record.watch = undefined;
		await this.deps.store.save();
		const lines = [`Stopped relaying T3 here${dropped ? `, and dropped ${dropped} queued request${dropped === 1 ? "" : "s"}` : ""}.`];
		if (watched) {
			try {
				const result = await this.deps.api.interrupt({ threadId: watched, reason: `Stopped from Discord by ${by}` });
				lines.push(result?.status === "no_active_run" ? "T3 had nothing running." : "Interrupted T3's run.");
			} catch (error) {
				lines.push(`Couldn't interrupt T3's run (${this.reason(error)}); stop it in the T3 app if it's still going.`);
			}
		}
		lines.push("`/t3 start` turns relaying back on.");
		console.log(`[t3] ${by} stopped Discord thread ${discordThreadId}`);
		return lines.join(" ");
	}

	async status(discordThreadId: string): Promise<string> {
		const record = this.record(discordThreadId);
		let reachable: string;
		try {
			await this.deps.api.ping();
			reachable = "T3 is reachable.";
		} catch (error) {
			reachable = `T3 isn't reachable right now (${this.reason(error)}).`;
		}
		const left = `${this.deps.store.left(this.config.dailyLimit)} of ${this.config.dailyLimit} T3 requests left today.`;
		if (!record) return `This thread isn't linked to T3. ${reachable} ${left}`;
		const lines = [
			record.t3.length ? `Linked to ${record.t3.map((ref) => t3Link(ref, ref.kind === "plan" ? "plan thread" : "build thread")).join(" and ")}.` : "Not in T3 yet.",
			record.stopped ? "Relaying is stopped." : record.ops.length ? `${record.ops.length} request${record.ops.length === 1 ? "" : "s"} queued since <t:${Math.floor(record.ops[0].createdAt / 1000)}:R>.` : record.watch ? "T3 is working on it; I'll post when it's done." : "Nothing running.",
			reachable,
			left,
		];
		return lines.join("\n");
	}

	/** Counts a proposal for someone not on the allow list; undefined when they've made their share today. */
	propose(input: Omit<Proposal, "id" | "createdAt">): Proposal | undefined {
		const day = new Date(this.now()).toISOString().slice(0, 10);
		const seen = this.proposalCounts.get(input.userId);
		const count = seen?.day === day ? seen.count : 0;
		if (count >= PROPOSALS_PER_DAY) return undefined;
		this.proposalCounts.set(input.userId, { day, count: count + 1 });
		const proposal: Proposal = { ...input, id: randomUUID().slice(0, 8), createdAt: this.now() };
		this.deps.store.proposals.set(proposal.id, proposal);
		void this.deps.store.save();
		return proposal;
	}

	takeProposal(id: string): Proposal | undefined {
		const proposal = this.deps.store.proposals.get(id);
		if (proposal) {
			this.deps.store.proposals.delete(id);
			void this.deps.store.save();
		}
		return proposal;
	}

	/** One pass: send what's queued and due, and check the threads being watched. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.now();
			for (const record of [...this.deps.store.records.values()]) {
				if (record.stopped) continue;
				try {
					if (record.ops.length && record.ops[0].nextAt <= now) for (const line of await this.runOps(record)) await this.post(record, { content: line });
					if (record.watch && record.watch.nextAt <= now) await this.poll(record);
				} catch (error) {
					console.error(`[t3] Discord thread ${record.discordThreadId}:`, this.reason(error));
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	private op(kind: PendingOp["kind"], message: string, by: string): PendingOp {
		const now = this.now();
		return { id: randomUUID().slice(0, 12), kind, message, by, createdAt: now, attempts: 0, nextAt: now };
	}

	private limitText(): string {
		return `Today's limit of ${this.config.dailyLimit} T3 requests is used up. Try again tomorrow.`;
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private async post(record: BridgeRecord, message: OutMessage): Promise<void> {
		try {
			await this.deps.poster.post(record.discordThreadId, message);
		} catch (error) {
			console.error(`[t3] couldn't post in Discord thread ${record.discordThreadId}:`, this.reason(error));
		}
	}

	/** Sends the queued requests in order; returns what to tell the thread. Stops at the first one T3 can't take. */
	private async runOps(record: BridgeRecord): Promise<string[]> {
		const lines: string[] = [];
		if (this.sending.has(record.discordThreadId)) {
			await this.deps.store.save();
			return lines;
		}
		this.sending.add(record.discordThreadId);
		try {
			await this.sendOps(record, lines);
		} finally {
			this.sending.delete(record.discordThreadId);
		}
		await this.deps.store.save();
		return lines;
	}

	private async sendOps(record: BridgeRecord, lines: string[]): Promise<void> {
		while (record.ops.length && !record.stopped) {
			const op = record.ops[0];
			try {
				lines.push(await this.execute(record, op));
				record.ops.shift();
			} catch (error) {
				const now = this.now();
				if (error instanceof T3Unreachable) {
					op.attempts += 1;
					if (now - op.createdAt >= this.config.queueTimeoutMs) {
						record.ops = [];
						lines.push(`Gave up: T3 stayed out of reach for ${this.hours(this.config.queueTimeoutMs)}. Try again with \`/t3 ${op.kind === "send" ? "send" : "start"}\` once the PC is on.`);
						console.warn(`[t3] gave up on a ${op.kind} for Discord thread ${record.discordThreadId}`);
						if (!record.t3.length) this.deps.store.records.delete(record.discordThreadId);
					} else {
						op.nextAt = now + Math.min(QUEUE_RETRY_MS * 2 ** (op.attempts - 1), MAX_BACKOFF_MS);
						if (!op.queuedNotice) {
							op.queuedNotice = true;
							lines.push(`💤 T3 isn't reachable right now (the PC may be off). Queued: I'll keep trying for up to ${this.hours(this.config.queueTimeoutMs)}.`);
						}
						console.warn(`[t3] ${op.kind} for Discord thread ${record.discordThreadId} queued: ${error.message}`);
					}
				} else {
					// The token or the request itself is wrong: retrying won't help.
					record.ops.shift();
					if (!record.t3.length && !record.ops.length) this.deps.store.records.delete(record.discordThreadId);
					lines.push(
						error instanceof T3AuthError
							? "T3 refused the bridge's token (expired or revoked?). Gabor needs to issue a new one and set it as `t3_token`."
							: `T3 didn't take it: ${error instanceof T3ToolError ? error.message.slice(0, 300) : "unexpected error"}.`,
					);
					console.error(`[t3] ${op.kind} for Discord thread ${record.discordThreadId} failed:`, this.reason(error));
				}
				break;
			}
		}
	}

	private hours(ms: number): string {
		const hours = ms / 3_600_000;
		return hours >= 1 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(ms / 60_000)} min`;
	}

	private async execute(record: BridgeRecord, op: PendingOp): Promise<string> {
		const { api } = this.deps;
		if (op.kind === "send") {
			const threadId = record.current;
			if (!threadId) throw new T3ToolError("the T3 thread isn't there yet");
			const sent = await api.send({ threadId, message: op.message, mode: "queue", clientRequestId: `discord:${record.discordThreadId}:send:${op.id}` });
			this.watch(record, threadId, sent.runId || undefined);
			const ref = record.t3.find((item) => item.threadId === threadId);
			return `📨 Sent to ${t3Link(ref)}${sent.delivery === "queued" ? " (after the turn that's running)" : ""}. I'll post the answer here.`;
		}
		const building = op.kind === "build";
		const launched = await api.launch({
			projectId: record.projectId,
			title: `${building ? "Build" : "Discord"}: ${record.title}`.slice(0, 100),
			message: op.message,
			runtimeMode: "approval-required",
			interactionMode: building ? "default" : "plan",
			workspaceStrategy: { type: "worktree", baseRef: record.baseRef, startFromOrigin: true },
			modelSelection: this.config.model,
			// Retries after a lost reply land on the same thread.
			clientRequestId: building ? `discord:${record.discordThreadId}:build` : `discord:${record.discordThreadId}`,
		});
		const ref: T3Ref = { threadId: launched.threadId, link: launched.link, kind: building ? "build" : "plan" };
		if (!record.t3.some((item) => item.threadId === ref.threadId)) record.t3.push(ref);
		record.current = ref.threadId;
		this.watch(record, ref.threadId, launched.runId || undefined);
		console.log(`[t3] ${ref.kind} thread ${ref.threadId} for Discord thread ${record.discordThreadId}`);
		return building
			? `🔨 Building it in ${t3Link(ref, "a new T3 thread")}: T3 can't switch the plan thread out of plan mode from here, so a second thread builds the approved plan, in its own worktree and with every tool call waiting for approval in the T3 app.`
			: `🧭 Sent to T3 in plan mode, in a new worktree from \`${record.baseRef}\`: ${t3Link(ref)}. I'll post the plan here.`;
	}

	/** Report this run too; a run still being watched on the same thread is reported first. */
	private watch(record: BridgeRecord, threadId: string, runId?: string): void {
		const now = this.now();
		const run = runId || "";
		if (record.watch?.threadId === threadId) {
			if (!record.watch.runs.includes(run) || !run) record.watch.runs.push(run);
			return;
		}
		record.watch = { threadId, runs: [run], since: now, nextAt: now + Math.min(this.config.pollMs, 10_000), failures: 0, lastOkAt: now };
	}

	private async poll(record: BridgeRecord): Promise<void> {
		const watch = record.watch;
		if (!watch) return;
		const now = this.now();
		let view: ThreadView;
		try {
			view = await this.deps.api.read({ threadId: watch.threadId, view: "messages", limit: 20, beforePosition: NEWEST, runLimit: 5, maxCharsPerItem: 20_000 });
		} catch (error) {
			if (error instanceof T3Unreachable) {
				watch.failures += 1;
				watch.nextAt = now + Math.min(this.config.pollMs * 2 ** watch.failures, MAX_BACKOFF_MS);
				if (now - watch.lastOkAt >= this.config.queueTimeoutMs) {
					record.watch = undefined;
					await this.post(record, { content: `Stopped watching: T3 has been out of reach for ${this.hours(this.config.queueTimeoutMs)}. The answer will be in ${t3Link(this.ref(record, watch.threadId))}; \`/t3 status\` shows where things are.` });
				} else if (watch.failures >= 3 && !watch.lostNotice) {
					watch.lostNotice = true;
					await this.post(record, { content: "💤 Lost contact with T3 (the PC may be off or asleep). I'll keep checking." });
				}
			} else {
				record.watch = undefined;
				await this.post(record, {
					content: error instanceof T3AuthError ? "T3 refused the bridge's token (expired or revoked?), so I stopped watching. Gabor needs to issue a new one." : `Stopped watching: T3 said ${this.reason(error).slice(0, 300)}.`,
				});
			}
			await this.deps.store.save();
			return;
		}
		if (watch.lostNotice) await this.post(record, { content: "T3 is back; still watching." });
		watch.failures = 0;
		watch.lostNotice = false;
		watch.lastOkAt = now;
		watch.nextAt = now + this.config.pollMs;
		const thread = view.thread;
		const ref = this.ref(record, watch.threadId);
		while (watch.runs.length) {
			let runId = watch.runs[0];
			if (!runId) {
				// T3 queued the message without naming its run: the next one not reported yet.
				const next = [thread.activeRunId, thread.latestRunId].find((id): id is string => Boolean(id) && !record.posted.includes(id as string) && !watch.runs.includes(id as string));
				if (!next) {
					// A message T3 never started a run for isn't waited on forever.
					if (now - watch.since < this.config.queueTimeoutMs) break;
					watch.runs.shift();
					continue;
				}
				runId = watch.runs[0] = next;
			}
			const run = view.recentRuns?.find((item) => item.runId === runId);
			const status = run?.status || (thread.activeRunId === runId || thread.latestRunId === runId ? thread.status : undefined);
			const finished = Boolean(status && FINISHED.has(status));
			if (!finished) {
				const waiting = (thread.pendingRequestCount || 0) > 0 || status === "waiting";
				if (waiting && !watch.waitingNotice) {
					watch.waitingNotice = true;
					await this.post(record, { content: `⏸️ T3 is waiting for an approval or an answer in the T3 app: ${t3Link(ref)}.` });
				} else if (!waiting) watch.waitingNotice = false;
				break;
			}
			let answer = answerOf(view.items, runId);
			if (!answer) {
				// Long runs: the answer may sit behind many tool items.
				const more = await this.deps.api.read({ threadId: watch.threadId, view: "activity", limit: 100, beforePosition: NEWEST, maxCharsPerItem: 20_000 }).catch(() => undefined);
				answer = answerOf(more?.items, runId);
			}
			watch.runs.shift();
			watch.waitingNotice = false;
			record.posted = [...record.posted, runId].slice(-30);
			await this.report(record, ref, status as string, answer);
		}
		if (!watch.runs.length) record.watch = undefined;
		await this.deps.store.save();
	}

	private ref(record: BridgeRecord, threadId: string): T3Ref | undefined {
		return record.t3.find((item) => item.threadId === threadId);
	}

	private async report(record: BridgeRecord, ref: T3Ref | undefined, status: string, answer: { text: string; truncated: boolean } | undefined): Promise<void> {
		const open = ref?.link ? `\n\n${t3Link(ref, "Open in T3")}` : "";
		if (status !== "completed") {
			await this.post(record, { content: `⚠️ T3's run ended: **${status.replace("_", " ")}**.${open}` });
			return;
		}
		const plan = ref?.kind === "plan";
		if (plan && answer) record.plan = answer.text;
		const header = plan ? "📋 **T3's plan**" : "✅ **T3 is done**";
		const body = answer ? await this.fit(answer.text, answer.truncated) : "(T3 finished without a written answer.)";
		const chunks = splitMessage(`${header}\n\n${body}${open}`, 1900);
		const offerBuild = plan && answer && !record.t3.some((item) => item.kind === "build");
		for (const [index, chunk] of chunks.entries()) {
			const last = index === chunks.length - 1;
			await this.post(record, { content: chunk, ...(last && offerBuild ? { components: [buildButton(record.discordThreadId)] } : {}) });
		}
		console.log(`[t3] posted the ${plan ? "plan" : "answer"} for Discord thread ${record.discordThreadId}`);
	}

	/** Fits an answer to the post limit: summarised by mochi's AI when there is one, else cut at a paragraph. */
	private async fit(text: string, truncated: boolean): Promise<string> {
		const limit = this.config.maxPostChars;
		if (text.length <= limit && !truncated) return text;
		if (this.deps.summarize) {
			const summary = await this.deps.summarize(summaryPrompt(text, limit - 200)).catch(() => undefined);
			if (summary?.trim() && summary.length <= limit) return `${summary.trim()}\n\n_(A summary; the full answer is in T3.)_`;
		}
		let cut = text.slice(0, limit);
		const paragraph = cut.lastIndexOf("\n\n");
		if (paragraph > limit / 2) cut = cut.slice(0, paragraph);
		return `${cut.trimEnd()}\n\n_(Cut here; the full answer is in T3.)_`;
	}
}
