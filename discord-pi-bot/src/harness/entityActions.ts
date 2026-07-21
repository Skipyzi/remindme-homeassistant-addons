import type { EntityCard } from "./entities";

export type EntityAction =
	| "turn_on"
	| "turn_off"
	| "toggle"
	| "brightness"
	| "color_temperature"
	| "rgb_color"
	| "set_position"
	| "open_cover"
	| "close_cover"
	| "set_temperature"
	| "lock"
	| "unlock"
	| "set_fan_speed"
	| "set_hvac_mode";

export interface ValidatedEntityAction {
	domain: string;
	service: string;
	entityId: string;
	serviceData: Record<string, unknown>;
	requiresConfirmation: boolean;
	/** Destructive actions render rust and are called out on the confirm step. */
	destructive: boolean;
}

const sensitiveDomains = new Set([
	"lock",
	"alarm_control_panel",
	"cover",
	"valve",
]);
const immediateDomains = new Set([
	"light",
	"switch",
	"fan",
	"media_player",
	"climate",
]);
/** Actions that reduce physical security, regardless of domain. */
const destructiveActions = new Set(["unlock", "open_cover"]);

function boundedNumber(
	value: unknown,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const number = Number(value);
	if (!Number.isFinite(number) || number < minimum || number > maximum)
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	return number;
}

export function validateEntityAction(
	entity: EntityCard,
	action: EntityAction,
	value?: unknown,
): ValidatedEntityAction {
	if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entity.entityId))
		throw new Error("Invalid entity ID");
	if (!entity.available) throw new Error(`${entity.name} is unavailable`);
	const serviceData: Record<string, unknown> = {};
	let service: string = action;

	if (["turn_on", "turn_off", "toggle"].includes(action)) {
		if (!entity.capabilities.toggle)
			throw new Error(`${entity.name} cannot be toggled`);
	} else if (action === "brightness") {
		if (!entity.capabilities.brightness)
			throw new Error(`${entity.name} has no brightness control`);
		service = "turn_on";
		serviceData.brightness = boundedNumber(value, 0, 255, "Brightness");
	} else if (action === "color_temperature") {
		if (!entity.capabilities.colorTemperature)
			throw new Error(`${entity.name} has no color temperature control`);
		service = "turn_on";
		serviceData.color_temp_kelvin = boundedNumber(
			value,
			1_000,
			12_000,
			"Color temperature",
		);
	} else if (action === "rgb_color") {
		if (!entity.capabilities.color || !Array.isArray(value) || value.length !== 3)
			throw new Error(`${entity.name} has no RGB color control`);
		service = "turn_on";
		serviceData.rgb_color = value.map((component) =>
			boundedNumber(component, 0, 255, "RGB component"),
		);
	} else if (action === "set_position") {
		if (!entity.capabilities.position)
			throw new Error(`${entity.name} has no position control`);
		service = "set_cover_position";
		serviceData.position = boundedNumber(value, 0, 100, "Position");
	} else if (action === "open_cover" || action === "close_cover") {
		if (entity.domain !== "cover")
			throw new Error(`${entity.name} is not a cover`);
	} else if (action === "set_temperature") {
		if (!entity.capabilities.targetTemperature)
			throw new Error(`${entity.name} has no target temperature`);
		serviceData.temperature = boundedNumber(
			value,
			entity.minTemperature ?? 4,
			entity.maxTemperature ?? 35,
			"Target temperature",
		);
	} else if (action === "lock" || action === "unlock") {
		if (!entity.capabilities.lock) throw new Error(`${entity.name} is not a lock`);
	} else if (action === "set_hvac_mode") {
		if (entity.domain !== "climate")
			throw new Error(`${entity.name} is not a thermostat`);
		// Only the modes every climate entity understands; anything device
		// specific belongs behind a capability check.
		const mode = String(value);
		if (!["off", "heat", "cool", "auto", "heat_cool"].includes(mode))
			throw new Error("Unsupported HVAC mode");
		serviceData.hvac_mode = mode;
	} else if (action === "set_fan_speed") {
		if (entity.domain !== "fan") throw new Error(`${entity.name} is not a fan`);
		service = "set_percentage";
		serviceData.percentage = boundedNumber(value, 0, 100, "Fan speed");
	}

	const destructive = destructiveActions.has(action);
	return {
		domain: entity.domain,
		service,
		entityId: entity.entityId,
		serviceData,
		// Anything that opens the house, plus any domain we do not explicitly
		// treat as safe to fire immediately.
		requiresConfirmation:
			destructive ||
			sensitiveDomains.has(entity.domain) ||
			!immediateDomains.has(entity.domain),
		destructive,
	};
}
