import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { localDate, type SpendLedger } from "./spend";

/*
 * The monthly API credits that come with a Claude Max or Team plan, against
 * what has been spent since they last arrived. No Anthropic API reports the
 * credit balance, so the allowance and the day it renews are the owner's to
 * enter. Spend comes from Anthropic's cost report when an Admin key is set,
 * and RemindMe's own count at list prices otherwise.
 */

export interface CreditPlan {
	/** US dollars a month; Max 20x gives 200. */
	allowance: number;
	/** Day of the month new credits arrive (the plan's billing day); unset counts from the 1st. */
	renewDay: number | null;
}

const DEFAULT_PLAN: CreditPlan = { allowance: 200, renewDay: null };

export class CreditSettings {
	private plan: CreditPlan = { ...DEFAULT_PLAN };

	constructor(private readonly path = process.env.CREDITS_DATA_PATH || "./data/credits.json") {}

	async load(): Promise<void> {
		try {
			this.plan = { ...DEFAULT_PLAN, ...checkPlan(JSON.parse(await readFile(this.path, "utf8"))) };
		} catch {
			// Missing: the defaults.
		}
	}

	get(): CreditPlan {
		return { ...this.plan };
	}

	async set(change: Partial<CreditPlan>): Promise<CreditPlan> {
		this.plan = { ...this.plan, ...checkPlan(change) };
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.plan));
		await rename(`${this.path}.tmp`, this.path);
		return this.get();
	}
}

function checkPlan(input: unknown): Partial<CreditPlan> {
	const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const plan: Partial<CreditPlan> = {};
	if (value.allowance !== undefined) {
		const allowance = Number(value.allowance);
		if (!Number.isFinite(allowance) || allowance < 0 || allowance > 100_000) throw new Error("The allowance is a number of dollars, such as 200.");
		plan.allowance = Math.round(allowance * 100) / 100;
	}
	if (value.renewDay !== undefined) {
		if (value.renewDay === null || value.renewDay === "") plan.renewDay = null;
		else {
			const day = Number(value.renewDay);
			if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("The day is a day of the month, 1 to 31.");
			plan.renewDay = day;
		}
	}
	return plan;
}

export interface Cycle {
	/** Local dates, YYYY-MM-DD; `end` is the day the next credits arrive. */
	start: string;
	end: string;
	/** How many days the cycle has, which day of it today is (1-based), and the days after today. */
	days: number;
	day: number;
	daysLeft: number;
}

/** The day in a month that a renewal day falls on: the 31st is the 30th in a 30-day month. */
function renewalIn(year: number, month: number, renewDay: number): Date {
	const last = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(renewDay, last));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
	return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);
}

/** The credit month around `now`, from the last renewal to the next. */
export function cycleFor(now: Date, renewDay: number | null): Cycle {
	const day = renewDay || 1;
	let start = renewalIn(now.getFullYear(), now.getMonth(), day);
	if (start > now) start = renewalIn(now.getFullYear(), now.getMonth() - 1, day);
	const end = renewalIn(start.getFullYear(), start.getMonth() + 1, day);
	const days = daysBetween(start, end);
	const today = daysBetween(start, now) + 1;
	return { start: localDate(start), end: localDate(end), days, day: today, daysLeft: days - today };
}

export interface CostPart {
	/** "Opus 5.5", "Web searches" and the like. */
	label: string;
	usd: number;
	count?: number;
}

export interface MonthCosts {
	usd: number;
	/** Per local date, YYYY-MM-DD. */
	perDay: Record<string, number>;
	parts: CostPart[];
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelLabel(model: string): string {
	const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model);
	if (!match) return model;
	const [, family, major, minor] = match;
	return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor && minor.length <= 2 ? `${major}.${minor}` : major}`;
}

const COST_KINDS: Record<string, string> = { web_search: "Web searches", code_execution: "Code runs", session_usage: "Agent sessions" };

interface CostReport {
	data?: Array<{ starting_at?: string; results?: Array<{ amount?: string; cost_type?: string | null; model?: string | null; description?: string | null }> }>;
	has_more?: boolean;
	next_page?: string | null;
}

/** Anthropic's cost report, grouped by description: amounts are strings in cents, days are UTC. */
export function readCostReport(pages: CostReport[]): MonthCosts {
	const perDay: Record<string, number> = {};
	const parts = new Map<string, number>();
	let usd = 0;
	for (const page of pages)
		for (const bucket of page.data || []) {
			const date = String(bucket.starting_at || "").slice(0, 10);
			for (const result of bucket.results || []) {
				const dollars = Number(result.amount) / 100;
				if (!Number.isFinite(dollars) || !dollars) continue;
				usd += dollars;
				if (date) perDay[date] = (perDay[date] || 0) + dollars;
				const label = result.model ? modelLabel(result.model) : COST_KINDS[result.cost_type || ""] || result.description || "Other";
				parts.set(label, (parts.get(label) || 0) + dollars);
			}
		}
	return { usd, perDay, parts: [...parts].map(([label, cost]) => ({ label, usd: cost })).sort((a, b) => b.usd - a.usd) };
}

type Fetch = typeof fetch;

/** Anthropic's own figures, for the whole organization, asked at most every ten minutes. */
export class AnthropicCosts {
	private cached?: { key: string; at: number; costs: MonthCosts };
	private pending?: Promise<MonthCosts>;

	constructor(
		private readonly adminKey: () => string,
		private readonly fetchImpl: Fetch = fetch,
		private readonly maxAgeMs = 10 * 60 * 1000,
	) {}

	get configured(): boolean {
		return Boolean(this.adminKey());
	}

	/** When the cached figures were fetched. */
	get fetchedAt(): string | undefined {
		return this.cached ? new Date(this.cached.at).toISOString() : undefined;
	}

	async since(start: string, now = Date.now()): Promise<MonthCosts> {
		if (this.cached?.key === start && now - this.cached.at < this.maxAgeMs) return this.cached.costs;
		this.pending ??= this.fetchMonth(start)
			.then((costs) => {
				this.cached = { key: start, at: Date.now(), costs };
				return costs;
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	private async fetchMonth(start: string): Promise<MonthCosts> {
		const key = this.adminKey();
		if (!key) throw new Error("No Admin key in the app options.");
		const pages: CostReport[] = [];
		let page: string | undefined;
		for (let round = 0; round < 4; round++) {
			const query = new URLSearchParams({ starting_at: `${start}T00:00:00Z`, bucket_width: "1d", limit: "31" });
			query.append("group_by[]", "description");
			if (page) query.set("page", page);
			const response = await this.fetchImpl(`https://api.anthropic.com/v1/organizations/cost_report?${query}`, {
				headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "User-Agent": "RemindMe/4 (Home Assistant app)" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(costError(response.status, await response.text().catch(() => "")));
			const body = (await response.json()) as CostReport;
			pages.push(body);
			if (!body.has_more || !body.next_page) break;
			page = body.next_page;
		}
		return readCostReport(pages);
	}
}

