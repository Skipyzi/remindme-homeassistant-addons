import type { TimelineEntry } from "../../api/journal";

const EVENT_LABELS: Record<string, string> = {
	stage_changed: "Stage change",
	measurement_recorded: "Measurement",
	photo_added: "Photo",
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

export function ActivityTimeline({ entries }: { entries: TimelineEntry[] }) {
	if (entries.length === 0) {
		return <p className="activity-feed__empty">No activity recorded yet.</p>;
	}

	return (
		<ol className="transition-history">
			{entries.map((entry) => (
				<li key={entry.id}>
					<span className="transition-history__stage">
						{EVENT_LABELS[entry.event_type] ?? entry.event_type}
					</span>
					<span className="transition-history__meta">{entry.occurred_at}</span>
					<span className="transition-history__notes">{entry.summary}</span>
					{entry.journal_entry?.notes && <p>{entry.journal_entry.notes}</p>}
					{entry.journal_entry?.tags && entry.journal_entry.tags.length > 0 && (
						<p className="transition-history__meta">
							{entry.journal_entry.tags.join(", ")}
						</p>
					)}
					{entry.stage_transition && (
						<span className="transition-history__meta">
							{entry.stage_transition.source}
						</span>
					)}
				</li>
			))}
		</ol>
	);
}
