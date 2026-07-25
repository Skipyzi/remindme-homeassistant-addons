import type { Plant } from "../../api/plants";
import type { PlantDraft } from "./types";

/**
 * Build a creation draft from an existing Plant. Cultivation identity carries
 * over, but no lifecycle history, dates, or notes are copied. The user reviews
 * the draft and submits an ordinary Plant creation request.
 */
export function plantToDuplicateDraft(plant: Plant): PlantDraft {
	return {
		growId: plant.grow.id,
		cultivarId: plant.cultivar.id,
		name: `${plant.name} copy`,
		propagationSource: plant.propagation_source,
		seedType: plant.seed_type ?? "unknown",
		startDate: "",
		currentStageId: plant.current_stage.id,
		status: "planned",
		container: plant.container ?? "",
		medium: plant.medium ?? "",
		location: plant.location ?? "",
		expectedHarvestStart: "",
		expectedHarvestEnd: "",
		actualHarvestDate: "",
		notes: "",
	};
}

/** Build an editing draft that preserves the Plant's current values. */
export function plantToEditDraft(plant: Plant): PlantDraft {
	return {
		growId: plant.grow.id,
		cultivarId: plant.cultivar.id,
		name: plant.name,
		propagationSource: plant.propagation_source,
		seedType: plant.seed_type ?? "unknown",
		startDate: plant.start_date ?? "",
		currentStageId: plant.current_stage.id,
		status: plant.status,
		container: plant.container ?? "",
		medium: plant.medium ?? "",
		location: plant.location ?? "",
		expectedHarvestStart: plant.expected_harvest_start ?? "",
		expectedHarvestEnd: plant.expected_harvest_end ?? "",
		actualHarvestDate: plant.actual_harvest_date ?? "",
		notes: plant.notes ?? "",
	};
}
