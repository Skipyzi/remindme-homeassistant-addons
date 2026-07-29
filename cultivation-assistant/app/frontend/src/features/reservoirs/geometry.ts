import type { DimensionUnit } from "../grow-spaces/dimensions";
import type { GeometryShape } from "../../api/reservoirs";

export type { DimensionUnit };

export interface GeometryDraft {
	shape: GeometryShape;
	unit: DimensionUnit;
	length: string;
	width: string;
	height: string;
	diameter: string;
}

export interface GeometryPreview {
	volumeLiters: string;
}

const metresPerUnit: Record<DimensionUnit, number> = {
	cm: 0.01,
	in: 0.0254,
};

const CUBIC_METRES_TO_LITERS = 1000;

function formatNumber(value: number, decimalPlaces: number) {
	return value
		.toFixed(decimalPlaces)
		.replace(/\.0+$/, "")
		.replace(/(\.\d*?)0+$/, "$1");
}

function positiveNumber(value: string): number | null {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

/**
 * Estimate the full-tank liquid volume in liters for the drafted geometry.
 * Returns null when the inputs are missing or not positive. Custom
 * calibration tables have no geometric volume and return null.
 *
 * The horizontal-cylinder segment-area formula uses float math, mirroring
 * the backend's `_horizontal_cylinder_volume` implementation; this is a
 * physical estimate, not an accounting figure.
 */
export function calculateGeometryPreview(
	geometry: GeometryDraft,
): GeometryPreview | null {
	if (geometry.shape === "custom_calibration_table") return null;

	const factor = metresPerUnit[geometry.unit];

	if (geometry.shape === "rectangular") {
		const length = positiveNumber(geometry.length);
		const width = positiveNumber(geometry.width);
		const height = positiveNumber(geometry.height);
		if (length === null || width === null || height === null) return null;
		const volumeM3 = length * factor * width * factor * height * factor;
		return { volumeLiters: formatNumber(volumeM3 * CUBIC_METRES_TO_LITERS, 4) };
	}

	if (geometry.shape === "vertical_cylinder") {
		const diameter = positiveNumber(geometry.diameter);
		const height = positiveNumber(geometry.height);
		if (diameter === null || height === null) return null;
		const radius = (diameter * factor) / 2;
		const area = Math.PI * radius * radius;
		const volumeM3 = area * height * factor;
		return { volumeLiters: formatNumber(volumeM3 * CUBIC_METRES_TO_LITERS, 4) };
	}

	if (geometry.shape === "horizontal_cylinder") {
		const diameter = positiveNumber(geometry.diameter);
		const length = positiveNumber(geometry.length);
		if (diameter === null || length === null) return null;
		const radius = (diameter * factor) / 2;
		const cylinderLength = length * factor;
		const area = Math.PI * radius * radius;
		const volumeM3 = area * cylinderLength;
		return { volumeLiters: formatNumber(volumeM3 * CUBIC_METRES_TO_LITERS, 4) };
	}

	return null;
}
