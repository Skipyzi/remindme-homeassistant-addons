import type { EntityCard } from "./entities";

/**
 * The slice of an entity the model actually needs to reason about. The full
 * EntityCard carries the raw Home Assistant `attributes` record, which is
 * unbounded and routinely larger than the whole rest of the prompt — it goes
 * to the UI, never into the context window.
 */
export interface CompactEntity {
	id: string;
	name: string;
	state: string;
	unit?: string;
	area?: string;
}

export function compactEntity(card: EntityCard): CompactEntity {
	return {
		id: card.entityId,
		name: card.name,
		state: card.unit ? `${card.state} ${card.unit}` : card.state,
		unit: card.unit,
		area: card.area,
	};
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Score a candidate against a free-text query such as "kitchen light".
 * Returns 0 for no match. Deliberately simple: exact > prefix > all-terms >
 * some-terms, with area and domain treated as matchable text so "upstairs
 * lights" resolves without the model having seen the entity list.
 */
export function scoreEntity(card: EntityCard, query: string): number {
	const needle = normalize(query);
	if (!needle) return 0;
	const haystacks = [
		normalize(card.name),
		normalize(card.entityId),
		normalize(card.area || ""),
		card.domain,
	].filter(Boolean);
	const joined = haystacks.join(" ");
	if (haystacks.some((value) => value === needle)) return 100;
	if (haystacks.some((value) => value.startsWith(needle))) return 80;
	const terms = needle.split(" ");
	const hits = terms.filter((term) => joined.includes(term)).length;
	if (!hits) return 0;
	if (hits === terms.length) return 60 + terms.length;
	return Math.round((hits / terms.length) * 40);
}

export interface ResolveOptions {
	query?: string;
	domain?: string;
	limit?: number;
}

/**
 * Filter and rank entities in harness code so the prompt receives a short,
 * relevant list instead of the whole registry.
 */
export function resolveEntities(
	cards: EntityCard[],
	{ query = "", domain = "", limit = 12 }: ResolveOptions = {},
): EntityCard[] {
	const scoped = domain
		? cards.filter((card) => card.domain === domain)
		: cards;
	if (!query.trim()) return scoped.slice(0, limit);
	return scoped
		.map((card) => ({ card, score: scoreEntity(card, query) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map((entry) => entry.card);
}
