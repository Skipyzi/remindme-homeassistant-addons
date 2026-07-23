import { describe, expect, it, vi } from "vitest";
import {
	createGrowSpace,
	discoverEntities,
	listGrowSpaces,
} from "./growSpaces";

const growSpaceFixture = {
	id: "space-1",
	name: "North tent",
	description: null,
	location: "Basement",
	space_type: "tent",
	active: true,
	area_m2: "1.4400",
	volume_m3: "2.8800",
	mapping_count: 0,
	live_readings: [],
	mappings: [],
	created_at: "2026-07-22T12:00:00Z",
	updated_at: "2026-07-22T12:00:00Z",
};

describe("grow spaces API", () => {
	it("creates a grow space through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(growSpaceFixture), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await createGrowSpace(
			{ name: "North tent", space_type: "tent", mappings: [] },
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/grow-spaces",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("rejects a malformed grow-space response", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [{}] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(listGrowSpaces(false, fetcher)).rejects.toThrow(
			"Invalid grow-space response",
		);
	});

	it("uses a role-filtered relative discovery URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await discoverEntities("air_temperature", fetcher);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/home-assistant/entities?role=air_temperature",
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		);
	});
});
