import { useState } from "react";
import { measurementMetricSchema, type MeasurementCreateInput } from "../../api/journal";
import { Button } from "../../components/ui/Button";

export interface MeasurementComposerProps {
	onSubmit: (input: MeasurementCreateInput) => void;
	onClose: () => void;
	submitting?: boolean;
	submitError?: string | null;
}

const METRIC_LABELS: Record<string, string> = {
	height: "Height",
	width: "Width",
	canopy_diameter: "Canopy diameter",
	stem_diameter: "Stem diameter",
	node_count: "Node count",
	container_weight: "Container weight",
	plant_weight: "Plant weight",
	custom: "Custom metric",
};

export function MeasurementComposer({
	onSubmit,
	onClose,
	submitting = false,
	submitError = null,
}: MeasurementComposerProps) {
	const [metricType, setMetricType] = useState("height");
	const [customMetricName, setCustomMetricName] = useState("");
	const [value, setValue] = useState("");
	const [unit, setUnit] = useState("cm");
	const [notes, setNotes] = useState("");

	function submit() {
		onSubmit({
			metric_type: measurementMetricSchema.parse(metricType),
			custom_metric_name: metricType === "custom" ? customMetricName.trim() || null : null,
			value: Number(value),
			unit: unit.trim(),
			notes: notes.trim() || null,
		});
	}

	return (
		<div className="dialog" role="dialog" aria-modal="true" aria-label="Log measurement">
			<h2>Log measurement</h2>

			<label className="field">
				<span>Metric</span>
				<select value={metricType} onChange={(event) => setMetricType(event.target.value)}>
					{Object.entries(METRIC_LABELS).map(([value_, label]) => (
						<option key={value_} value={value_}>
							{label}
						</option>
					))}
				</select>
			</label>

			{metricType === "custom" && (
				<label className="field">
					<span>Metric name</span>
					<input
						value={customMetricName}
						onChange={(event) => setCustomMetricName(event.target.value)}
					/>
				</label>
			)}

			<label className="field">
				<span>Value</span>
				<input
					type="number"
					step="any"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Unit</span>
				<input value={unit} onChange={(event) => setUnit(event.target.value)} />
			</label>

			<label className="field">
				<span>Notes</span>
				<textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
			</label>

			{submitError && (
				<p className="form-error" role="alert">
					{submitError}
				</p>
			)}

			<div className="form-actions">
				<Button
					type="button"
					onClick={submit}
					disabled={submitting || value.trim() === "" || !unit.trim()}
				>
					Save
				</Button>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
