import type {
	GeometryInput,
	ReservoirCreateInput,
	ReservoirType,
	GeometryShape,
} from "../../api/reservoirs";
import type { DimensionUnit } from "../grow-spaces/dimensions";
import type { GeometryDraft } from "./geometry";

export const reservoirTypeOptions: readonly [ReservoirType, string][] = [
	["autopot_reservoir", "AutoPot reservoir"],
	["dwc_bucket", "DWC bucket"],
	["rdwc_control_reservoir", "RDWC control reservoir"],
	["irrigation_supply_tank", "Irrigation supply tank"],
	["mixing_tank", "Mixing tank"],
	["top_off_tank", "Top-off tank"],
	["ro_source_water_tank", "RO / source-water tank"],
	["runoff_waste_tank", "Runoff / waste tank"],
	["custom_reservoir", "Custom reservoir"],
];

export const reservoirTypeLabels: Record<string, string> = Object.fromEntries(
	reservoirTypeOptions,
);

export const geometryShapeOptions: readonly [GeometryShape, string][] = [
	["rectangular", "Rectangular"],
	["vertical_cylinder", "Vertical cylinder"],
	["horizontal_cylinder", "Horizontal cylinder"],
	["custom_calibration_table", "Custom calibration table"],
];

export const geometryShapeLabels: Record<string, string> = Object.fromEntries(
	geometryShapeOptions,
);

export const reservoirRoleOptions: readonly [string, string][] = [
	["level_percentage", "Level percentage"],
	["liquid_depth", "Liquid depth"],
	["distance_to_liquid", "Distance to liquid"],
	["weight", "Weight"],
	["water_temperature", "Water temperature"],
	["flow", "Flow rate"],
	["low_level", "Low level"],
	["empty", "Empty"],
	["high_level", "High level"],
	["overflow", "Overflow"],
	["leak", "Leak"],
	["pump", "Pump"],
	["fill_valve", "Fill valve"],
];

export const reservoirRoleLabels: Record<string, string> = Object.fromEntries(
	reservoirRoleOptions,
);

export type WizardStep = "details" | "geometry" | "review";

export interface ReservoirDraft {
	name: string;
	reservoirType: ReservoirType;
	primaryGrowSpaceId: string;
	capacityLiters: string;
	usableCapacityLiters: string;
	minimumSafeVolumeLiters: string;
	refillThresholdLiters: string;
	overflowThresholdLiters: string;
	geometry: GeometryDraft;
	active: boolean;
}

export const emptyReservoirDraft: ReservoirDraft = {
	name: "",
	reservoirType: "mixing_tank",
	primaryGrowSpaceId: "",
	capacityLiters: "",
	usableCapacityLiters: "",
	minimumSafeVolumeLiters: "",
	refillThresholdLiters: "",
	overflowThresholdLiters: "",
	geometry: {
		shape: "rectangular",
		unit: "cm",
		length: "",
		width: "",
		height: "",
		diameter: "",
	},
	active: true,
};

function positiveOrZero(value: string): number | null {
	if (!value.trim()) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
}

/**
 * Validate the editable details of a reservoir draft. Returns a human-readable
 * error string or null when the draft is acceptable. Mirrors the backend
 * Pydantic validators plus a couple of optional-threshold sanity checks.
 */
export function validateReservoirDetails(draft: ReservoirDraft): string | null {
	if (!draft.name.trim()) return "Name is required before continuing.";

	const capacity = Number(draft.capacityLiters);
	if (!Number.isFinite(capacity) || capacity <= 0) {
		return "Capacity must be a positive number of liters.";
	}

	const usable = positiveOrZero(draft.usableCapacityLiters);
	if (usable !== null && usable > capacity) {
		return "Usable capacity cannot exceed capacity.";
	}

	for (const [label, value] of [
		["Minimum safe volume", draft.minimumSafeVolumeLiters],
		["Refill threshold", draft.refillThresholdLiters],
		["Overflow threshold", draft.overflowThresholdLiters],
	] as const) {
		const parsed = positiveOrZero(value);
		if (value.trim() && parsed === null) {
			return `${label} must be a positive number of liters.`;
		}
	}
	return null;
}

/**
 * Validate the geometry portion of a reservoir draft. Mirrors the shape-specific
 * requirements enforced by the backend GeometryInput validator.
 */
