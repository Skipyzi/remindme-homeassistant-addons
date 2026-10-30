import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Usage } from "./types";

/** US dollars per million tokens. */
interface Price {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/*
 * Anthropic's list prices, for the daily cap and the monthly credits. Other providers publish no
 * prices through their APIs, so their usage is counted in tokens only.
 */
const PRICES: Record<string, Price> = {
	"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Claude's web search: $10 per 1,000 searches, on top of the tokens. */
export const SEARCH_USD = 0.01;

function tokenCost(model: string, usage: Usage): number | undefined {
	const price = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
	if (!price) return undefined;
	return (
		(usage.inputTokens * price.input +
			usage.outputTokens * price.output +
			usage.cacheReadTokens * price.cacheRead +
			usage.cacheWriteTokens * price.cacheWrite) /
		1_000_000
	);
}

export function costOf(model: string, usage: Usage): number | undefined {
	const tokens = tokenCost(model, usage);
	return tokens === undefined ? undefined : tokens + (usage.webSearches || 0) * SEARCH_USD;
}

export interface DaySpend {
	date: string;
	usd: number;
	inputTokens: number;
	outputTokens: number;
	runs: number;
	/** Some of today's runs used a model without a known price. */
	unpriced: boolean;
	/** Priced spend per model, tokens only. */
	byModel?: Record<string, number>;
	webSearches?: number;
}

export function localDate(at = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function fresh(date: string): DaySpend {
	return { date, usd: 0, inputTokens: 0, outputTokens: 0, runs: 0, unpriced: false };
}

/** Enough days for the longest credit month and the one before it. */
const KEEP_DAYS = 70;

/** AI spend per day, persisted so a restart doesn't reset the daily cap, and kept a while for the monthly credits. */
export class SpendLedger {
	/** Oldest first; the last one is the newest day with any use. */
	private days: DaySpend[] = [];

	constructor(private readonly path = process.env.SPEND_DATA_PATH || "./data/spend.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as { days?: DaySpend[] } & Partial<DaySpend>;
			// Before 4.32 the file held today alone.
			const days = Array.isArray(saved?.days) ? saved.days : saved?.date ? [saved as DaySpend] : [];
			this.days = days.filter((day) => typeof day?.date === "string").map((day) => ({ ...fresh(day.date), ...day })).sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP_DAYS);
		} catch {
			// Missing or unreadable: start at zero.
		}
	}

	today(now = new Date()): DaySpend {
		const date = localDate(now);
		const last = this.days[this.days.length - 1];
		if (last?.date === date) return last;
		const day = fresh(date);
		this.days.push(day);
		if (this.days.length > KEEP_DAYS) this.days.splice(0, this.days.length - KEEP_DAYS);
		return day;
	}

	/** The days from `start` up to but not including `end` (local dates, YYYY-MM-DD), oldest first. */
	between(start: string, end: string): DaySpend[] {
		return this.days.filter((day) => day.date >= start && day.date < end);
	}

	/** The first day this ledger knows about. */
	firstDate(): string | undefined {
		return this.days[0]?.date;
	}

	async record(model: string, usage: Usage, now = new Date()): Promise<number | undefined> {
		const day = this.today(now);
		const tokens = tokenCost(model, usage);
		const cost = costOf(model, usage);
		day.runs += 1;
		day.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		day.outputTokens += usage.outputTokens;
		if (cost === undefined) day.unpriced = true;
		else {
			day.usd += cost;
			const name = model.replace(/-\d{8}$/, "");
			day.byModel = { ...day.byModel, [name]: (day.byModel?.[name] || 0) + (tokens || 0) };
			if (usage.webSearches) day.webSearches = (day.webSearches || 0) + usage.webSearches;
		}
		try {
			await mkdir(dirname(this.path), { recursive: true });
			await writeFile(`${this.path}.tmp`, JSON.stringify({ days: this.days }));
			await rename(`${this.path}.tmp`, this.path);
		} catch (error) {
			console.warn("Could not save the AI spend:", error instanceof Error ? error.message : error);
		}
		return cost;
	}

	/** True once today's priced spend reaches the limit. A limit of 0 means no cap. */
	overBudget(limitUsd: number, now = new Date()): boolean {
		return limitUsd > 0 && this.today(now).usd >= limitUsd;
	}
}
