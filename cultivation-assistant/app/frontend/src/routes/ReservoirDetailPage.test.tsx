import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReservoirDetailContent } from "./ReservoirDetailPage";

const reservoirFixture = {
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
	mapping_count: 1,
	live_readings: [
		{
			entity_id: "sensor.tank_level",
			role: "level_percentage",
			raw_value: "68",
			normalized_value: "68",
			normalized_unit: "%",
			last_updated: "2026-07-25T12:00:00Z",
			stale: false,
			available: true,
		},
	],
	mappings: [
		{
			id: "map-1",
			reservoir_id: "res-1",
			entity_id: "sensor.tank_level",
			role: "level_percentage",
			display_name: null,
			priority: 100,
			source_unit: "%",
			normalized_unit: "%",
			enabled: true,
			calibration: null,
			stale_after_seconds: 300,
			compatibility: "compatible",
			compatibility_explanation: "Device class and unit match this role.",
			created_at: "2026-07-25T12:00:00Z",
			updated_at: "2026-07-25T12:00:00Z",
		},
	],
	minimum_safe_volume_liters: "10.0000",
	refill_threshold_liters: "20.0000",
	overflow_threshold_liters: "95.0000",
	created_at: "2026-07-25T12:00:00Z",
	updated_at: "2026-07-25T12:00:00Z",
};

const calibrationFixture = { items: [] };

const dashboardFixture = {
	reservoir_id: "res-1",
	capacity_liters: "100.0000",
	usable_capacity_liters: "95.0000",
	refill_threshold_liters: "20.0000",
	current: {
		volume_liters: "60.0000",
		level_percent: "60.0000",
		source_entity_id: "sensor.tank_level",
		role: "level_percentage",
		last_updated: "2026-07-25T12:00:00Z",
		stale: false,
	},
	consumption: {
		daily_liters: "40.0000",
		seven_day_average_liters: "32.0000",
		reading_count_24h: 4,
		history_days: 1.25,
	},
	forecast: {
		remaining_until_refill_liters: "40.0000",
		hours_remaining: "24.00",
		estimated_refill_at: "2026-07-26T12:00:00Z",
	},
	data_quality: "good",
	latest_reading_at: "2026-07-25T12:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function routedFetch(reservoir: unknown = reservoirFixture, dashboard: unknown = dashboardFixture) {
	return vi.fn((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("calibration-points")) {
			return Promise.resolve(jsonResponse(calibrationFixture));
		}
		if (url.includes("reservoir-entities")) {
			return Promise.resolve(jsonResponse({ items: [] }));
		}
		if (url.includes("dashboard")) {
			return Promise.resolve(jsonResponse(dashboard));
		}
		return Promise.resolve(jsonResponse(reservoir));
	});
}

function renderDetail() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ReservoirDetailContent reservoirId="res-1" />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ReservoirDetailContent", () => {
	it("shows reservoir identity, capacity and geometry", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();

		expect(await screen.findByRole("heading", { name: "Mixing tank" })).toBeVisible();
		expect(screen.getByText(/100 L/)).toBeVisible();
		expect(screen.getAllByText(/Rectangular/).length).toBeGreaterThan(0);
		expect(screen.getByText(/L 50 · W 40 · H 60 cm/)).toBeVisible();
	});

	it("renders mapped sensor entities with their live readings", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });

		expect(
			screen.getByRole("heading", { name: /sensor and equipment mappings/i }),
		).toBeVisible();
		expect(screen.getByText("sensor.tank_level")).toBeVisible();
		expect(screen.getByText(/68 %/)).toBeVisible();
	});

	it("renders the reservoir dashboard with volume and refill forecast", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });

		expect(await screen.findByText(/60% of usable volume/i)).toBeVisible();
		expect(screen.getByText(/40\.0 L/)).toBeVisible();
		expect(screen.getByText("~24 h")).toBeVisible();
		expect(
			screen.getByRole("img", { name: /reservoir 60 percent full/i }),
		).toBeVisible();
	});

	it("shows the dashboard empty state without a level source", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch(reservoirFixture, {
				...dashboardFixture,
				current: null,
				consumption: null,
				forecast: null,
				data_quality: "no_level_source",
				latest_reading_at: null,
			}),
		);

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });

		expect(
			await screen.findByText(/map a level percentage, depth, or distance sensor/i),
		).toBeVisible();
	});

	it("shows the calibration table empty state", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });

		expect(
			screen.getByRole("heading", { name: /calibration table/i }),
		).toBeVisible();
		expect(screen.getByRole("button", { name: /edit calibration/i })).toBeVisible();
	});

	it("opens the details editor", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });
		await user.click(screen.getByRole("button", { name: /edit details/i }));

		expect(screen.getByRole("heading", { name: /edit details/i })).toBeVisible();
		expect(screen.getByRole("button", { name: /save changes/i })).toBeVisible();
	});

	it("archives and reactivates the reservoir", async () => {
		const user = userEvent.setup();
		let archived = false;
		const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.includes("calibration-points")) {
				return Promise.resolve(jsonResponse(calibrationFixture));
			}
			if (url.includes("reservoir-entities")) {
				return Promise.resolve(jsonResponse({ items: [] }));
			}
			if (url.includes("dashboard")) {
				return Promise.resolve(jsonResponse(dashboardFixture));
			}
			if (method === "DELETE") {
				archived = true;
				return Promise.resolve(new Response(null, { status: 204 }));
			}
			if (method === "PATCH") {
				archived = false;
				return Promise.resolve(jsonResponse({ ...reservoirFixture, active: true }));
			}
			return Promise.resolve(
				jsonResponse({ ...reservoirFixture, active: !archived }),
			);
		});
		vi.stubGlobal("fetch", fetcher);

		renderDetail();
		await screen.findByRole("heading", { name: "Mixing tank" });

		const archiveButton = await screen.findByRole("button", { name: "Archive" });
		await user.click(archiveButton);

		const reactivate = await screen.findByRole("button", { name: "Reactivate" });
		await user.click(reactivate);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs/res-1",
			expect.objectContaining({ method: "DELETE" }),
		);
	});
});
