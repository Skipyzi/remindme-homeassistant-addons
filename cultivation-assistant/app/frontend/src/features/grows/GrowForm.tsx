import { useState, type FormEvent } from "react";
import type { GrowStatus } from "../../api/grows";
import type { GrowSpaceSummary } from "../../api/growSpaces";
import { Button } from "../../components/ui/Button";
import type { GrowDraft } from "./types";

const STATUS_OPTIONS: { value: GrowStatus; label: string }[] = [
	{ value: "planned", label: "Planned" },
	{ value: "active", label: "Active" },
	{ value: "completed", label: "Completed" },
];

const STATUS_REQUIRING_START: GrowStatus[] = ["active", "completed"];

export interface GrowFormProps {
	mode: "create" | "edit";
	value: GrowDraft;
	onChange: (value: GrowDraft) => void;
	onSubmit: (value: GrowDraft) => void;
	growSpaces?: GrowSpaceSummary[];
	submitting?: boolean;
	submitError?: string | null;
}

export function GrowForm({
	mode,
	value,
	onChange,
	onSubmit,
	growSpaces = [],
	submitting = false,
	submitError = null,
}: GrowFormProps) {
	const [validationError, setValidationError] = useState<string | null>(null);

	function update<Key extends keyof GrowDraft>(key: Key, next: GrowDraft[Key]) {
		onChange({ ...value, [key]: next });
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!value.name.trim()) {
			setValidationError("A grow name is required.");
			return;
		}
		if (STATUS_REQUIRING_START.includes(value.status) && !value.startDate) {
			setValidationError("A start date is required for an active grow.");
			return;
		}
		if (value.endDate && value.startDate && value.endDate < value.startDate) {
			setValidationError("The end date cannot precede the start date.");
			return;
		}
		setValidationError(null);
		onSubmit(value);
	}

	const inactiveSpace = growSpaces.find(
		(space) => space.id === value.growSpaceId && !space.active,
	);
	const message = validationError ?? submitError;

	return (
		<form className="record-form" onSubmit={handleSubmit} noValidate>
			{mode === "create" && (
				<label className="field">
					<span>Grow space</span>
					<select
						value={value.growSpaceId}
						onChange={(event) => update("growSpaceId", event.target.value)}
					>
						{growSpaces.length === 0 && <option value="">No grow spaces</option>}
						{growSpaces.map((space) => (
							<option key={space.id} value={space.id}>
								{space.name}
								{space.active ? "" : " (inactive)"}
							</option>
						))}
					</select>
				</label>
			)}

			{inactiveSpace && (
				<p className="form-warning" role="status">
					This grow space is inactive. The grow will be created but the space
					is not currently active.
				</p>
			)}

			<label className="field">
				<span>Grow name</span>
				<input
					value={value.name}
					onChange={(event) => update("name", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Status</span>
				<select
					value={value.status}
					onChange={(event) =>
						update("status", event.target.value as GrowStatus)
					}
				>
					{STATUS_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span>Start date</span>
				<input
					type="date"
					value={value.startDate}
					onChange={(event) => update("startDate", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>End date</span>
				<input
					type="date"
					value={value.endDate}
					onChange={(event) => update("endDate", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Notes</span>
				<textarea
					value={value.notes}
					onChange={(event) => update("notes", event.target.value)}
				/>
			</label>

			{message && (
				<p className="form-error" role="alert">
					{message}
				</p>
			)}

			<div className="form-actions">
				<Button type="submit" disabled={submitting}>
					{mode === "create" ? "Create grow" : "Save grow"}
				</Button>
			</div>
		</form>
	);
}
