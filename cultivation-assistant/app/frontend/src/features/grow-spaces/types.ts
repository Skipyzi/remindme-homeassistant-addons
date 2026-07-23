import type {
	EntityMappingInput,
	GrowSpaceCreateInput,
	GrowSpaceType,
} from "../../api/growSpaces";

export const environmentalRoleOptions = [
	["air_temperature", "Air temperature"],
	["canopy_temperature", "Canopy temperature"],
	["root_zone_temperature", "Root-zone temperature"],
	["relative_humidity", "Relative humidity"],
	["co2", "CO₂"],
	["illuminance", "Illuminance"],
	["ppfd", "PAR / PPFD"],
	["water_temperature", "Water temperature"],
	["external_vpd", "External VPD"],
	["power", "Power"],
	["energy", "Energy"],
	["leak_detection", "Leak detection"],
] as const;

export const environmentalRoleLabels = Object.fromEntries(
	environmentalRoleOptions,
) as Record<string, string>;

export type WizardStep = "details" | "mappings" | "review";
export type AreaUnit = "m²" | "ft²";
export type VolumeUnit = "m³" | "ft³";

export interface GrowSpaceDraft {
	name: string;
	description: string;
	location: string;
	spaceType: GrowSpaceType;
	areaValue: string;
	areaUnit: AreaUnit;
	volumeValue: string;
	volumeUnit: VolumeUnit;
	mappings: EntityMappingInput[];
}

export const emptyGrowSpaceDraft: GrowSpaceDraft = {
	name: "",
	description: "",
	location: "",
	spaceType: "tent",
	areaValue: "",
	areaUnit: "m²",
	volumeValue: "",
	volumeUnit: "m³",
	mappings: [],
};

export function draftToCreateInput(
	draft: GrowSpaceDraft,
): GrowSpaceCreateInput {
	return {
		name: draft.name.trim(),
		description: draft.description.trim() || null,
		location: draft.location.trim() || null,
		space_type: draft.spaceType,
		area: draft.areaValue
			? { value: draft.areaValue, unit: draft.areaUnit }
			: null,
		volume: draft.volumeValue
			? { value: draft.volumeValue, unit: draft.volumeUnit }
			: null,
		mappings: draft.mappings,
	};
}
