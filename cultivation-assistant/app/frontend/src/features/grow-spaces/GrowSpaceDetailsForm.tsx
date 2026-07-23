import type { ChangeEvent } from "react";
import {
	calculateDimensionPreview,
	convertDimensionValue,
	type DimensionUnit,
} from "./dimensions";
import {
	growSpaceTypeOptions,
	type EditableGrowSpaceType,
	type GrowSpaceDetailsDraft,
} from "./types";

interface GrowSpaceDetailsFormProps {
	value: GrowSpaceDetailsDraft;
	mode: "create" | "edit";
	onChange: (value: GrowSpaceDetailsDraft) => void;
	errors?: Partial<Record<keyof GrowSpaceDetailsDraft, string>>;
}

export function GrowSpaceDetailsForm({
	value,
	mode,
	onChange,
	errors = {},
}: GrowSpaceDetailsFormProps) {
	const preview = calculateDimensionPreview({
		length: value.length,
		width: value.width,
		height: value.height,
		unit: value.dimensionUnit,
	});
	const legacyType = !growSpaceTypeOptions.some(
		([type]) => type === value.spaceType,
	);

	function update(patch: Partial<GrowSpaceDetailsDraft>) {
		onChange({ ...value, ...patch });
	}

	function changeUnit(event: ChangeEvent<HTMLSelectElement>) {
		const nextUnit = event.target.value as DimensionUnit;
		update({
			length: convertDimensionValue(value.length, value.dimensionUnit, nextUnit),
			width: convertDimensionValue(value.width, value.dimensionUnit, nextUnit),
			height: convertDimensionValue(value.height, value.dimensionUnit, nextUnit),
			dimensionUnit: nextUnit,
		});
	}

	return (
		<div className="wizard-form-grid grow-space-details-form">
			<label className="form-field span-two">
				<span>Name · required</span>
				<input
					autoFocus={mode === "create"}
					aria-invalid={Boolean(errors.name)}
					value={value.name}
					onChange={(event) => update({ name: event.target.value })}
				/>
			</label>

			<label className="form-field">
				<span>Space type</span>
				<select
					value={value.spaceType}
					onChange={(event) =>
						update({ spaceType: event.target.value as EditableGrowSpaceType })
					}
				>
					{legacyType && (
						<option value={value.spaceType}>
							Legacy · {value.spaceType.replaceAll("_", " ")}
						</option>
					)}
					{growSpaceTypeOptions.map(([type, label]) => (
						<option key={type} value={type}>
							{label}
						</option>
					))}
				</select>
			</label>

			<label className="form-field">
				<span>Location</span>
				<input
					placeholder="Basement · north wall"
					value={value.location}
					onChange={(event) => update({ location: event.target.value })}
				/>
			</label>

			<label className="form-field span-two">
				<span>Description</span>
				<textarea
					rows={3}
					value={value.description}
					onChange={(event) => update({ description: event.target.value })}
				/>
			</label>

			<div className="dimension-input-grid span-two">
				<label className="form-field">
					<span>Length · required</span>
					<input
						aria-invalid={Boolean(errors.length)}
						inputMode="decimal"
						value={value.length}
						onChange={(event) => update({ length: event.target.value })}
					/>
				</label>
				<label className="form-field">
					<span>Width · required</span>
					<input
						aria-invalid={Boolean(errors.width)}
						inputMode="decimal"
						value={value.width}
						onChange={(event) => update({ width: event.target.value })}
					/>
				</label>
				<label className="form-field">
					<span>
						Height · {value.spaceType === "outdoor" ? "optional" : "required"}
					</span>
					<input
						aria-invalid={Boolean(errors.height)}
						inputMode="decimal"
						value={value.height}
						onChange={(event) => update({ height: event.target.value })}
					/>
				</label>
				<label className="form-field dimension-unit-field">
					<span>Unit</span>
					<select
						aria-label="Dimension unit"
						value={value.dimensionUnit}
						onChange={changeUnit}
					>
						<option value="cm">cm</option>
						<option value="in">in</option>
					</select>
				</label>
			</div>

			<div className="calculated-measurements span-two" aria-live="polite">
				<div>
					<span>Calculated floor area</span>
					<strong>{preview ? `${preview.areaM2} m²` : "Awaiting dimensions"}</strong>
				</div>
				<div>
					<span>Calculated volume</span>
					<strong>
						{preview?.volumeM3
							? `${preview.volumeM3} m³`
							: value.spaceType === "outdoor"
								? "Volume not available"
								: "Awaiting height"}
					</strong>
				</div>
			</div>

			{mode === "edit" && (
				<fieldset className="status-segmented-control span-two">
					<legend>Status</legend>
					<label>
						<input
							checked={value.active}
							name="grow-space-status"
							type="radio"
							onChange={() => update({ active: true })}
						/>
						<span>Active</span>
					</label>
					<label>
						<input
							checked={!value.active}
							name="grow-space-status"
							type="radio"
							onChange={() => update({ active: false })}
						/>
						<span>Inactive</span>
					</label>
				</fieldset>
			)}
		</div>
	);
}
