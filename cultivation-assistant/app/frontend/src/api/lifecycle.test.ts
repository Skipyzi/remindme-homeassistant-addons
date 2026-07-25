import { describe, expect, it, vi } from "vitest";
import { listLifecycleStages, updateLifecycleStageOrder } from "./lifecycle";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("lifecycle API", () => {
	it("lists disabled stages through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
		await listLifecycleStages(true, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/lifecycle-stages?include_disabled=true",
			expect.any(Object),
		);
	});

	it("submits a complete order to the relative order URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
		await updateLifecycleStageOrder(["stage-2", "stage-1"], fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/lifecycle-stages/order",
			expect.objectContaining({ method: "PUT" }),
		);
		expect(
			JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string),
		).toMatchObject({ stage_ids: ["stage-2", "stage-1"] });
	});
});
