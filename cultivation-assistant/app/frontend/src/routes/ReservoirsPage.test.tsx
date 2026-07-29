import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReservoirsPage } from "./ReservoirsPage";

const summaryFixture = {
	id: "res-1",
	name: "Mixing tank",
	reservoir_type: "mixing_tank",
	primary_grow_space_id: null,
	capacity_liters: "100.0000",
	usable_capacity_liters: "95.0000",
	active: true,
	geometry: {
		shape: "rectangular",
		unit: "cm",
		length: "50",
		width: "40",
		height: "60",
		diameter: null,
	},
	mapping_count: 0,
	live_readings: [],
	created_at: "2026-07-25T12:00:00Z",
	updated_at: "2026-07-25T12:00:00Z",
};

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ReservoirsPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ReservoirsPage", () => {
	it("shows onboarding when no reservoirs exist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ items: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		renderPage();

		expect(await screen.findByText(/create your first reservoir/i)).toBeVisible();
		expect(screen.queryByText("Mixing tank")).not.toBeInTheDocument();
	});

	it("renders reservoirs from the API", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [summaryFixture] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetcher);

		renderPage();

		expect(
			await screen.findByRole("heading", { name: "Mixing tank" }),
		).toBeVisible();
		expect(screen.getByText(/100 L capacity/i)).toBeVisible();
		expect(screen.getByText("Rectangular")).toBeVisible();
		expect(screen.getByText(/L 50 · W 40 · H 60 cm/i)).toBeVisible();
		expect(fetcher).toHaveBeenCalledWith("api/v1/reservoirs", expect.any(Object));
	});

	it("uses inactive lifecycle language", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({ items: [{ ...summaryFixture, active: false }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);

		renderPage();

		expect(await screen.findByText("Inactive")).toBeVisible();
		expect(screen.getByLabelText(/include inactive/i)).toBeVisible();
	});
});
