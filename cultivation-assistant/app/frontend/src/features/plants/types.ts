import type { PlantStatus, PropagationSource } from "../../api/plants";

export interface PlantDraft {
	growId: string;
	cultivarId: string;
	name: string;
	propagationSource: PropagationSource;
	seedType: string;
	startDate: string;
	currentStageId: string;
	status: PlantStatus;
	container: string;
	medium: string;
	location: string;
	expectedHarvestStart: string;
	expectedHarvestEnd: string;
	actualHarvestDate: string;
	notes: string;
}

export function emptyPlantDraft(growId: string): PlantDraft {
	return {
		growId,
		cultivarId: "",
		name: "",
		propagationSource: "seed",
		seedType: "unknown",
		startDate: "",
		currentStageId: "",
		status: "planned",
		container: "",
		medium: "",
		location: "",
		expectedHarvestStart: "",
		expectedHarvestEnd: "",
		actualHarvestDate: "",
		notes: "",
	};
}
