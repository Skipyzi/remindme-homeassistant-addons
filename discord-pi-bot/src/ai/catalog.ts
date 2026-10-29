import type { AssistantId } from "./settings";
import { costOf } from "./spend";

/**
 * The current models in plain words, for the console's model table. Smarts
 * and speed are a rough guide (1 to 4), not a benchmark; cost comes from the
 * list prices the daily budget already uses.
 */
export interface CatalogEntry {
	id: string;
	name: string;
	/** What it's good for, in one line. */
	what: string;
	smarts: 1 | 2 | 3 | 4;
	speed: 1 | 2 | 3 | 4;
	/** On a subscription: how much of the plan it uses, 1 light to 3 heavy. */
	plan?: 1 | 2 | 3;
	recommended?: boolean;
}

const CLAUDE: CatalogEntry[] = [
	{ id: "claude-fable-5-1", name: "Claude Fable 5.1", what: "Anthropic's most capable. For the hardest research and long jobs.", smarts: 4, speed: 2 },
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", what: "Careful and thorough. Good at long jobs and tricky questions.", smarts: 3, speed: 3, recommended: true },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", what: "Nearly as good for everyday things, at half Opus's price.", smarts: 2, speed: 3 },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", what: "Fast and very cheap. Quick questions and the house.", smarts: 1, speed: 4 },
];

/* OpenAI's tiers as reported at launch: Astra on top, Sol for everyday work, Luna light and fast. */
const GPT: CatalogEntry[] = [
	{ id: "gpt-6-astra", name: "GPT-6 Astra", what: "OpenAI's top tier, for the hardest jobs and research.", smarts: 4, speed: 2, plan: 3 },
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", what: "OpenAI's everyday tier, good with tools and jobs.", smarts: 3, speed: 3, plan: 2, recommended: true },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", what: "Fast and light. Quick questions and the house.", smarts: 1, speed: 4, plan: 1 },
];

/* Claude Code names models by family and runs the newest of each. */
const CLAUDE_CODE: CatalogEntry[] = [
	{ id: "opus", name: "Opus", what: "Careful and thorough; uses your plan up faster.", smarts: 3, speed: 3, plan: 3 },
	{ id: "sonnet", name: "Sonnet", what: "Everyday questions and jobs.", smarts: 2, speed: 3, plan: 2, recommended: true },
	{ id: "haiku", name: "Haiku", what: "Fast and light on your plan.", smarts: 1, speed: 4, plan: 1 },
];

/** How a provider's use is paid for, which decides the cost column. */
export type Billing = "credits" | "plan" | "unknown";

/** A provider's current models, best first, without its older ones. */
export const catalogEntries = (provider: AssistantId): CatalogEntry[] => catalogFor(provider).entries;

function catalogFor(provider: AssistantId): { entries: CatalogEntry[]; billing: Billing } {
	switch (provider) {
		case "claude":
			return { entries: CLAUDE, billing: "credits" };
		case "chatgpt":
		case "codex":
			return { entries: GPT, billing: "plan" };
		case "claude-code":
			return { entries: CLAUDE_CODE, billing: "plan" };
		case "openai":
			// OpenAI's API publishes no prices the app can read, so no cost is shown.
			return { entries: GPT.map(({ plan: _plan, ...entry }) => entry), billing: "unknown" };
		default:
			return { entries: [], billing: "unknown" };
	}
}

/*
 * A typical answer: a couple of rounds with the tools, most of the prompt
 * read from the cache. Measured roughly from RemindMe's own turns.
 */
const TYPICAL_ANSWER = { inputTokens: 3_000, outputTokens: 700, cacheReadTokens: 24_000, cacheWriteTokens: 2_000 };

export interface ModelRow extends CatalogEntry {
	/** US dollars for a typical answer, where the price is known. */
	perAnswerUsd?: number;
	/** How many typical answers the daily budget covers. */
	perDay?: number;
}

export interface ModelTable {
	billing: Billing;
	/** The daily budget in US dollars, for the "on $x a day" column. */
	budget: number;
	/** The current models this provider offers, best first. */
	featured: ModelRow[];
	/** Everything else it lists: older versions and models without a description. */
	others: string[];
}

/** The table for one provider, from the models it lists right now. */
export function modelTable(provider: AssistantId, listed: string[], budget: number): ModelTable {
	const { entries, billing } = catalogFor(provider);
	const available = new Set(listed);
	const featured: ModelRow[] = entries
		.filter((entry) => available.has(entry.id))
		.map((entry) => {
			const perAnswerUsd = billing === "credits" ? costOf(entry.id, TYPICAL_ANSWER) : undefined;
			return { ...entry, ...(perAnswerUsd !== undefined ? { perAnswerUsd, perDay: budget > 0 ? Math.floor(budget / perAnswerUsd) : undefined } : {}) };
		});
	const shown = new Set(featured.map((entry) => entry.id));
	return { billing, budget, featured, others: listed.filter((id) => !shown.has(id)) };
}
