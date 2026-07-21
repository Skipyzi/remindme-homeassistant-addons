import { estimateTokens } from "./modelPhases";

export interface HistoryTurn {
	role: "user" | "assistant";
	content: string;
}

/**
 * Below this there is no room for a useful turn, and a token or two of
 * conversation is worse than none: it reads as a fragment the model then
 * tries to make sense of.
 */
const MIN_BUDGET_TOKENS = 256;

/** Roughly what the chat template spends framing one turn. */
const TURN_OVERHEAD_TOKENS = 4;

/** Turns beyond this cannot fit any real context window; stop counting. */
const MAX_TURNS = 200;

/**
 * The transcript as it arrives from the browser, reduced to what can be
 * trusted: two known roles, non-empty string content, nothing else.
 */
export function validateHistory(value: unknown): HistoryTurn[] {
	if (!Array.isArray(value)) return [];
	const turns: HistoryTurn[] = [];
	for (const item of value.slice(-MAX_TURNS)) {
		const role = (item as { role?: unknown })?.role;
		const content = (item as { content?: unknown })?.content;
		if (role !== "user" && role !== "assistant") continue;
		if (typeof content !== "string" || !content.trim()) continue;
		turns.push({ role, content });
	}
	return turns;
}

/**
 * The tail of the conversation that fits the space left once the system
 * prompt, the tool schemas, the new question and the reply the model has
 * yet to write have all been paid for.
 *
 * Oldest turns go first. The context window is a budget, and recency is
 * what a follow-up like "continue the coding" actually depends on.
 */
export function fitHistory(
	history: HistoryTurn[],
	budgetTokens: number,
): HistoryTurn[] {
	if (budgetTokens < MIN_BUDGET_TOKENS) return [];
	const kept: HistoryTurn[] = [];
	let spent = 0;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const turn = history[index];
		const cost = estimateTokens(turn.content) + TURN_OVERHEAD_TOKENS;
		if (spent + cost <= budgetTokens) {
			kept.push(turn);
			spent += cost;
			continue;
		}
		/*
		 * One long answer can outgrow the whole budget on its own. Keeping
		 * its tail beats dropping it: the message that ran out of tokens is
		 * exactly the one a follow-up is about, and it is the end of it that
		 * the model has to pick up from.
		 */
		if (!kept.length) {
			const room = (budgetTokens - TURN_OVERHEAD_TOKENS) * 4;
			if (room > 0)
				kept.push({ role: turn.role, content: `…${turn.content.slice(-room)}` });
		}
		break;
	}
	return kept.reverse();
}
