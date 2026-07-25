import { useState } from "react";
import type { LifecycleStage } from "../../api/lifecycle";
import type { PlantTransitionInput } from "../../api/plants";
import { Button } from "../../components/ui/Button";

export interface StageTransitionDialogProps {
	stages: LifecycleStage[];
	currentStageId: string;
	onSubmit: (input: PlantTransitionInput) => void;
	onClose: () => void;
	submitting?: boolean;
	submitError?: string | null;
}

function defaultEffective(): string {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60_000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

export function StageTransitionDialog({
	stages,
	currentStageId,
	onSubmit,
	onClose,
	submitting = false,
	submitError = null,
}: StageTransitionDialogProps) {
	const currentIndex = stages.findIndex((stage) => stage.id === currentStageId);
	const defaultTarget =
		stages[currentIndex + 1]?.id ?? stages[currentIndex]?.id ?? stages[0]?.id ?? "";
	const [targetId, setTargetId] = useState(defaultTarget);
	const [effectiveAt, setEffectiveAt] = useState(defaultEffective());
	const [notes, setNotes] = useState("");

	const targetIndex = stages.findIndex((stage) => stage.id === targetId);
	const nonAdjacent = targetIndex !== currentIndex + 1;

	function submit() {
		onSubmit({
			to_stage_id: targetId,
			effective_at: new Date(effectiveAt).toISOString(),
			notes: notes.trim() || null,
			confirmed: true,
		});
	}

	return (
		<div
			className="dialog"
			role="dialog"
			aria-modal="true"
			aria-label="Change stage"
		>
			<h2>Change stage</h2>

			<label className="field">
				<span>Destination stage</span>
				<select
					value={targetId}
					onChange={(event) => setTargetId(event.target.value)}
				>
					{stages.map((stage) => (
						<option key={stage.id} value={stage.id}>
							{stage.label}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span>Effective date and time</span>
				<input
					type="datetime-local"
					value={effectiveAt}
					onChange={(event) => setEffectiveAt(event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Notes</span>
				<textarea
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
				/>
			</label>

			{nonAdjacent && (
				<p className="dialog__warning">
					This is a backward or skipped stage change. It updates the current
					lifecycle record but does not erase history.
				</p>
			)}

			{submitError && (
				<p className="form-error" role="alert">
					{submitError}
				</p>
			)}

			<div className="form-actions">
				<Button type="button" onClick={submit} disabled={submitting}>
					Confirm stage change
				</Button>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
