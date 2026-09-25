import type { EntityCard } from "../harness/entities";

/**
 * An entity the model may name, under a label that is unique within one
 * request. The label is what goes into the decision schema's enum, so the
 * model picks from a closed list instead of inventing an entity_id.
 */
export interface Candidate {
	label: string;
	card: EntityCard;
	score: number;
}

/** Domains a person talks to or asks about. Everything else is a knob. */
const addressableDomains = new Set([
	"light",
	"switch",
	"fan",
	"climate",
	"cover",
	"lock",
	"media_player",
	"vacuum",
	"sensor",
	"binary_sensor",
	"alarm_control_panel",
	"valve",
	"humidifier",
	"water_heater",
	"scene",
	"script",
	"person",
	"weather",
]);

/** Words that map onto a domain even though no entity is named that way. */
const domainWords: Record<string, string[]> = {
	light: ["light", "lights", "lamp", "lamps", "bulb", "bulbs", "lighting"],
	switch: ["switch", "switches", "plug", "plugs", "socket", "outlet"],
	fan: ["fan", "fans", "ventilator"],
	climate: ["thermostat", "heating", "heater", "heat", "ac", "aircon", "climate", "radiator"],
	cover: ["blind", "blinds", "shutter", "shutters", "curtain", "curtains", "cover", "covers", "garage", "shade", "shades", "awning"],
	lock: ["lock", "locks", "unlock", "door", "deadbolt"],
	media_player: ["tv", "television", "speaker", "speakers", "music", "media", "player", "sonos", "chromecast"],
	vacuum: ["vacuum", "vacuuming", "hoover", "hoovering", "robot", "roomba"],
	sensor: ["temperature", "humidity", "power", "energy", "battery", "sensor", "sensors", "co2", "usage"],
	binary_sensor: ["window", "windows", "motion", "occupancy", "leak", "smoke"],
	scene: ["scene", "mood"],
	weather: ["weather", "forecast", "outside"],
};

/**
 * Filler and command words: present in almost every request, so they would
 * match everything. Room and device words are what identify a target.
 */
const stopwords = new Set(
	(
		"a an the and or of to in on at for from by with my our your me i we you it its is are was be " +
		"please can could would will shall should do does did turn switch set make put get give show tell " +
		"what whats what's how hows how's is are there any all every some off up down dim brighten lower raise " +
		"increase decrease percent degrees degree level bit little more less much now currently right just " +
		"again also too then that this these those them they status state check if whether open close closed " +
		"start stop pause play resume toggle activate deactivate enable disable run lock unlock warmer cooler " +
		"hotter colder brighter darker please thanks thank"
	).split(/\s+/),
);

