import { useGrowSpaces } from "../../api/growSpaces";
import { reservoirTypeOptions } from "./types";
import type { ReservoirDraft, ReservoirFieldErrors } from "./types";

interface ReservoirDetailsFormProps {
	value: ReservoirDraft;
	mode: "create" | "edit";
	onChange: (value: ReservoirDraft) => void;
	errors?: ReservoirFieldErrors;
}

export function ReservoirDetailsForm({
	value,
	mode,
	onChange,
	errors = {},
}: ReservoirDetailsFormProps) {
	const spaces = useGrowSpaces(false);

	function update(patch: Partial<ReservoirDraft>) {
		onChange({ ...value, ...patch });
	}

	return (
		<div className="wizard-form-grid reservoir-details-form">
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
				<span>Reservoir type</span>
				<select
					value={value.reservoirType}
					onChange={(event) =>
						update({
							reservoirType: event.target.value as ReservoirDraft["reservoirType"],
						})
					}
				>
					{reservoirTypeOptions.map(([type, label]) => (
						<option key={type} value={type}>
							{label}
						</option>
					))}
				</select>
			</label>

			<label className="form-field">
				<span>Grow space · optional</span>
				<select
					value={value.primaryGrowSpaceId}
					onChange={(event) => update({ primaryGrowSpaceId: event.target.value })}
				>
					<option value="">Unassigned</option>
					{spaces.data?.items.map((space) => (
						<option key={space.id} value={space.id}>
							{space.name}
						</option>
					))}
				</select>
			</label>

			<label className="form-field">
				<span>Capacity · liters · required</span>
				<input
					aria-invalid={Boolean(errors.capacityLiters)}
					inputMode="decimal"
					value={value.capacityLiters}
					onChange={(event) => update({ capacityLiters: event.target.value })}
				/>
			</label>

			<label className="form-field">
				<span>Usable capacity · optional</span>
				<input
					aria-invalid={Boolean(errors.usableCapacityLiters)}
					inputMode="decimal"
					placeholder="Defaults to capacity"
					value={value.usableCapacityLiters}
					onChange={(event) => update({ usableCapacityLiters: event.target.value })}
				/>
			</label>

			<label className="form-field">
				<span>Refill threshold · liters</span>
				<input
					inputMode="decimal"
					placeholder="Optional"
					value={value.refillThresholdLiters}
					onChange={(event) => update({ refillThresholdLiters: event.target.value })}
				/>
			</label>

			<label className="form-field">
				<span>Minimum safe volume · liters</span>
				<input
					inputMode="decimal"
					placeholder="Optional"
					value={value.minimumSafeVolumeLiters}
					onChange={(event) =>
						update({ minimumSafeVolumeLiters: event.target.value })
					}
				/>
			</label>

			<label className="form-field">
				<span>Overflow threshold · liters</span>
				<input
					inputMode="decimal"
					placeholder="Optional"
					value={value.overflowThresholdLiters}
					onChange={(event) =>
						update({ overflowThresholdLiters: event.target.value })
					}
				/>
			</label>

			{mode === "edit" && (
				<fieldset className="status-segmented-control span-two">
					<legend>Status</legend>
					<label>
						<input
							checked={value.active}
							name="reservoir-status"
							type="radio"
							onChange={() => update({ active: true })}
						/>
						<span>Active</span>
					</label>
					<label>
						<input
							checked={!value.active}
							name="reservoir-status"
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
