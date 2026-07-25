import { describe, expect, it, vi } from "vitest";
import { createCultivar, listCultivars } from "./library";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const cultivarFixture = {
	id: "cultivar-1",
	name: "Mystery Cut",
	breeder: null,
	seed_type: "unknown",
	active: true,
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

describe("library API", () => {
	it("creates a breederless cultivar through an Ingress-relative URL", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(jsonResponse(cultivarFixture, 201));
		await createCultivar(
			{ name: "Mystery Cut", breeder_id: null, seed_type: "unknown" },
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/cultivars",
			expect.objectContaining({ method: "POST" }),
		);
		expect(
			JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string),
		).toMatchObject({ breeder_id: null });
	});

	it("builds a query-filtered relative list URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
		await listCultivars({ query: "blue" }, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/cultivars?query=blue",
			expect.any(Object),
		);
	});
});