export function validateReservoirGeometry(draft: ReservoirDraft): string | null {
	const { shape } = draft.geometry;
	if (shape === "custom_calibration_table") return null;

	const fields: Record<string, string> = {
		length: draft.geometry.length,
		width: draft.geometry.width,
		height: draft.geometry.height,
		diameter: draft.geometry.diameter,
	};
	for (const [label, value] of Object.entries(fields)) {
		if (value.trim() && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
			return `${label[0].toUpperCase()}${label.slice(1)} must be a positive number.`;
		}
	}

	if (shape === "rectangular") {
		if (!draft.geometry.length.trim()) return "Length is required for a rectangular tank.";
		if (!draft.geometry.width.trim()) return "Width is required for a rectangular tank.";
		if (!draft.geometry.height.trim()) return "Height is required for a rectangular tank.";
	}
	if (shape === "vertical_cylinder") {
		if (!draft.geometry.diameter.trim()) return "Diameter is required for a vertical cylinder.";
		if (!draft.geometry.height.trim()) return "Height is required for a vertical cylinder.";
	}
	if (shape === "horizontal_cylinder") {
		if (!draft.geometry.diameter.trim())
			return "Diameter is required for a horizontal cylinder.";
		if (!draft.geometry.length.trim()) return "Length is required for a horizontal cylinder.";
	}
	return null;
}

function optionalLiteral(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function geometryInput(draft: ReservoirDraft): GeometryInput {
	const { shape, unit } = draft.geometry;
	if (shape === "custom_calibration_table") {
		return { shape };
	}
	return {
		shape,
		unit,
		length: optionalLiteral(draft.geometry.length),
		width: optionalLiteral(draft.geometry.width),
		height: optionalLiteral(draft.geometry.height),
		diameter: optionalLiteral(draft.geometry.diameter),
	};
}

export function draftToCreateInput(draft: ReservoirDraft): ReservoirCreateInput {
	return {
		name: draft.name.trim(),
		reservoir_type: draft.reservoirType,
		primary_grow_space_id: draft.primaryGrowSpaceId.trim() || null,
		capacity_liters: draft.capacityLiters.trim(),
		usable_capacity_liters: optionalLiteral(draft.usableCapacityLiters),
		minimum_safe_volume_liters: optionalLiteral(draft.minimumSafeVolumeLiters),
		refill_threshold_liters: optionalLiteral(draft.refillThresholdLiters),
		overflow_threshold_liters: optionalLiteral(draft.overflowThresholdLiters),
		geometry: geometryInput(draft),
	};
}

/** Field-level errors surfaced on the details form via aria-invalid. */
export interface ReservoirFieldErrors {
	name?: string;
	capacityLiters?: string;
	usableCapacityLiters?: string;
}

export interface CalibrationRow {
	rawValue: string;
	volumeLiters: string;
}

export function emptyCalibrationRow(): CalibrationRow {
	return { rawValue: "", volumeLiters: "" };
}

/**
 * Validate a calibration table draft. Requires at least two points and distinct
 * raw values, mirroring the backend CalibrationPointsReplace validator.
 */
export function validateCalibrationRows(rows: CalibrationRow[]): string | null {
	const filled = rows.filter(
		(row) => row.rawValue.trim() && row.volumeLiters.trim(),
	);
	if (filled.length < 2) {
		return "A calibration table requires at least two complete points.";
	}
	for (const row of filled) {
		if (!Number.isFinite(Number(row.rawValue))) {
			return "Every raw reading must be a number.";
		}
		if (!Number.isFinite(Number(row.volumeLiters)) || Number(row.volumeLiters) < 0) {
			return "Every volume must be a non-negative number of liters.";
		}
	}
	const rawValues = filled.map((row) => row.rawValue.trim());
	if (new Set(rawValues).size !== rawValues.length) {
		return "Calibration points must have distinct raw readings.";
	}
	return null;
}

export function calibrationRowsToInput(
	rows: CalibrationRow[],
): { raw_value: string; volume_liters: string }[] {
	return rows
		.filter((row) => row.rawValue.trim() && row.volumeLiters.trim())
		.map((row) => ({
			raw_value: row.rawValue.trim(),
			volume_liters: row.volumeLiters.trim(),
		}));
}

export type { DimensionUnit };
