import type { ChangeEvent } from "react";
import { convertDimensionValue, type DimensionUnit } from "../grow-spaces/dimensions";
import { calculateGeometryPreview, type GeometryDraft } from "./geometry";
import {
	geometryShapeOptions,
	type ReservoirDraft,
} from "./types";

interface ReservoirGeometryFormProps {
	value: ReservoirDraft;
	onChange: (value: ReservoirDraft) => void;
}

function isCustom(shape: GeometryDraft["shape"]) {
	return shape === "custom_calibration_table";
}

export function ReservoirGeometryForm({ value, onChange }: ReservoirGeometryFormProps) {
	const geometry = value.geometry;
	const custom = isCustom(geometry.shape);
	const preview = calculateGeometryPreview(geometry);

	function updateGeometry(patch: Partial<GeometryDraft>) {
		onChange({ ...value, geometry: { ...geometry, ...patch } });
	}

	function changeShape(event: ChangeEvent<HTMLSelectElement>) {
		updateGeometry({
			shape: event.target.value as GeometryDraft["shape"],
		});
	}

	function changeUnit(event: ChangeEvent<HTMLSelectElement>) {
		const nextUnit = event.target.value as DimensionUnit;
		updateGeometry({
			length: convertDimensionValue(geometry.length, geometry.unit, nextUnit),
			width: convertDimensionValue(geometry.width, geometry.unit, nextUnit),
			height: convertDimensionValue(geometry.height, geometry.unit, nextUnit),
			diameter: convertDimensionValue(geometry.diameter, geometry.unit, nextUnit),
			unit: nextUnit,
		});
	}

	const needsLength = geometry.shape === "rectangular" || geometry.shape === "horizontal_cylinder";
	const needsWidth = geometry.shape === "rectangular";
	const needsHeight =
		geometry.shape === "rectangular" || geometry.shape === "vertical_cylinder";
	const needsDiameter =
		geometry.shape === "vertical_cylinder" || geometry.shape === "horizontal_cylinder";

	return (
		<div className="wizard-form-grid reservoir-geometry-form">
			<label className="form-field span-two">
				<span>Tank geometry</span>
				<select value={geometry.shape} onChange={changeShape}>
					{geometryShapeOptions.map(([shape, label]) => (
						<option key={shape} value={shape}>
							{label}
						</option>
					))}
				</select>
			</label>

			{custom ? (
				<p className="wizard-intro span-two">
					Custom calibration tables map raw sensor readings to known volumes. Enter
					those readings on the reservoir's calibration table after creation; no
					tank dimensions are required.
				</p>
			) : (
				<>
					<div className="dimension-input-grid span-two">
						{needsLength && (
							<label className="form-field">
								<span>Length · required</span>
								<input
									inputMode="decimal"
									value={geometry.length}
									onChange={(event) => updateGeometry({ length: event.target.value })}
								/>
							</label>
						)}
						{needsWidth && (
							<label className="form-field">
								<span>Width · required</span>
								<input
									inputMode="decimal"
									value={geometry.width}
									onChange={(event) => updateGeometry({ width: event.target.value })}
								/>
							</label>
						)}
						{needsHeight && (
							<label className="form-field">
								<span>Height · required</span>
								<input
									inputMode="decimal"
									value={geometry.height}
									onChange={(event) => updateGeometry({ height: event.target.value })}
								/>
							</label>
						)}
						{needsDiameter && (
							<label className="form-field">
								<span>Diameter · required</span>
								<input
									inputMode="decimal"
									value={geometry.diameter}
									onChange={(event) =>
										updateGeometry({ diameter: event.target.value })
									}
								/>
							</label>
						)}
						<label className="form-field dimension-unit-field">
							<span>Unit</span>
							<select
								aria-label="Geometry unit"
								value={geometry.unit}
								onChange={changeUnit}
							>
								<option value="cm">cm</option>
								<option value="in">in</option>
							</select>
						</label>
					</div>

					<div className="calculated-measurements span-two" aria-live="polite">
						<div>
							<span>Estimated full-tank volume</span>
							<strong>
								{preview ? `${preview.volumeLiters} L` : "Awaiting dimensions"}
							</strong>
						</div>
						<div>
							<span>Entered capacity</span>
							<strong>
								{value.capacityLiters.trim()
									? `${value.capacityLiters.trim()} L`
									: "Awaiting capacity"}
							</strong>
						</div>
					</div>
					<p className="wizard-intro span-two">
						The geometric volume is an estimate used for previews; record the
						authoritative capacity above. Home Assistant remains responsible for any
						physical fill limits.
					</p>
				</>
			)}
		</div>
	);
}
