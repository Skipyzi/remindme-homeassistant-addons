import type { EntityCard } from "./entities";

export type EntityAction = "turn_on" | "turn_off" | "toggle" | "brightness" | "color_temperature" | "rgb_color";

export interface ValidatedEntityAction {
	domain: string;
	service: string;
	entityId: string;
	serviceData: Record<string, unknown>;
	requiresConfirmation: boolean;
}

const sensitiveDomains = new Set(["lock", "alarm_control_panel", "cover", "valve"]);
const immediateDomains = new Set(["light", "switch", "fan", "media_player"]);

function boundedNumber(value: unknown, minimum: number, maximum: number, name: string): number {
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
	if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entity.entityId)) throw new Error("Invalid entity ID");
	if (!entity.available) throw new Error(`${entity.name} is unavailable`);
	const serviceData: Record<string, unknown> = {};
	let service = action;
	if (["turn_on", "turn_off", "toggle"].includes(action)) {
		if (!entity.capabilities.toggle) throw new Error(`${entity.name} cannot be toggled`);
	} else if (action === "brightness") {
		if (!entity.capabilities.brightness) throw new Error(`${entity.name} has no brightness control`);
		service = "turn_on";
		serviceData.brightness = boundedNumber(value, 0, 255, "Brightness");
	} else if (action === "color_temperature") {
		if (!entity.capabilities.colorTemperature) throw new Error(`${entity.name} has no color temperature control`);
		service = "turn_on";
		serviceData.color_temp_kelvin = boundedNumber(value, 1_000, 12_000, "Color temperature");
	} else if (action === "rgb_color") {
		if (!entity.capabilities.color || !Array.isArray(value) || value.length !== 3)
			throw new Error(`${entity.name} has no RGB color control`);
		service = "turn_on";
		serviceData.rgb_color = value.map((component) => boundedNumber(component, 0, 255, "RGB component"));
	}
	return {
		domain: entity.domain,
		service,
		entityId: entity.entityId,
		serviceData,
		requiresConfirmation: sensitiveDomains.has(entity.domain) || !immediateDomains.has(entity.domain),
	};
}
