import { useMemo, useState } from "react";
import { ArrowRight, Plus, Sprout } from "lucide-react";
import { useGrows, useCreateGrow, type GrowSummary } from "../api/grows";
import { useGrowSpaces } from "../api/growSpaces";
import { ApiError } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/StatePanel";
import { GrowForm } from "../features/grows/GrowForm";
import { emptyGrowDraft, type GrowDraft } from "../features/grows/types";

function groupBySpace(grows: GrowSummary[]): Map<string, GrowSummary[]> {
	const groups = new Map<string, GrowSummary[]>();
	for (const grow of grows) {
		const key = grow.grow_space_name;
		const bucket = groups.get(key) ?? [];
		bucket.push(grow);
		groups.set(key, bucket);
	}
	return groups;
}

function activeCount(grow: GrowSummary): number {
	return grow.plant_status_counts.active ?? 0;
}

export function PlantsPage() {
	const [includeArchived, setIncludeArchived] = useState(false);
	const [formOpen, setFormOpen] = useState(false);
	const [draft, setDraft] = useState<GrowDraft>(() => emptyGrowDraft());
	const grows = useGrows({ includeArchived });
	const growSpaces = useGrowSpaces(true);
	const createGrow = useCreateGrow();

	const groups = useMemo(
		() => groupBySpace(grows.data ?? []),
		[grows.data],
	);

	function openForm() {
		const firstSpace = growSpaces.data?.items[0]?.id ?? "";
		setDraft(emptyGrowDraft(firstSpace));
		createGrow.reset();
		setFormOpen(true);
	}

	async function submit(value: GrowDraft) {
		const grow = await createGrow.mutateAsync({
			grow_space_id: value.growSpaceId,
			name: value.name.trim(),
			status: value.status,
			start_date: value.startDate || null,
			end_date: value.endDate || null,
			notes: value.notes.trim() || null,
		});
		setFormOpen(false);
		window.location.hash = `/grows/${grow.id}`;
	}

	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Grows & plants</p>
					<h1>Plants</h1>
					<p>
						Group your cultivation cycles by physical space, then track each
						plant's lifecycle and history.
					</p>
				</div>
				<Button onClick={openForm}>
					<Plus size={17} /> New grow
				</Button>
			</section>

			<div className="space-list-controls">
				<label>
					<input
						checked={includeArchived}
						type="checkbox"
						onChange={(event) => setIncludeArchived(event.target.checked)}
					/>
					Include archived grows
				</label>
			</div>

			{formOpen && (
				<Card className="record-form-card">
					<h2>New grow</h2>
					<GrowForm
						mode="create"
						value={draft}
						onChange={setDraft}
						onSubmit={submit}
						growSpaces={growSpaces.data?.items ?? []}
						submitting={createGrow.isPending}
						submitError={
							createGrow.error instanceof ApiError
								? createGrow.error.message
								: createGrow.isError
									? "The grow could not be created."
									: null
						}
					/>
					<Button variant="ghost" onClick={() => setFormOpen(false)}>
						Cancel
					</Button>
				</Card>
			)}

			{grows.isLoading && <LoadingState label="Loading grows" />}

			{grows.isError && (
				<div role="alert">
					<ErrorState
						title="Register unavailable"
						description={grows.error.message}
						actionLabel="Retry loading grows"
						onAction={() => grows.refetch()}
					/>
				</div>
			)}

			{grows.data && grows.data.length === 0 && !formOpen && (
				<EmptyState
					title="No grows yet"
					description="Create your first grow to start adding plants and lifecycle history."
					icon={Sprout}
					actionLabel="Create grow"
					onAction={openForm}
				/>
			)}

			{grows.data && grows.data.length > 0 && (
				<div className="grow-groups">
					{[...groups.entries()].map(([spaceName, spaceGrows]) => (
						<section key={spaceName} className="grow-group">
							<h2>{spaceName}</h2>
							<div className="grow-card-list">
								{spaceGrows.map((grow) => (
									<Card key={grow.id} className="grow-card">
										<div className="grow-card__head">
											<h3>{grow.name}</h3>
											<Badge tone={grow.status === "active" ? "healthy" : "neutral"}>
												{grow.status}
											</Badge>
										</div>
										<p className="grow-card__meta">
											{grow.plant_count}{" "}
											{grow.plant_count === 1 ? "plant" : "plants"}
											{" · "}
											{activeCount(grow)} active plants
										</p>
										{grow.start_date && (
											<p className="grow-card__dates">
												Started {grow.start_date}
											</p>
										)}
										<button
											type="button"
											className="grow-card__link"
											onClick={() => {
												window.location.hash = `/grows/${grow.id}`;
											}}
										>
											Open grow <ArrowRight size={14} />
										</button>
									</Card>
								))}
							</div>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
