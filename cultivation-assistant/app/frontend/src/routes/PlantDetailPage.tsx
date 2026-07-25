import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "../api/client";
import { useCreateCultivar, useCultivars } from "../api/library";
import { useLifecycleStages } from "../api/lifecycle";
import {
	useArchivePlant,
	useCreatePlant,
	usePlant,
	useTransitionPlantStage,
	useUpdatePlant,
	type PlantTransition,
} from "../api/plants";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/StatePanel";
import { PlantForm } from "../features/plants/PlantForm";
import { StageTransitionDialog } from "../features/plants/StageTransitionDialog";
import {
	plantToDuplicateDraft,
	plantToEditDraft,
} from "../features/plants/drafts";
import type { PlantDraft } from "../features/plants/types";

type Mode = "view" | "edit" | "duplicate" | "transition";

function sortedHistory(transitions: PlantTransition[]): PlantTransition[] {
	return [...transitions].sort((a, b) =>
		a.effective_at < b.effective_at ? 1 : -1,
	);
}

export function PlantDetailContent({ plantId }: { plantId: string }) {
	const plant = usePlant(plantId);
	const [mode, setMode] = useState<Mode>("view");
	const [draft, setDraft] = useState<PlantDraft | null>(null);

	const cultivars = useCultivars({});
	const stages = useLifecycleStages(false);
	const createCultivar = useCreateCultivar();
	const createPlant = useCreatePlant();
	const updatePlant = useUpdatePlant();
	const transition = useTransitionPlantStage();
	const archivePlant = useArchivePlant();

	const history = useMemo(
		() => (plant.data ? sortedHistory(plant.data.stage_transitions) : []),
		[plant.data],
	);

	if (plant.isLoading) return <LoadingState label="Loading plant" />;
	if (plant.isError || !plant.data) {
		return (
			<div role="alert">
				<ErrorState
					title="Plant unavailable"
					description={plant.error?.message ?? "The plant could not be loaded."}
					actionLabel="Retry"
					onAction={() => plant.refetch()}
				/>
			</div>
		);
	}

	const record = plant.data;
	const isArchived = record.status === "archived";

	async function submitDuplicate(value: PlantDraft) {
		await createPlant.mutateAsync({
			grow_id: value.growId,
			cultivar_id: value.cultivarId,
			name: value.name.trim(),
			propagation_source: value.propagationSource,
			seed_type: value.propagationSource === "clone" ? null : value.seedType,
			start_date: value.startDate || null,
			current_stage_id: value.currentStageId,
			status: value.status,
			container: value.container.trim() || null,
			medium: value.medium.trim() || null,
			location: value.location.trim() || null,
			notes: value.notes.trim() || null,
		});
		setMode("view");
	}

	async function submitEdit(value: PlantDraft) {
		await updatePlant.mutateAsync({
			plantId: record.id,
			input: {
				name: value.name.trim(),
				seed_type: value.propagationSource === "clone" ? null : value.seedType,
				start_date: value.startDate || null,
				status: value.status,
				container: value.container.trim() || null,
				medium: value.medium.trim() || null,
				location: value.location.trim() || null,
				actual_harvest_date: value.actualHarvestDate || null,
				notes: value.notes.trim() || null,
			},
		});
		setMode("view");
	}

	const formError = (error: unknown) =>
		error instanceof ApiError ? error.message : null;

	return (
		<div className="page-stack">
			<a className="back-link" href={`#/grows/${record.grow.id}`}>
				<ArrowLeft size={15} /> Back to {record.grow.name}
			</a>

			<section className="page-heading">
				<div>
					<p className="eyebrow">
						{record.cultivar.name}
						{record.cultivar.breeder_name
							? ` · ${record.cultivar.breeder_name}`
							: ""}
					</p>
					<h1>{record.name}</h1>
					<p>
						{record.grow_space.name} · {record.grow.name}
					</p>
				</div>
				<div className="record-actions">
					<Badge tone="info">{record.current_stage.label}</Badge>
					<Badge tone={isArchived ? "neutral" : "healthy"}>
						{record.status}
					</Badge>
				</div>
			</section>

			<div className="record-actions">
				<Button variant="secondary" onClick={() => {
					setDraft(plantToEditDraft(record));
					setMode("edit");
				}}>
					Edit
				</Button>
				<Button variant="secondary" onClick={() => {
					setDraft(plantToDuplicateDraft(record));
					setMode("duplicate");
				}}>
					Duplicate
				</Button>
				<Button variant="secondary" onClick={() => setMode("transition")}>
					Change stage
				</Button>
				{isArchived ? (
					<Button
						variant="secondary"
						onClick={() =>
							updatePlant.mutate({
								plantId: record.id,
								input: { status: "active" },
							})
						}
					>
						Restore
					</Button>
				) : (
					<Button
						variant="ghost"
						onClick={() => archivePlant.mutate(record.id)}
					>
						Archive
					</Button>
				)}
			</div>

			<Card className="record-panel">
				<h2>Cultivation</h2>
				<dl className="record-facts">
					<div>
						<dt>Source</dt>
						<dd>{record.propagation_source}</dd>
					</div>
					<div>
						<dt>Seed type</dt>
						<dd>{record.seed_type ?? "—"}</dd>
					</div>
					<div>
						<dt>Start date (actual)</dt>
						<dd>{record.start_date ?? "—"}</dd>
					</div>
					<div>
						<dt>Expected harvest (plan)</dt>
						<dd>
							{record.expected_harvest_start ?? "—"}
							{record.expected_harvest_end
								? ` – ${record.expected_harvest_end}`
								: ""}
						</dd>
					</div>
					<div>
						<dt>Actual harvest</dt>
						<dd>{record.actual_harvest_date ?? "—"}</dd>
					</div>
					<div>
						<dt>Container</dt>
						<dd>{record.container ?? "—"}</dd>
					</div>
				</dl>
			</Card>

			<Card className="record-panel">
				<h2>Lifecycle history</h2>
				<ol className="transition-history">
					{history.map((item) => (
						<li key={item.id}>
							<span className="transition-history__stage">
								{stages.data?.find((stage) => stage.id === item.to_stage_id)
									?.label ?? item.to_stage_id}
							</span>
							<span className="transition-history__meta">
								Effective {item.effective_at} · recorded {item.created_at} ·{" "}
								{item.source}
							</span>
							{item.notes && (
								<span className="transition-history__notes">{item.notes}</span>
							)}
						</li>
					))}
				</ol>
			</Card>

			{mode === "transition" && (
				<StageTransitionDialog
					stages={stages.data ?? []}
					currentStageId={record.current_stage.id}
					onSubmit={(input) =>
						transition.mutate(
							{ plantId: record.id, input },
							{ onSuccess: () => setMode("view") },
						)
					}
					onClose={() => setMode("view")}
					submitting={transition.isPending}
					submitError={
						transition.error instanceof ApiError
							? transition.error.message
							: null
					}
				/>
			)}

			{(mode === "edit" || mode === "duplicate") && draft && (
				<Card className="record-form-card">
					<h2>{mode === "edit" ? "Edit plant" : "Duplicate plant"}</h2>
					<PlantForm
						mode={mode === "edit" ? "edit" : "create"}
						value={draft}
						onChange={setDraft}
						onSubmit={mode === "edit" ? submitEdit : submitDuplicate}
						cultivars={cultivars.data ?? []}
						stages={stages.data ?? []}
						onCreateCultivar={(input) => createCultivar.mutateAsync(input)}
						submitting={createPlant.isPending || updatePlant.isPending}
						submitError={formError(
							mode === "edit" ? updatePlant.error : createPlant.error,
						)}
					/>
					<Button variant="ghost" onClick={() => setMode("view")}>
						Cancel
					</Button>
				</Card>
			)}
		</div>
	);
}

export function PlantDetailPage() {
	const params = useParams({ strict: false }) as { plantId?: string };
	if (!params.plantId) return null;
	return <PlantDetailContent plantId={params.plantId} />;
}
