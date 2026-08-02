import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Plus, Sprout } from "lucide-react";
import { ApiError } from "../api/client";
import { useGrow, useUpdateGrow } from "../api/grows";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/StatePanel";
import { GrowForm } from "../features/grows/GrowForm";
import { GrowJournalSection } from "../features/journal/GrowJournalSection";
import { growToDraft, type GrowDraft } from "../features/grows/types";

export function GrowDetailContent({ growId }: { growId: string }) {
	const grow = useGrow(growId);
	const updateGrow = useUpdateGrow();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<GrowDraft | null>(null);

	if (grow.isLoading) return <LoadingState label="Loading grow" />;
	if (grow.isError || !grow.data) {
		return (
			<div role="alert">
				<ErrorState
					title="Grow unavailable"
					description={grow.error?.message ?? "The grow could not be loaded."}
					actionLabel="Retry"
					onAction={() => grow.refetch()}
				/>
			</div>
		);
	}

	const record = grow.data;

	function startEditing() {
		setDraft(growToDraft(record));
		updateGrow.reset();
		setEditing(true);
	}

	async function submit(value: GrowDraft) {
		await updateGrow.mutateAsync({
			growId: record.id,
			input: {
				name: value.name.trim(),
				status: value.status,
				start_date: value.startDate || null,
				end_date: value.endDate || null,
				notes: value.notes.trim() || null,
			},
		});
		setEditing(false);
	}

	return (
		<div className="page-stack">
			<a className="back-link" href="#/plants">
				<ArrowLeft size={15} /> Back to plants
			</a>
			<section className="page-heading">
				<div>
					<p className="eyebrow">{record.grow_space_name}</p>
					<h1>{record.name}</h1>
					<p>
						Status: {record.status}
						{record.start_date ? ` · Started ${record.start_date}` : ""}
						{record.end_date ? ` · Ended ${record.end_date}` : ""}
					</p>
					{!record.grow_space_active && (
						<p className="form-warning" role="status">
							This grow space is currently inactive.
						</p>
					)}
				</div>
				<Button variant="secondary" onClick={startEditing}>
					<Pencil size={15} /> Edit grow
				</Button>
			</section>

			{editing && draft && (
				<Card className="record-form-card">
					<h2>Edit grow</h2>
					<GrowForm
						mode="edit"
						value={draft}
						onChange={setDraft}
						onSubmit={submit}
						submitting={updateGrow.isPending}
						submitError={
							updateGrow.error instanceof ApiError
								? updateGrow.error.message
								: null
						}
					/>
					<Button variant="ghost" onClick={() => setEditing(false)}>
						Cancel
					</Button>
				</Card>
			)}

			<section className="plant-register">
				<div className="plant-register__head">
					<h2>Plants</h2>
					<a className="add-plant-link" href={`#/grows/${record.id}/plants/new`}>
						<Plus size={15} /> Add plant
					</a>
				</div>
				{record.plants.length === 0 ? (
					<EmptyState
						title="No plants yet"
						description="Add the first plant to this grow to begin tracking its lifecycle."
						icon={Sprout}
					/>
				) : (
					<ul className="plant-row-list">
						{record.plants.map((plant) => (
							<li key={plant.id}>
								<a href={`#/plants/${plant.id}`} className="plant-row">
									<span className="plant-row__name">{plant.name}</span>
									<Badge tone="info">{plant.current_stage.label}</Badge>
									<span className="plant-row__status">{plant.status}</span>
								</a>
							</li>
						))}
					</ul>
				)}
			</section>

			<GrowJournalSection growId={record.id} />
		</div>
	);
}

export function GrowDetailPage() {
	const params = useParams({ strict: false }) as { growId?: string };
	if (!params.growId) return null;
	return <GrowDetailContent growId={params.growId} />;
}
