import type { Grow, GrowStatus } from "../../api/grows";

export interface GrowDraft {
	growSpaceId: string;
	name: string;
	status: GrowStatus;
	startDate: string;
	endDate: string;
	notes: string;
}

export function emptyGrowDraft(growSpaceId = ""): GrowDraft {
	return {
		growSpaceId,
		name: "",
		status: "planned",
		startDate: "",
		endDate: "",
		notes: "",
	};
}

export function growToDraft(grow: Grow): GrowDraft {
	return {
		growSpaceId: grow.grow_space_id,
		name: grow.name,
		status: grow.status,
		startDate: grow.start_date ?? "",
		endDate: grow.end_date ?? "",
		notes: grow.notes ?? "",
	};
}
