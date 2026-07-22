import { describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./system";

describe("fetchHealth", () => {
	it("uses an Ingress-relative API path", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "healthy", version: "0.1.0" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(fetchHealth(fetcher)).resolves.toEqual({
			status: "healthy",
			version: "0.1.0",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/health",
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		);
	});

	it("rejects responses outside the API contract", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(fetchHealth(fetcher)).rejects.toThrow(
			"Invalid health response",
		);
	});
});
