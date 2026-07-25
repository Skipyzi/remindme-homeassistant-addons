import { useState, type FormEvent } from "react";
import type { CultivarCreateInput, Cultivar } from "../../api/library";
import type { LifecycleStage } from "../../api/lifecycle";
import type { PlantStatus, PropagationSource } from "../../api/plants";
import { Button } from "../../components/ui/Button";
import { CultivarCombobox } from "./CultivarCombobox";
import type { PlantDraft } from "./types";

const STATUS_OPTIONS: PlantStatus[] = [
	"planned",
	"active",
	"harvested",
	"completed",
	"lost",
];
const STATUS_REQUIRING_START: PlantStatus[] = [
	"active",
	"harvested",
	"completed",
	"lost",
];
const HARVEST_STATUSES: PlantStatus[] = ["harvested", "completed"];
const SEED_TYPES = ["unknown", "regular", "feminized", "autoflower"];

export interface PlantFormProps {
	mode: "create" | "edit";
	value: PlantDraft;
	onChange: (value: PlantDraft) => void;
	onSubmit: (value: PlantDraft) => void;
	cultivars: Cultivar[];
	stages: LifecycleStage[];
	onCreateCultivar: (input: CultivarCreateInput) => Promise<Cultivar>;
	submitting?: boolean;
	submitError?: string | null;
}

export function PlantForm({
	mode,
	value,
	onChange,
	onSubmit,
	cultivars,
	stages,
	onCreateCultivar,
	submitting = false,
	submitError = null,
}: PlantFormProps) {
	const [validationError, setValidationError] = useState<string | null>(null);

	function update<Key extends keyof PlantDraft>(
		key: Key,
		next: PlantDraft[Key],
	) {
		onChange({ ...value, [key]: next });
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!value.name.trim()) {
			setValidationError("A plant name is required.");
			return;
		}
		if (!value.cultivarId) {
			setValidationError("Select or create a cultivar.");
			return;
		}
		if (!value.currentStageId) {
			setValidationError("Choose an initial stage.");
			return;
		}
		if (STATUS_REQUIRING_START.includes(value.status) && !value.startDate) {
			setValidationError("A start date is required once a plant is active.");
			return;
		}
		if (
			value.actualHarvestDate &&
			!HARVEST_STATUSES.includes(value.status)
		) {
			setValidationError(
				"An actual harvest date is only valid for harvested or completed plants.",
			);
			return;
		}
		setValidationError(null);
		onSubmit(value);
	}

	const isClone = value.propagationSource === "clone";
	const message = validationError ?? submitError;

	return (
		<form className="record-form" onSubmit={handleSubmit} noValidate>
			<label className="field">
				<span>Plant name</span>
				<input
					value={value.name}
					onChange={(event) => update("name", event.target.value)}
				/>
			</label>

			<CultivarCombobox
				cultivars={cultivars}
				value={value.cultivarId}
				onChange={(cultivarId) => update("cultivarId", cultivarId)}
				onCreateCultivar={onCreateCultivar}
			/>

			<label className="field">
				<span>Source</span>
				<select
					value={value.propagationSource}
					onChange={(event) => {
						const next = event.target.value as PropagationSource;
						onChange({
							...value,
							propagationSource: next,
							seedType: next === "clone" ? "" : value.seedType || "unknown",
						});
					}}
				>
					<option value="seed">Seed</option>
					<option value="clone">Clone</option>
				</select>
			</label>

			{!isClone && (
				<label className="field">
					<span>Seed type</span>
					<select
						value={value.seedType || "unknown"}
						onChange={(event) => update("seedType", event.target.value)}
					>
						{SEED_TYPES.map((type) => (
							<option key={type} value={type}>
								{type}
							</option>
						))}
					</select>
				</label>
			)}

			<label className="field">
				<span>Initial stage</span>
				<select
					value={value.currentStageId}
					onChange={(event) => update("currentStageId", event.target.value)}
				>
					<option value="">Select a stage</option>
					{stages.map((stage) => (
						<option key={stage.id} value={stage.id}>
							{stage.label}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span>Status</span>
				<select
					value={value.status}
					onChange={(event) =>
						update("status", event.target.value as PlantStatus)
					}
				>
					{STATUS_OPTIONS.map((status) => (
						<option key={status} value={status}>
							{status}
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
				<span>Container</span>
				<input
					value={value.container}
					onChange={(event) => update("container", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Medium</span>
				<input
					value={value.medium}
					onChange={(event) => update("medium", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Location</span>
				<input
					value={value.location}
					onChange={(event) => update("location", event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Expected harvest start</span>
				<input
					type="date"
					value={value.expectedHarvestStart}
					onChange={(event) =>
						update("expectedHarvestStart", event.target.value)
					}
				/>
			</label>

			<label className="field">
				<span>Expected harvest end</span>
				<input
					type="date"
					value={value.expectedHarvestEnd}
					onChange={(event) =>
						update("expectedHarvestEnd", event.target.value)
					}
				/>
			</label>

			{HARVEST_STATUSES.includes(value.status) && (
				<label className="field">
					<span>Actual harvest date</span>
					<input
						type="date"
						value={value.actualHarvestDate}
						onChange={(event) =>
							update("actualHarvestDate", event.target.value)
						}
					/>
				</label>
			)}

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
					{mode === "create" ? "Create plant" : "Save plant"}
				</Button>
			</div>
		</form>
	);
}
