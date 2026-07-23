import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowSpaceDetailContent } from "./GrowSpaceDetailPage";

const detailFixture = {
	id: "space-1",
	name: "North tent",
	description: "Main flowering premises",
	location: "Basement",
	space_type: "tent",
	active: true,
	dimensions: { length: "80", width: "80", height: "180", unit: "cm" },
	area_m2: "0.6400",
	volume_m3: "1.1520",
	mapping_count: 1,
	live_readings: [
		{
			entity_id: "sensor.north_temperature",
			role: "air_temperature",
			raw_value: "24",
			normalized_value: "24",
			normalized_unit: "°C",
			last_updated: "2026-07-22T12:00:00Z",
			stale: false,
			available: true,
		},
	],
	mappings: [
		{
			id: "mapping-1",
			grow_space_id: "space-1",
			entity_id: "sensor.north_temperature",
			role: "air_temperature",
			display_name: null,
			priority: 100,
			source_unit: "°C",
			normalized_unit: "°C",
			enabled: true,
			calibration: null,
			stale_after_seconds: 300,
			compatibility: "compatible",
			compatibility_explanation: "Device class and unit match this role.",
			created_at: "2026-07-22T12:00:00Z",
			updated_at: "2026-07-22T12:00:00Z",
		},
	],
	created_at: "2026-07-22T12:00:00Z",
	updated_at: "2026-07-22T12:00:00Z",
};

function renderDetail() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<GrowSpaceDetailContent growSpaceId="space-1" />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GrowSpaceDetailContent", () => {
	it("shows universal capabilities and environmental records", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(detailFixture), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		renderDetail();

		expect(
			await screen.findByRole("heading", { name: "North tent" }),
		).toBeVisible();
		expect(screen.getByText("80 × 80 × 180 cm")).toBeVisible();
		expect(screen.getByText("sensor.north_temperature")).toBeVisible();
		expect(screen.getByText("24 °C")).toBeVisible();
		expect(
			screen.getByText(/equipment can be attached after setup/i),
		).toBeVisible();
		expect(screen.getByText(/targets and schedules/i)).toBeVisible();
	});

	it("edits core details and reversible status", async () => {
		const user = userEvent.setup();
		const fetcher = vi.fn().mockImplementation(
			(_input: string, init?: RequestInit) => {
				const payload =
					init?.method === "PATCH"
						? { ...detailFixture, location: "Garage", active: false }
						: detailFixture;
				return Promise.resolve(
					new Response(JSON.stringify(payload), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			},
		);
		vi.stubGlobal("fetch", fetcher);
		renderDetail();
		await screen.findByRole("heading", { name: "North tent" });

		await user.click(screen.getByRole("button", { name: /edit details/i }));
		await user.clear(screen.getByLabelText(/Location/));
		await user.type(screen.getByLabelText(/Location/), "Garage");
		await user.click(screen.getByRole("radio", { name: "Inactive" }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const patchCall = fetcher.mock.calls.find(
			([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
		);
		expect(patchCall).toBeDefined();
		expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual(
			expect.objectContaining({ location: "Garage", active: false }),
		);
		expect(screen.queryByText(/archive this grow space/i)).not.toBeInTheDocument();
	});
});
