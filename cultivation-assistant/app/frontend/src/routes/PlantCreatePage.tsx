import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "../api/client";
import { useCreateCultivar, useCultivars } from "../api/library";
import { useLifecycleStages } from "../api/lifecycle";
import { useCreatePlant } from "../api/plants";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/StatePanel";
import { PlantForm } from "../features/plants/PlantForm";
import { emptyPlantDraft, type PlantDraft } from "../features/plants/types";

export function PlantCreateContent({ growId }: { growId: string }) {
	const cultivars = useCultivars({});
	const stages = useLifecycleStages(false);
	const createCultivar = useCreateCultivar();
	const createPlant = useCreatePlant();
	const [draft, setDraft] = useState<PlantDraft>(() => emptyPlantDraft(growId));

	if (cultivars.isLoading || stages.isLoading) {
		return <LoadingState label="Loading plant form" />;
	}

	async function submit(value: PlantDraft) {
		const plant = await createPlant.mutateAsync({
			grow_id: growId,
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
			expected_harvest_start: value.expectedHarvestStart || null,
			expected_harvest_end: value.expectedHarvestEnd || null,
			actual_harvest_date: value.actualHarvestDate || null,
			notes: value.notes.trim() || null,
		});
		window.location.hash = `/plants/${plant.id}`;
	}

	return (
		<div className="page-stack">
			<a className="back-link" href={`#/grows/${growId}`}>
				<ArrowLeft size={15} /> Back to grow
			</a>
			<section className="page-heading">
				<div>
					<p className="eyebrow">New plant</p>
					<h1>Add a plant</h1>
				</div>
			</section>
			<Card className="record-form-card">
				<PlantForm
					mode="create"
					value={draft}
					onChange={setDraft}
					onSubmit={submit}
					cultivars={cultivars.data ?? []}
					stages={stages.data ?? []}
					onCreateCultivar={(input) => createCultivar.mutateAsync(input)}
					submitting={createPlant.isPending}
					submitError={
						createPlant.error instanceof ApiError
							? createPlant.error.message
							: null
					}
				/>
			</Card>
		</div>
	);
}

export function PlantCreatePage() {
	const params = useParams({ strict: false }) as { growId?: string };
	if (!params.growId) return null;
	return <PlantCreateContent growId={params.growId} />;
}