function costError(status: number, body: string): string {
	let message = "";
	try {
		message = String((JSON.parse(body) as { error?: { message?: string } })?.error?.message || "");
	} catch {
		// Not JSON.
	}
	if (status === 401) return "Anthropic didn't accept the Admin key. Check it in the app options.";
	if (status === 403) return "That key can't read costs. It has to be an Admin key (sk-ant-admin…) of an organization.";
	return `Anthropic's cost report answered HTTP ${status}${message ? `: ${message}` : ""}.`;
}

export interface CreditsView {
	allowance: number;
	renewDay: number | null;
	cycle: Cycle;
	/** What counts against the allowance: Anthropic's figure when there is one, else RemindMe's own. */
	used: number;
	source: "anthropic" | "estimate";
	/** Where the month ends at this rate. */
	pace: number;
	perDay: Array<{ date: string; usd: number }>;
	parts: CostPart[];
	/** RemindMe's own count at list prices, and the day its count starts if that's after the cycle began. */
	estimate: { usd: number; since?: string };
	anthropic: { ok: boolean; error?: string; fetchedAt?: string } | null;
	/** The daily cap from the app options; 0 is none. */
	dailyCap: number;
}

/** Everything the credits page shows. */
export async function creditsView(input: { plan: CreditPlan; spend: SpendLedger; anthropic: AnthropicCosts; dailyCap: number; now?: Date }): Promise<CreditsView> {
	const now = input.now || new Date();
	const cycle = cycleFor(now, input.plan.renewDay);
	const days = input.spend.between(cycle.start, cycle.end);
	const ownTotal = days.reduce((sum, day) => sum + day.usd, 0);
	const ownParts = new Map<string, number>();
	let searches = 0;
	for (const day of days) {
		for (const [model, usd] of Object.entries(day.byModel || {})) ownParts.set(modelLabel(model), (ownParts.get(modelLabel(model)) || 0) + usd);
		searches += day.webSearches || 0;
	}
	const first = input.spend.firstDate();
	const estimate = { usd: ownTotal, ...(first && first > cycle.start ? { since: first } : {}) };

	let anthropic: CreditsView["anthropic"] = null;
	let costs: MonthCosts | undefined;
	if (input.anthropic.configured) {
		try {
			costs = await input.anthropic.since(cycle.start);
			anthropic = { ok: true, fetchedAt: input.anthropic.fetchedAt };
		} catch (error) {
			anthropic = { ok: false, error: error instanceof Error ? error.message : String(error), fetchedAt: input.anthropic.fetchedAt };
		}
	}

	const used = costs ? costs.usd : ownTotal;
	const perDay = dates(cycle.start, Math.min(cycle.day, cycle.days)).map((date) => ({
		date,
		usd: costs ? costs.perDay[date] || 0 : days.find((day) => day.date === date)?.usd || 0,
	}));
	const parts = costs
		? costs.parts
		: [
				...[...ownParts].map(([label, usd]) => ({ label, usd })),
				...(searches ? [{ label: "Web searches", usd: days.reduce((sum, day) => sum + (day.webSearches || 0), 0) * 0.01, count: searches }] : []),
			]
				.filter((part) => part.usd > 0)
				.sort((a, b) => b.usd - a.usd);
	return {
		allowance: input.plan.allowance,
		renewDay: input.plan.renewDay,
		cycle,
		used,
		source: costs ? "anthropic" : "estimate",
		pace: cycle.day > 0 ? (used / cycle.day) * cycle.days : used,
		perDay,
		parts,
		estimate,
		anthropic,
		dailyCap: input.dailyCap,
	};
}

/** `count` local dates from `start` on. */
function dates(start: string, count: number): string[] {
	const [year, month, day] = start.split("-").map(Number);
	return Array.from({ length: Math.max(0, count) }, (_, index) => localDate(new Date(year, month - 1, day + index)));
}
