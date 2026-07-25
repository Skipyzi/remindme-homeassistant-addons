import { describe, expect, it, vi } from "vitest";
import { createPlant, listPlants, transitionPlantStage } from "./plants";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const plantFixture = {
	id: "plant-1",
	grow: { id: "grow-1", name: "Summer run" },
	grow_space: { id: "space-1", name: "North tent" },
	cultivar: { id: "cultivar-1", name: "House cut", breeder_name: null },
	name: "North 1",
	propagation_source: "seed",
	seed_type: "feminized",
	start_date: "2026-07-23",
	current_stage: { id: "stage-current", key: "seedling", label: "Seedling" },
	status: "active",
	container: null,
	medium: null,
	location: null,
	expected_harvest_start: null,
	expected_harvest_end: null,
	actual_harvest_date: null,
	notes: null,
	stage_transitions: [
		{
			id: "t-1",
			from_stage_id: null,
			to_stage_id: "stage-current",
			effective_at: "2026-07-23T10:00:00Z",
			source: "user_confirmed",
			notes: null,
			created_at: "2026-07-23T10:00:00Z",
		},
	],
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

const transitionFixture = {
	transition: {
		id: "t-2",
		from_stage_id: "stage-current",
		to_stage_id: "stage-2",
		effective_at: "2026-07-24T10:00:00Z",
		source: "user_confirmed",
		notes: null,
		created_at: "2026-07-24T10:00:00Z",
	},
	plant: { ...plantFixture, current_stage: { id: "stage-2", key: "vegetative", label: "Vegetative" } },
};

describe("plants API", () => {
	it("creates a Plant through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(plantFixture, 201));
		await createPlant(
			{
				grow_id: "grow-1",
				cultivar_id: "cultivar-1",
				name: "North 1",
				propagation_source: "seed",
				seed_type: "feminized",
				current_stage_id: "stage-current",
				status: "active",
				start_date: "2026-07-23",
			},
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("submits explicit transition confirmation", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(jsonResponse(transitionFixture, 201));
		await transitionPlantStage(
			"plant-1",
			{
				to_stage_id: "stage-2",
				effective_at: "2026-07-23T10:00:00Z",
				confirmed: true,
			},
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants/plant-1/stage-transitions",
			expect.objectContaining({ method: "POST" }),
		);
		expect(
			JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string),
		).toMatchObject({ confirmed: true });
	});

	it("builds a status-filtered relative list URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
		await listPlants({ growId: "grow-1", statuses: ["active", "planned"] }, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants?grow_id=grow-1&status=active&status=planned",
			expect.any(Object),
		);
	});
});
