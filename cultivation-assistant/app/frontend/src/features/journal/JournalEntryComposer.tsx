import { useState } from "react";
import type { LifecycleStage } from "../../api/lifecycle";
import { journalEntryTypeSchema, type JournalEntryCreateInput } from "../../api/journal";
import { Button } from "../../components/ui/Button";

export interface JournalEntryComposerProps {
	stages?: LifecycleStage[];
	onSubmit: (input: JournalEntryCreateInput) => void;
	onClose: () => void;
	submitting?: boolean;
	submitError?: string | null;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
	watered: "Watered",
	fed: "Fed",
	transplanted: "Transplanted",
	topped: "Topped",
	trained: "Trained",
	defoliated: "Defoliated",
	light_schedule_changed: "Light schedule changed",
	flowering_initiated: "Flowering initiated",
	first_flowers_observed: "First flowers observed",
	problem_observed: "Problem observed",
	treatment_applied: "Treatment applied",
	harvested: "Harvested",
	drying_started: "Drying started",
	jarred: "Jarred",
	cure_milestone: "Cure milestone",
	note: "Note",
};

export function JournalEntryComposer({
	stages,
	onSubmit,
	onClose,
	submitting = false,
	submitError = null,
}: JournalEntryComposerProps) {
	const [entryType, setEntryType] = useState("note");
	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [tags, setTags] = useState("");
	const [relatedStageId, setRelatedStageId] = useState("");
	const [relatedIssue, setRelatedIssue] = useState("");

	function submit() {
		onSubmit({
			entry_type: journalEntryTypeSchema.parse(entryType),
			title: title.trim() || null,
			notes: notes.trim() || null,
			tags: tags
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
			related_stage_id: relatedStageId || null,
			related_issue: relatedIssue.trim() || null,
		});
	}

	return (
		<div className="dialog" role="dialog" aria-modal="true" aria-label="Add note">
			<h2>Add note</h2>

			<label className="field">
				<span>Type</span>
				<select value={entryType} onChange={(event) => setEntryType(event.target.value)}>
					{Object.entries(ENTRY_TYPE_LABELS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span>Title</span>
				<input value={title} onChange={(event) => setTitle(event.target.value)} />
			</label>

			<label className="field">
				<span>Notes</span>
				<textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
			</label>

			<label className="field">
				<span>Tags (comma separated)</span>
				<input value={tags} onChange={(event) => setTags(event.target.value)} />
			</label>

			{stages && stages.length > 0 && (
				<label className="field">
					<span>Related stage</span>
					<select
						value={relatedStageId}
						onChange={(event) => setRelatedStageId(event.target.value)}
					>
						<option value="">None</option>
						{stages.map((stage) => (
							<option key={stage.id} value={stage.id}>
								{stage.label}
							</option>
						))}
					</select>
				</label>
			)}

			<label className="field">
				<span>Related issue</span>
				<input
					value={relatedIssue}
					onChange={(event) => setRelatedIssue(event.target.value)}
				/>
			</label>

			{submitError && (
				<p className="form-error" role="alert">
					{submitError}
				</p>
			)}

			<div className="form-actions">
				<Button type="button" onClick={submit} disabled={submitting}>
					Save
				</Button>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
