import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
	useCalibrationPoints,
	useReplaceCalibrationPoints,
} from "../../api/reservoirs";
import { Button } from "../../components/ui/Button";
import {
	calibrationRowsToInput,
	emptyCalibrationRow,
	validateCalibrationRows,
	type CalibrationRow,
} from "./types";

interface CalibrationTableEditorProps {
	reservoirId: string;
	reservoirName: string;
}

function rowsFromPoints(
	points: { raw_value: string | number; volume_liters: string | number }[],
): CalibrationRow[] {
	return points.map((point) => ({
		rawValue: String(point.raw_value),
		volumeLiters: String(point.volume_liters),
	}));
}

function seedRows(
	points: { raw_value: string | number; volume_liters: string | number }[] | undefined,
): CalibrationRow[] {
	if (points && points.length >= 2) return rowsFromPoints(points);
	return [emptyCalibrationRow(), emptyCalibrationRow()];
}

export function CalibrationTableEditor({
	reservoirId,
	reservoirName,
}: CalibrationTableEditorProps) {
	const points = useCalibrationPoints(reservoirId);
	const replace = useReplaceCalibrationPoints(reservoirId);
	const [editing, setEditing] = useState(false);
	const [rows, setRows] = useState<CalibrationRow[]>([emptyCalibrationRow(), emptyCalibrationRow()]);
	const [validationError, setValidationError] = useState<string | null>(null);
	const errorRef = useRef<HTMLDivElement>(null);

	const loaded = points.data;
	const displayRows = editing ? rows : seedRows(loaded);

	useEffect(() => {
		if (validationError || replace.error) errorRef.current?.focus();
	}, [validationError, replace.error]);

	const validationMessage = useMemo(
		() => (editing ? validateCalibrationRows(rows) : null),
		[editing, rows],
	);

	function beginEditing() {
		setRows(seedRows(loaded));
		setValidationError(null);
		setEditing(true);
	}

	function discard() {
		setEditing(false);
		setValidationError(null);
		setRows(seedRows(loaded));
	}

	function updateRow(index: number, patch: Partial<CalibrationRow>) {
		setRows((current) =>
			current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
		);
	}

	function addRow() {
		setRows((current) => [...current, emptyCalibrationRow()]);
	}

	function removeRow(index: number) {
		setRows((current) => current.filter((_, i) => i !== index));
	}

	async function save() {
		if (validationMessage) {
			setValidationError(validationMessage);
			return;
		}
		setValidationError(null);
		try {
			await replace.mutateAsync(calibrationRowsToInput(rows));
			setEditing(false);
		} catch {
			// Mutation state renders and focuses the stable error summary.
		}
	}

	const errorMessage = validationError ?? replace.error?.message ?? null;
	const completeCount = rows.filter(
		(row) => row.rawValue.trim() && row.volumeLiters.trim(),
	).length;

	return (
		<section className="capability-section">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Capability · Optional</p>
					<h2>Calibration table</h2>
				</div>
				{!editing && (
					<Button variant="secondary" onClick={beginEditing}>
						Edit calibration
					</Button>
				)}
			</div>
			<p className="wizard-intro">
				A calibration table maps raw sensor readings to known volumes. This is
				how ultrasonic, capacitive, or load-cell sensors become usable volume
				figures for {reservoirName}.
			</p>

			{errorMessage && (
				<div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
					<strong>The calibration table was not saved.</strong>
					<span>{errorMessage}</span>
				</div>
			)}

			{points.isLoading ? (
				<div className="capability-empty">
					<p>Loading calibration table…</p>
				</div>
			) : points.isError ? (
				<div className="capability-empty" role="alert">
					<p>Calibration table could not be loaded.</p>
					<Button variant="secondary" onClick={() => points.refetch()}>
						Retry
					</Button>
				</div>
			) : (
				<div className="calibration-table-wrapper">
					<table className="reservoir-calibration-table">
						<thead>
							<tr>
								<th>Raw reading</th>
								<th>Volume (L)</th>
								{editing && <th aria-label="Row actions" />}
							</tr>
						</thead>
						<tbody>
							{displayRows.map((row, index) => (
								<tr key={index}>
									<td>
										{editing ? (
											<input
												inputMode="decimal"
												aria-label={`Raw reading ${index + 1}`}
												value={row.rawValue}
												onChange={(event) =>
													updateRow(index, { rawValue: event.target.value })
												}
											/>
										) : (
											<span>{row.rawValue || "—"}</span>
										)}
									</td>
									<td>
										{editing ? (
											<input
												inputMode="decimal"
												aria-label={`Volume ${index + 1}`}
												value={row.volumeLiters}
												onChange={(event) =>
													updateRow(index, { volumeLiters: event.target.value })
												}
											/>
										) : (
											<span>{row.volumeLiters || "—"}</span>
										)}
									</td>
									{editing && (
										<td>
											<Button
												aria-label={`Remove calibration point ${index + 1}`}
												size="icon"
												variant="ghost"
												onClick={() => removeRow(index)}
											>
												<Trash2 size={15} />
											</Button>
										</td>
									)}
								</tr>
							))}
						</tbody>
					</table>

					{editing && (
						<div className="calibration-editor-actions">
							<Button variant="secondary" onClick={addRow}>
								<Plus size={15} /> Add point
							</Button>
							<span className="calibration-point-count">
								{completeCount} complete · minimum 2
							</span>
							<div className="calibration-editor-save">
								<Button variant="ghost" onClick={discard}>
									Discard
								</Button>
								<Button disabled={replace.isPending} onClick={save}>
									{replace.isPending ? "Saving…" : "Save table"}
								</Button>
							</div>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
