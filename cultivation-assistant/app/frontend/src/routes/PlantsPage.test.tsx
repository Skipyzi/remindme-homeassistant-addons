import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlantsPage } from "./PlantsPage";

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
	plant_count: 3,
	plant_status_counts: { active: 3 },
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function routedFetch(handlers: {
	grows?: () => Response;
	spaces?: () => Response;
}) {
	return vi.fn((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("api/v1/grows")) {
			return Promise.resolve(
				handlers.grows?.() ?? jsonResponse({ items: [] }),
			);
		}
		return Promise.resolve(
			handlers.spaces?.() ?? jsonResponse({ items: [] }),
		);
	});
}

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<PlantsPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PlantsPage", () => {
	it("groups grows by grow space and exposes active plant counts", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch({ grows: () => jsonResponse({ items: [growFixture] }) }),
		);

		renderPage();

		expect(
			await screen.findByRole("heading", { name: "North tent" }),
		).toBeVisible();
		expect(screen.getByRole("heading", { name: "Summer run" })).toBeVisible();
		expect(screen.getByText(/3 active plants/i)).toBeVisible();
	});

	it("offers a recovery action when grows fail to load", async () => {
		vi.stubGlobal(
			"fetch",
			routedFetch({
				grows: () =>
					jsonResponse(
						{
							error: {
								code: "server_error",
								message: "Register unavailable",
								details: {},
							},
						},
						500,
					),
			}),
		);

		renderPage();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Register unavailable",
		);
		expect(
			screen.getByRole("button", { name: /retry loading grows/i }),
		).toBeVisible();
	});

	it("shows an empty state when there are no grows", async () => {
		vi.stubGlobal("fetch", routedFetch({}));

		renderPage();

		expect(await screen.findByText(/no grows yet/i)).toBeVisible();
	});
});