export function words(text: string): string[] {
	return String(text || "")
		.toLowerCase()
		.replace(/[._\-/]+/g, " ")
		.replace(/[^a-z0-9äöüß ]+/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/** The words of a request that could name a device, a room, or a kind of thing. */
export function contentWords(text: string): string[] {
	return words(text).filter((word) => !stopwords.has(word) && !/^\d+$/.test(word));
}

function singular(word: string): string {
	return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function domainsMentioned(tokens: string[]): Set<string> {
	const found = new Set<string>();
	for (const [domain, list] of Object.entries(domainWords))
		if (tokens.some((token) => list.includes(token))) found.add(domain);
	return found;
}

/**
 * Score one entity against the words of a request. Name and area words carry
 * the weight; a domain word ("lights") only nudges, and only when nothing in
 * the name contradicts it. Returns 0 for no relation at all.
 */
export function scoreCandidate(
	card: EntityCard,
	tokens: string[],
	domains: Set<string>,
): number {
	if (!tokens.length) return 0;
	const nameWords = new Set(words(card.name).map(singular));
	const idWords = new Set(words(card.entityId.split(".")[1] || "").map(singular));
	const areaWords = new Set(words(card.area || "").map(singular));
	let score = 0;
	let nameHits = 0;
	for (const token of tokens.map(singular)) {
		if (nameWords.has(token)) {
			score += 10;
			nameHits += 1;
		} else if (areaWords.has(token)) score += 8;
		else if (idWords.has(token)) score += 6;
	}
	const domainHit = domains.has(card.domain);
	if (domainHit) score += score > 0 ? 6 : 3;
	// Every name word matched: this is very likely the device meant.
	if (nameWords.size && nameHits === nameWords.size) score += 8;
	return score;
}

export interface CandidateOptions {
	limit?: number;
}

/**
 * The shortlist of entities a request (plus its recent context) could be
 * about. Ranking happens here, in code, so the model only ever chooses among
 * a dozen plausible names — it never has to spell an entity_id.
 */
export function findCandidates(
	cards: EntityCard[],
	text: string,
	{ limit = 12 }: CandidateOptions = {},
): Candidate[] {
	const tokens = contentWords(text);
	const domains = domainsMentioned(words(text));
	const scored = cards
		.filter((card) => addressableDomains.has(card.domain))
		.map((card) => ({ card, score: scoreCandidate(card, tokens, domains) }))
		.filter((entry) => entry.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score || left.card.name.localeCompare(right.card.name),
		);
	if (!scored.length) return [];
	/*
	 * A strong name match makes the weak domain-only hits noise: "desk lamp"
	 * should offer the desk lamp, not every light in the house. Only when the
	 * request is generic ("turn off the lights") do domain hits make the list.
	 */
	/*
	 * "the lights in the living room" names a kind of thing. When the best
	 * match is of that kind, the thermostat that merely shares the room is
	 * noise on the list, and a small model will happily include it.
	 */
	const pool =
		domains.size && domains.has(scored[0].card.domain)
			? scored.filter((entry) => domains.has(entry.card.domain))
			: scored;
	const best = pool[0].score;
	const floor = best >= 10 ? Math.max(6, Math.floor(best * 0.6)) : 0;
	const kept = pool.filter((entry) => entry.score >= floor).slice(0, limit);
	return labelCandidates(kept);
}

/** Give every candidate a unique, human label: name, then area, then id. */
export function labelCandidates(
	entries: Array<{ card: EntityCard; score: number }>,
): Candidate[] {
	const counts = new Map<string, number>();
	for (const { card } of entries)
		counts.set(card.name.toLowerCase(), (counts.get(card.name.toLowerCase()) || 0) + 1);
	const used = new Set<string>();
	return entries.map(({ card, score }) => {
		let label = card.name.trim() || card.entityId;
		if ((counts.get(card.name.toLowerCase()) || 0) > 1 && card.area)
			label = `${label} (${card.area})`;
		if (used.has(label.toLowerCase())) label = `${label} [${card.entityId}]`;
		used.add(label.toLowerCase());
		return { label, card, score };
	});
}

/** One line per candidate for the decision prompt: label, kind, what it is doing now. */
export function describeCandidate(candidate: Candidate): string {
	const { card } = candidate;
	const bits: string[] = [card.domain.replace("_", " ")];
	if (card.area) bits.push(card.area);
	let state = card.unit ? `${card.state} ${card.unit}` : card.state;
	if (card.domain === "light" && card.state === "on" && card.brightness !== undefined)
		state = `on ${Math.round((card.brightness / 255) * 100)}%`;
	if (card.domain === "climate" && card.targetTemperature !== undefined)
		state = `${card.state}, set to ${card.targetTemperature}°`;
	bits.push(state);
	return `- ${candidate.label} (${bits.join(", ")})`;
}

/**
 * Candidates for a whole turn. The request itself ranks first; the previous
 * user message fills in behind it, so "now turn it off" or "and the floor
 * lamp too" still has the device from the last turn on its shortlist.
 */
export function candidatesForTurn(
	cards: EntityCard[],
	prompt: string,
	history: Array<{ role: string; content: string }> = [],
	limit = 12,
): Candidate[] {
	const primary = findCandidates(cards, prompt, { limit });
	const previous = [...history].reverse().find((turn) => turn.role === "user");
	if (!previous || primary.length >= limit) return primary;
	const secondary = findCandidates(cards, previous.content, { limit });
	const seen = new Set(primary.map((candidate) => candidate.card.entityId));
	const merged = [
		...primary.map(({ card, score }) => ({ card, score })),
		...secondary
			.filter((candidate) => !seen.has(candidate.card.entityId))
			.map(({ card }) => ({ card, score: 0 })),
	].slice(0, limit);
	return labelCandidates(merged);
}
