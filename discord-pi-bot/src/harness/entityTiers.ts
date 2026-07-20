import type { EntityCard } from "./entities";

/**
 * Card shape is chosen by what you can *do* with an entity, not by its domain.
 * - controllable: full card plus an action row
 * - readout:      full card, no actions, value as hero
 * - binary:       state pill and dwell time only
 * - compact:      one-line row, used for any result set of 3 or more
 */
export type EntityTier = "controllable" | "readout" | "binary" | "compact";

/**
 * How a readout's history should be drawn. Trend is the question for things
 * that drift (temperature, power), so those get a sparkline. Level is the
 * question for things with hard 0-100 bounds (humidity, battery), so those get
 * a filled bar. Booleans get neither — a sparkline of a boolean is noise.
 */
export type MeasurementShape = "sparkline" | "bar" | "none";

const controllableDomains = new Set([
	"light",
	"lock",
	"climate",
	"cover",
	"switch",
	"fan",
]);

const binaryDomains = new Set(["binary_sensor"]);

/** device_class values that are bounded 0-100 and so read as a level. */
const barClasses = new Set(["humidity", "battery", "moisture"]);
/** device_class values where the trend matters more than the instant value. */
const sparklineClasses = new Set([
	"temperature",
	"power",
	"energy",
	"current",
	"voltage",
	"pressure",
	"illuminance",
]);

export function deviceClass(card: EntityCard): string {
	const value = card.attributes.device_class;
	return typeof value === "string" ? value : "";
}

export function measurementShape(card: EntityCard): MeasurementShape {
	if (card.domain === "binary_sensor") return "none";
	const kind = deviceClass(card);
	if (barClasses.has(kind)) return "bar";
	if (sparklineClasses.has(kind)) return "sparkline";
	// Percentage-unit sensors are bounded even without a device_class.
	if (card.unit === "%") return "bar";
	if (card.domain === "sensor" && card.unit) return "sparkline";
	return "none";
}

export function classifyEntity(card: EntityCard): EntityTier {
	if (binaryDomains.has(card.domain)) return "binary";
	if (controllableDomains.has(card.domain)) return "controllable";
	return "readout";
}

/**
 * Tier for a whole result set. Three or more entities collapse to compact rows
 * regardless of what they individually are.
 */
export function classifyResultSet(cards: EntityCard[]): EntityTier[] {
	if (cards.length >= 3) return cards.map(() => "compact");
	return cards.map(classifyEntity);
}
