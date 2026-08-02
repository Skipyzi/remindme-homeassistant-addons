import { describe, expect, it } from "vitest";
import type { Plant } from "../../api/plants";
import { plantToDuplicateDraft } from "./drafts";

const plantFixture: Plant = {
	id: "plant-1",
	grow: { id: "grow-1", name: "Summer run" },
	grow_space: { id: "space-1", name: "North tent" },
	cultivar: { id: "cultivar-1", name: "House cut", breeder_name: "Sensi" },
	name: "North 1",
	propagation_source: "seed",
	seed_type: "feminized",
	start_date: "2026-07-23",
	current_stage: { id: "stage-current", key: "seedling", label: "Seedling" },
	status: "active",
	container: "Pot A",
	medium: "Coco",
	location: "Row 1",
	expected_harvest_start: "2026-10-01",
	expected_harvest_end: "2026-10-14",
	actual_harvest_date: null,
	notes: "Healthy",
	stage_transitions: [],
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

describe("plantToDuplicateDraft", () => {
	it("prefills cultivation identity but clears lifecycle history", () => {
		const draft = plantToDuplicateDraft(plantFixture);
		expect(draft.growId).toBe("grow-1");
		expect(draft.cultivarId).toBe("cultivar-1");
		expect(draft.name).toBe("North 1 copy");
		expect(draft.startDate).toBe("");
		expect(draft.status).toBe("planned");
		expect(draft.currentStageId).toBe("stage-current");
		expect(draft.actualHarvestDate).toBe("");
		expect(draft.notes).toBe("");
		expect("stageTransitions" in draft).toBe(false);
	});

	it("carries cultivation details forward", () => {
		const draft = plantToDuplicateDraft(plantFixture);
		expect(draft.container).toBe("Pot A");
		expect(draft.medium).toBe("Coco");
		expect(draft.location).toBe("Row 1");
		expect(draft.expectedHarvestStart).toBe("");
	});
});
