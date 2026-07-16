export interface HassEntity {
	entity_id: string;
	state: string;
	attributes: Record<string, unknown>;
}

export interface EntityCard {
	entityId: string;
	domain: string;
	name: string;
	state: string;
	available: boolean;
	area?: string;
	capabilities: {
		toggle: boolean;
		brightness: boolean;
		colorTemperature: boolean;
		color: boolean;
	};
	brightness?: number;
	colorTemperature?: number;
	rgbColor?: number[];
	unit?: string;
	attributes: Record<string, unknown>;
}

export function normalizeEntity(entity: HassEntity): EntityCard {
	const [domain] = entity.entity_id.split(".");
	const modes = Array.isArray(entity.attributes.supported_color_modes)
		? entity.attributes.supported_color_modes.map(String)
		: [];
	return {
		entityId: entity.entity_id,
		domain,
		name: String(entity.attributes.friendly_name || entity.entity_id),
		state: entity.state,
		available: entity.state !== "unavailable" && entity.state !== "unknown",
		area:
			typeof entity.attributes.area_name === "string"
				? entity.attributes.area_name
				: undefined,
		capabilities: {
			toggle: ["light", "switch", "fan", "media_player"].includes(domain),
			brightness: domain === "light" && modes.some((mode) => mode !== "onoff"),
			colorTemperature:
				domain === "light" &&
				modes.some((mode) => ["color_temp", "rgbww", "rgbw"].includes(mode)),
			color:
				domain === "light" &&
				modes.some((mode) =>
					["rgb", "rgbw", "rgbww", "hs", "xy"].includes(mode),
				),
		},
		brightness:
			typeof entity.attributes.brightness === "number"
				? entity.attributes.brightness
				: undefined,
		colorTemperature:
			typeof entity.attributes.color_temp_kelvin === "number"
				? entity.attributes.color_temp_kelvin
				: undefined,
		rgbColor: Array.isArray(entity.attributes.rgb_color)
			? entity.attributes.rgb_color.map(Number)
			: undefined,
		unit:
			typeof entity.attributes.unit_of_measurement === "string"
				? entity.attributes.unit_of_measurement
				: undefined,
		attributes: entity.attributes,
	};
}
