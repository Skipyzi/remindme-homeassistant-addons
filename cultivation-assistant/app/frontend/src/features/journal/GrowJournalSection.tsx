import { useState } from "react";
import { ApiError } from "../../api/client";
import { useCreateGrowJournalEntry, useGrowJournalEntries } from "../../api/journal";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ErrorState, LoadingState } from "../../components/ui/StatePanel";
import { JournalEntryComposer } from "./JournalEntryComposer";

export function GrowJournalSection({ growId }: { growId: string }) {
	const entries = useGrowJournalEntries(growId);
	const createEntry = useCreateGrowJournalEntry(growId);
	const [composerOpen, setComposerOpen] = useState(false);

	return (
		<Card className="record-panel">
			<div className="record-panel__head">
				<h2>Journal</h2>
				<Button variant="secondary" onClick={() => setComposerOpen(true)}>
					Add note
				</Button>
			</div>

			{entries.isLoading && <LoadingState label="Loading journal" />}
			{entries.isError && (
				<ErrorState
					title="Journal unavailable"
					description={entries.error?.message ?? "The journal could not be loaded."}
					actionLabel="Retry"
					onAction={() => entries.refetch()}
				/>
			)}
			{entries.data && entries.data.length === 0 && (
				<p className="activity-feed__empty">No journal entries yet.</p>
			)}
			{entries.data && entries.data.length > 0 && (
				<ol className="transition-history">
					{entries.data.map((entry) => (
						<li key={entry.id}>
							<span className="transition-history__stage">
								{entry.title ?? entry.entry_type}
							</span>
							<span className="transition-history__meta">{entry.occurred_at}</span>
							{entry.notes && <p>{entry.notes}</p>}
						</li>
					))}
				</ol>
			)}

			{composerOpen && (
				<JournalEntryComposer
					onSubmit={(input) =>
						createEntry.mutate(input, { onSuccess: () => setComposerOpen(false) })
					}
					onClose={() => setComposerOpen(false)}
					submitting={createEntry.isPending}
					submitError={
						createEntry.error instanceof ApiError ? createEntry.error.message : null
					}
				/>
			)}
		</Card>
	);
}
