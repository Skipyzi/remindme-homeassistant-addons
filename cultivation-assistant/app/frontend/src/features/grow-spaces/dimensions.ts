export type DimensionUnit = "cm" | "in";

export interface DimensionDraft {
	length: string;
	width: string;
	height: string;
	unit: DimensionUnit;
}

export interface DimensionPreview {
	areaM2: string;
	volumeM3: string | null;
}

const metresPerUnit: Record<DimensionUnit, number> = {
	cm: 0.01,
	in: 0.0254,
};

function formatNumber(value: number, decimalPlaces: number) {
	return value
		.toFixed(decimalPlaces)
		.replace(/\.0+$/, "")
		.replace(/(\.\d*?)0+$/, "$1");
}

export function convertDimensionValue(
	value: string,
	from: DimensionUnit,
	to: DimensionUnit,
) {
	if (!value.trim() || from === to) return value;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return value;
	const converted = (parsed * metresPerUnit[from]) / metresPerUnit[to];
	return formatNumber(converted, 2);
}

export function calculateDimensionPreview(
	dimensions: DimensionDraft,
): DimensionPreview | null {
	const length = Number(dimensions.length);
	const width = Number(dimensions.width);
	if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) {
		return null;
	}
	const factor = metresPerUnit[dimensions.unit];
	const area = length * factor * width * factor;
	const height = dimensions.height.trim() ? Number(dimensions.height) : null;
	const volume =
		height !== null && Number.isFinite(height) && height > 0
			? area * height * factor
			: null;
	return {
		areaM2: formatNumber(area, 4),
		volumeM3: volume === null ? null : formatNumber(volume, 4),
	};
}
