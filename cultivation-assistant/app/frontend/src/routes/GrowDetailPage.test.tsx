import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowDetailContent } from "./GrowDetailPage";

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
	plant_count: 1,
	plant_status_counts: { active: 1 },
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
	plants: [
		{
			id: "plant-1",
			name: "North 1",
			status: "active",
			current_stage: { id: "stage-1", key: "seedling", label: "Seedling" },
			start_date: "2026-07-23",
		},
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function routedFetch(grow: unknown = growFixture) {
	return vi.fn((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("journal-entries")) {
			return Promise.resolve(jsonResponse({ items: [] }));
		}
		return Promise.resolve(jsonResponse(grow));
	});
}

function renderDetail() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<GrowDetailContent growId="grow-1" />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GrowDetailContent", () => {
	it("shows grow identity and its plants", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();

		expect(await screen.findByRole("heading", { name: "Summer run" })).toBeVisible();
		expect(screen.getByText("North 1")).toBeVisible();
		expect(screen.getByText("Seedling")).toBeVisible();
	});

	it("shows an empty plant state", async () => {
		vi.stubGlobal("fetch", routedFetch({ ...growFixture, plants: [] }));

		renderDetail();

		expect(await screen.findByText(/no plants yet/i)).toBeVisible();
	});

	it("opens the edit form", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Summer run" });
		await user.click(screen.getByRole("button", { name: /edit grow/i }));

		expect(screen.getByRole("heading", { name: /edit grow/i })).toBeVisible();
		expect(screen.getByRole("button", { name: /save grow/i })).toBeVisible();
	});

	it("warns when the grow space is inactive", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch({ ...growFixture, grow_space_active: false }),
		);

		renderDetail();

		expect(
			await screen.findByText(/grow space is currently inactive/i),
		).toBeVisible();
	});

	it("shows the grow journal section", async () => {
		vi.stubGlobal("fetch", routedFetch());

		renderDetail();
		await screen.findByRole("heading", { name: "Summer run" });

		expect(screen.getByRole("heading", { name: /journal/i })).toBeVisible();
		expect(await screen.findByText(/no journal entries yet/i)).toBeVisible();
	});
});
