import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowSpacesPage } from "./GrowSpacesPage";

const summaryFixture = {
	id: "space-1",
	name: "Production tent",
	description: "Flowering area",
	location: "Basement",
	space_type: "tent",
	active: true,
	dimensions: { length: "80", width: "80", height: "180", unit: "cm" },
	area_m2: "0.6400",
	volume_m3: "1.1520",
	mapping_count: 2,
	live_readings: [
		{
			entity_id: "sensor.production_temperature",
			role: "air_temperature",
			raw_value: "24",
			normalized_value: "24",
			normalized_unit: "°C",
			last_updated: "2026-07-22T12:00:00Z",
			stale: false,
			available: true,
		},
	],
	created_at: "2026-07-22T12:00:00Z",
	updated_at: "2026-07-22T12:00:00Z",
};

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<GrowSpacesPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GrowSpacesPage", () => {
	it("shows onboarding when no grow spaces exist", async () => {
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

		expect(
			await screen.findByText(/create your first grow space/i),
		).toBeVisible();
		expect(screen.queryByText("North tent")).not.toBeInTheDocument();
	});

	it("renders API grow spaces instead of fixtures", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [summaryFixture] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetcher);

		renderPage();

		expect(await screen.findByText("Production tent")).toBeVisible();
		expect(screen.getByText("80 × 80 × 180 cm")).toBeVisible();
		expect(screen.getByText(/2 mapped entities/i)).toBeVisible();
		expect(screen.getByText("24 °C")).toBeVisible();
		expect(screen.queryByText("Propagation shelf")).not.toBeInTheDocument();
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/grow-spaces",
			expect.any(Object),
		);
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
		expect(screen.queryByText("Archived")).not.toBeInTheDocument();
	});

	it("marks removed type values as legacy without inventing dimensions", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						items: [
							{
								...summaryFixture,
								space_type: "cabinet",
								dimensions: null,
								area_m2: "1.2000",
								volume_m3: "2.4000",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);

		renderPage();

		expect(await screen.findByText(/legacy type/i)).toBeVisible();
		expect(screen.getByText(/1.20 m²/)).toBeVisible();
	});
});
