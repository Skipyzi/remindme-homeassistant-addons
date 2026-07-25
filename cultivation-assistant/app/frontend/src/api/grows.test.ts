import { describe, expect, it, vi } from "vitest";
import { createGrow, listGrows } from "./grows";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const growFixture = {
	id: "grow-1",
	grow_space_id: "space-1",
	grow_space_name: "North tent",
	grow_space_active: true,
	name: "Summer run",
	status: "active",
	start_date: "2026-07-23",
	end_date: null,
	notes: null,
	plant_count: 0,
	plant_status_counts: {},
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
	plants: [],
};

describe("grows API", () => {
	it("creates a Grow through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(growFixture, 201));
		await createGrow(
			{
				grow_space_id: "space-1",
				name: "Summer run",
				status: "active",
				start_date: "2026-07-23",
			},
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/grows",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("builds a filtered relative list URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
		await listGrows({ growSpaceId: "space-1", statuses: ["planned"] }, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/grows?grow_space_id=space-1&status=planned",
			expect.any(Object),
		);
	});
});
