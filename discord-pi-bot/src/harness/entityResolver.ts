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

/**
 * Per-device configuration and diagnostic knobs. A Zigbee bulb typically
 * exposes six or more of these ("Identify", "On level", "Power-on behavior",
 * "Firmware", transition times), and they match the device name just as well
 * as the bulb itself does. Nobody asks about them by name, so they are
 * excluded unless a caller opts in — otherwise asking for one lamp returns a
 * dozen rows and spends the context window on knobs.
 *
 * Home Assistant marks these with entity_category in the entity registry, but
 * /api/states does not expose it, so the domain is the signal available here.
 */
const configDomains = new Set([
	"button",
	"number",
	"select",
	"update",
	"text",
	"event",
	"image",
	"date",
	"time",
	"datetime",
	"siren",
]);

/** Domains a person actually asks about, ranked above the rest on ties. */
const primaryDomains = new Set([
	"light",
	"switch",
	"climate",
	"cover",
	"lock",
	"fan",
	"media_player",
	"vacuum",
	"binary_sensor",
	"sensor",
]);

export interface ResolveOptions {
	query?: string;
	domain?: string;
	limit?: number;
	/** Include per-device config/diagnostic entities. Off by default. */
	includeConfig?: boolean;
}

/**
 * Filter and rank entities in harness code so the prompt receives a short,
 * relevant list instead of the whole registry.
 */
export function resolveEntities(
	cards: EntityCard[],
	{ query = "", domain = "", limit = 12, includeConfig = false }: ResolveOptions = {},
): EntityCard[] {
	let scoped = domain ? cards.filter((card) => card.domain === domain) : cards;
	// An explicit domain request is already specific, so honour it verbatim.
	if (!includeConfig && !domain)
		scoped = scoped.filter((card) => !configDomains.has(card.domain));
	if (!query.trim()) return scoped.slice(0, limit);

	const ranked = scoped
		.map((card) => ({
			card,
			// Nudge primary domains ahead of anything scoring equally.
			score: scoreEntity(card, query) + (primaryDomains.has(card.domain) ? 5 : 0),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);
	if (!ranked.length) return [];

	/*
	 * When something matches the query outright, return only the strong
	 * matches. "pc lamp" should answer with the PC lamp, not also every other
	 * lamp that happens to share one word.
	 */
	const best = ranked[0].score;
	const cutoff = best >= 80 ? 80 : 0;
	return ranked
		.filter((entry) => entry.score >= cutoff)
		.slice(0, limit)
		.map((entry) => entry.card);
}
