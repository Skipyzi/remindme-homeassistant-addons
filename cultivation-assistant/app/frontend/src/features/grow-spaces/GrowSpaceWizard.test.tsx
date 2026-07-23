import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowSpaceWizard } from "./GrowSpaceWizard";

const growSpaceFixture = {
	id: "space-1",
	name: "North tent",
	description: null,
	location: null,
	space_type: "tent",
	active: true,
	dimensions: { length: "80", width: "80", height: "180", unit: "cm" },
	area_m2: "0.6400",
	volume_m3: "1.1520",
	mapping_count: 0,
	live_readings: [],
	mappings: [],
	created_at: "2026-07-22T12:00:00Z",
	updated_at: "2026-07-22T12:00:00Z",
};

function renderWizard(onCreated = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<GrowSpaceWizard open onClose={vi.fn()} onCreated={onCreated} />
		</QueryClientProvider>,
	);
	return onCreated;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

async function fillDimensions(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText(/^Length/), "80");
	await user.type(screen.getByLabelText(/^Width/), "80");
	await user.type(screen.getByLabelText(/^Height/), "180");
}

describe("GrowSpaceWizard", () => {
	it("creates a grow space without requiring mappings", async () => {
		const user = userEvent.setup();
		const fetcher = vi.fn().mockImplementation((input: string) => {
			const payload = input.includes("home-assistant")
				? { items: [] }
				: growSpaceFixture;
			return Promise.resolve(
				new Response(JSON.stringify(payload), {
					status: input.includes("home-assistant") ? 200 : 201,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		vi.stubGlobal("fetch", fetcher);
		const onCreated = renderWizard();

		await user.type(screen.getByLabelText(/^Name/), "North tent");
		await user.selectOptions(screen.getByLabelText(/Space type/), "tent");
		await fillDimensions(user);
		await user.click(
			screen.getByRole("button", { name: /continue to mappings/i }),
		);
		await user.click(
			screen.getByRole("button", { name: /review grow space/i }),
		);
		await user.click(
			screen.getByRole("button", { name: /create grow space/i }),
		);

		const createCall = fetcher.mock.calls.find(
			([input]) => input === "api/v1/grow-spaces",
		);
		expect(createCall).toBeDefined();
		const request = createCall?.[1] as RequestInit;
		expect(request.method).toBe("POST");
		expect(JSON.parse(String(request.body))).toEqual(
			expect.objectContaining({
				space_type: "tent",
				dimensions: {
					length: "80",
					width: "80",
					height: "180",
					unit: "cm",
				},
				mappings: [],
			}),
		);
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("space-1"));
	});

	it("does not advance without a name", async () => {
		const user = userEvent.setup();
		renderWizard();

		await user.click(
			screen.getByRole("button", { name: /continue to mappings/i }),
		);

		expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
		expect(
			screen.getByRole("heading", { name: /record the space/i }),
		).toBeVisible();
	});

	it("keeps details when navigating back", async () => {
		const user = userEvent.setup();
		renderWizard();

		await user.type(screen.getByLabelText(/^Name/), "North tent");
		await fillDimensions(user);
		await user.click(
			screen.getByRole("button", { name: /continue to mappings/i }),
		);
		await user.click(screen.getByRole("button", { name: /back to details/i }));

		expect(screen.getByLabelText(/^Name/)).toHaveValue("North tent");
		expect(screen.getByLabelText(/^Length/)).toHaveValue("80");
	});

	it("does not advance without required dimensions", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.type(screen.getByLabelText(/^Name/), "North tent");

		await user.click(
			screen.getByRole("button", { name: /continue to mappings/i }),
		);

		expect(screen.getByRole("alert")).toHaveTextContent(/length is required/i);
	});

	it("allows Outdoor without a height", async () => {
		const user = userEvent.setup();
		renderWizard();
		await user.type(screen.getByLabelText(/^Name/), "South plot");
		await user.selectOptions(screen.getByLabelText(/Space type/), "outdoor");
		await user.type(screen.getByLabelText(/^Length/), "200");
		await user.type(screen.getByLabelText(/^Width/), "300");

		await user.click(
			screen.getByRole("button", { name: /continue to mappings/i }),
		);

		expect(
			screen.getByRole("heading", { name: /map sensors to south plot/i }),
		).toBeVisible();
	});
});
