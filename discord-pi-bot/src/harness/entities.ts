import {
	classifyEntity,
	measurementShape,
	type EntityTier,
	type MeasurementShape,
} from "./entityTiers";

export interface HassEntity {
	entity_id: string;
	state: string;
	attributes: Record<string, unknown>;
	last_changed?: string;
	last_updated?: string;
}

export interface EntityCard {
	entityId: string;
	domain: string;
	name: string;
	state: string;
	available: boolean;
	area?: string;
	tier: EntityTier;
	measurement: MeasurementShape;
	deviceClass?: string;
	/** ISO timestamp behind every card's meta-line time reference. */
	lastChanged?: string;
	capabilities: {
		toggle: boolean;
		brightness: boolean;
		colorTemperature: boolean;
		color: boolean;
		position: boolean;
		targetTemperature: boolean;
		lock: boolean;
	};
	brightness?: number;
	colorTemperature?: number;
	rgbColor?: number[];
	/** cover: 0-100 open percentage */
	position?: number;
	/** climate: what it is now versus what it is aiming for */
	currentTemperature?: number;
	targetTemperature?: number;
	minTemperature?: number;
	maxTemperature?: number;
	temperatureStep?: number;
	/** switch: live draw, surfaced instead of a bare on/off */
	power?: number;
	/** fan: 0-100 with the step the device actually honours */
	fanPercentage?: number;
	fanStep?: number;
	presetMode?: string;
	oscillating?: boolean;
	/** climate: what it is doing now, distinct from the mode it is set to */
	hvacAction?: string;
	/** lock/sensor-bearing devices: reported battery level */
	batteryLevel?: number;
	numericState?: number;
	unit?: string;
	attributes: Record<string, unknown>;
}

function numberAttribute(
	attributes: Record<string, unknown>,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = attributes[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function normalizeEntity(entity: HassEntity): EntityCard {
	const [domain] = entity.entity_id.split(".");
	const attributes = entity.attributes;
	const modes = Array.isArray(attributes.supported_color_modes)
		? attributes.supported_color_modes.map(String)
		: [];
	const deviceClass =
		typeof attributes.device_class === "string"
			? attributes.device_class
			: undefined;
	const numeric = Number(entity.state);
	const card: EntityCard = {
		entityId: entity.entity_id,
		domain,
		name: String(attributes.friendly_name || entity.entity_id),
		state: entity.state,
		available: entity.state !== "unavailable" && entity.state !== "unknown",
		area: typeof attributes.area_name === "string" ? attributes.area_name : undefined,
		tier: "readout",
		measurement: "none",
		deviceClass,
		lastChanged: entity.last_changed || entity.last_updated,
		capabilities: {
			toggle: ["light", "switch", "fan", "media_player"].includes(domain),
			brightness: domain === "light" && modes.some((mode) => mode !== "onoff"),
			colorTemperature:
				domain === "light" &&
				modes.some((mode) => ["color_temp", "rgbww", "rgbw"].includes(mode)),
			color:
				domain === "light" &&
				modes.some((mode) => ["rgb", "rgbw", "rgbww", "hs", "xy"].includes(mode)),
			position: domain === "cover" && typeof attributes.current_position === "number",
			targetTemperature: domain === "climate",
			lock: domain === "lock",
		},
		brightness: numberAttribute(attributes, "brightness"),
		colorTemperature: numberAttribute(attributes, "color_temp_kelvin"),
		rgbColor: Array.isArray(attributes.rgb_color)
			? attributes.rgb_color.map(Number)
			: undefined,
		position: numberAttribute(attributes, "current_position"),
		currentTemperature: numberAttribute(attributes, "current_temperature"),
		targetTemperature: numberAttribute(attributes, "temperature", "target_temp_high"),
		minTemperature: numberAttribute(attributes, "min_temp"),
		maxTemperature: numberAttribute(attributes, "max_temp"),
		temperatureStep: numberAttribute(attributes, "target_temp_step"),
		power: numberAttribute(attributes, "current_power_w", "power"),
		fanPercentage: numberAttribute(attributes, "percentage"),
		fanStep: numberAttribute(attributes, "percentage_step"),
		presetMode:
			typeof attributes.preset_mode === "string"
				? attributes.preset_mode
				: undefined,
		oscillating:
			typeof attributes.oscillating === "boolean"
				? attributes.oscillating
				: undefined,
		hvacAction:
			typeof attributes.hvac_action === "string"
				? attributes.hvac_action
				: undefined,
		batteryLevel: numberAttribute(attributes, "battery_level", "battery"),
		numericState: Number.isFinite(numeric) && entity.state.trim() ? numeric : undefined,
		unit:
			typeof attributes.unit_of_measurement === "string"
				? attributes.unit_of_measurement
				: undefined,
		attributes,
	};
	card.tier = classifyEntity(card);
	card.measurement = measurementShape(card);
	return card;
}
