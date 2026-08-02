import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlantDetailContent } from "./PlantDetailPage";

const plantFixture = {
	id: "plant-1",
	grow: { id: "grow-1", name: "Summer run" },
	grow_space: { id: "space-1", name: "North tent" },
	cultivar: { id: "cultivar-1", name: "House cut", breeder_name: null },
	name: "North 1",
	propagation_source: "seed",
	seed_type: "feminized",
	start_date: "2026-07-23",
	current_stage: { id: "stage-1", key: "seedling", label: "Seedling" },
	status: "active",
	container: "Pot A",
	medium: "Coco",
	location: "Row 1",
	expected_harvest_start: null,
	expected_harvest_end: null,
	actual_harvest_date: null,
	notes: null,
	stage_transitions: [
		{
			id: "t-1",
			from_stage_id: null,
			to_stage_id: "stage-1",
			effective_at: "2026-07-23T10:00:00Z",
			source: "user_confirmed",
			notes: null,
			created_at: "2026-07-23T10:00:00Z",
		},
	],
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

const timelineFixture = {
	items: [
		{
			id: "stage_transition:t-1",
			event_type: "stage_changed",
			occurred_at: "2026-07-23T10:00:00Z",
			summary: "→ Seedling",
			journal_entry: null,
			measurement: null,
			photo: null,
			stage_transition: {
				id: "t-1",
				from_stage: null,
				to_stage: { id: "stage-1", key: "seedling", label: "Seedling" },
				effective_at: "2026-07-23T10:00:00Z",
				source: "user_confirmed",
				notes: null,
				created_at: "2026-07-23T10:00:00Z",
			},
		},
	],
};

const photoFixture = {
	id: "photo-1",
	plant_id: "plant-1",
	journal_entry_id: null,
	measurement_id: null,
	stage: null,
	caption: "Week 3",
	tags: [],
	content_type: "image/png",
	file_size: 42,
	occurred_at: "2026-07-23T10:00:00Z",
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function routedFetch() {
	return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("api/v1/plants/plant-1/timeline")) {
			return Promise.resolve(jsonResponse(timelineFixture));
		}
		if (url.startsWith("api/v1/plants/plant-1/photos")) {
			if (init?.method === "POST") {
				return Promise.resolve(jsonResponse(photoFixture, 201));
			}
			return Promise.resolve(jsonResponse({ items: [photoFixture] }));
		}
		if (url.startsWith("api/v1/plants/plant-1/journal-entries") && init?.method === "POST") {
			return Promise.resolve(
				jsonResponse(
					{
						id: "entry-1",
						subject_type: "plant",
						subject_id: "plant-1",
						entry_type: "note",
						occurred_at: "2026-07-25T10:00:00Z",
						title: "Topped today",
						notes: null,
						tags: [],
						related_stage: null,
						related_issue: null,
						created_at: "2026-07-25T10:00:00Z",
						updated_at: "2026-07-25T10:00:00Z",
					},
					201,
				),
			);
		}
		if (url.startsWith("api/v1/plants/plant-1")) {
			return Promise.resolve(jsonResponse(plantFixture));
		}
		if (url.startsWith("api/v1/lifecycle-stages")) {
			return Promise.resolve(
				jsonResponse({
					items: [
						{
							id: "stage-1",
							key: "seedling",
							label: "Seedling",
							position: 0,
							enabled: true,
							built_in: true,
							created_at: "2026-07-23T10:00:00Z",
							updated_at: "2026-07-23T10:00:00Z",
						},
					],
				}),
			);
		}
		return Promise.resolve(jsonResponse({ items: [] }));
	});
}

function renderDetail() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<PlantDetailContent plantId="plant-1" />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PlantDetailContent", () => {
	it("renders identity and merged activity timeline", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();

		expect(await screen.findByRole("heading", { name: "North 1" })).toBeVisible();
		expect(screen.getAllByText("Seedling").length).toBeGreaterThan(0);
		expect(screen.getByText(/user_confirmed/i)).toBeVisible();
	});

	it("opens Duplicate as a reviewed new-plant form", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "North 1" });
		await user.click(screen.getByRole("button", { name: /duplicate/i }));

		expect(screen.getByLabelText(/plant name/i)).toHaveValue("North 1 copy");
		expect(screen.getByLabelText(/start date/i)).toHaveValue("");
	});

	it("adds a note through the composer", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "North 1" });
		await user.click(screen.getByRole("button", { name: /add note/i }));
		await user.type(screen.getByLabelText(/^title$/i), "Topped today");
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		expect(
			await screen.findByRole("button", { name: /^save$/i }).catch(() => null),
		).toBeFalsy();
	});

	it("switches to the Photos tab and shows uploaded photos", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "North 1" });
		await user.click(screen.getByRole("tab", { name: /photos/i }));

		expect(await screen.findByAltText("Week 3")).toBeVisible();
	});
});
