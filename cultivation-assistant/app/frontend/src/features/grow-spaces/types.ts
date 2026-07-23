import type {
	DimensionUnit,
	EntityMappingInput,
	GrowSpaceCreateInput,
	GrowSpaceType,
	LegacyGrowSpaceType,
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

export const growSpaceTypeOptions: readonly [GrowSpaceType, string][] = [
	["tent", "Indoor Tent"],
	["greenhouse", "Greenhouse"],
	["outdoor", "Outdoor"],
	["room", "Room"],
];

export const growSpaceTypeLabels: Record<string, string> = Object.fromEntries(
	growSpaceTypeOptions,
);

export type WizardStep = "details" | "mappings" | "review";
export type EditableGrowSpaceType = GrowSpaceType | LegacyGrowSpaceType;

export interface GrowSpaceDetailsDraft {
	name: string;
	description: string;
	location: string;
	spaceType: EditableGrowSpaceType;
	length: string;
	width: string;
	height: string;
	dimensionUnit: DimensionUnit;
	active: boolean;
}

export interface GrowSpaceDraft extends GrowSpaceDetailsDraft {
	spaceType: GrowSpaceType;
	mappings: EntityMappingInput[];
}

export const emptyGrowSpaceDetailsDraft: GrowSpaceDetailsDraft = {
	name: "",
	description: "",
	location: "",
	spaceType: "tent",
	length: "",
	width: "",
	height: "",
	dimensionUnit: "cm",
	active: true,
};

export const emptyGrowSpaceDraft: GrowSpaceDraft = {
	...emptyGrowSpaceDetailsDraft,
	spaceType: "tent",
	mappings: [],
};

export function validateGrowSpaceDetails(draft: GrowSpaceDetailsDraft) {
	if (!draft.name.trim()) return "Name is required before continuing.";
	if (!draft.length.trim()) return "Length is required before continuing.";
	if (!draft.width.trim()) return "Width is required before continuing.";
	if (draft.spaceType !== "outdoor" && !draft.height.trim()) {
		return "Height is required for enclosed grow spaces.";
	}
	for (const [label, value] of [
		["Length", draft.length],
		["Width", draft.width],
		["Height", draft.height],
	] as const) {
		if (value.trim() && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
			return `${label} must be a positive number.`;
		}
	}
	return null;
}

export function draftToCreateInput(
	draft: GrowSpaceDraft,
): GrowSpaceCreateInput {
	return {
		name: draft.name.trim(),
		description: draft.description.trim() || null,
		location: draft.location.trim() || null,
		space_type: draft.spaceType,
		dimensions: {
			length: draft.length,
			width: draft.width,
			height: draft.height.trim() || null,
			unit: draft.dimensionUnit,
		},
		mappings: draft.mappings,
	};
}
