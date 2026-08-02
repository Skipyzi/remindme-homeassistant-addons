import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GrowForm } from "./GrowForm";
import { emptyGrowDraft } from "./types";

describe("GrowForm", () => {
	it("requires a start date for an active grow", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<GrowForm
				mode="create"
				value={{ ...emptyGrowDraft("space-1"), name: "Summer", status: "active" }}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /create grow/i }));

		expect(screen.getByRole("alert")).toHaveTextContent(/start date is required/i);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits a valid planned grow", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<GrowForm
				mode="create"
				value={{ ...emptyGrowDraft("space-1"), name: "Planned run" }}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /create grow/i }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("warns when the selected grow space is inactive", () => {
		render(
			<GrowForm
				mode="create"
				value={{ ...emptyGrowDraft("space-1"), name: "Ghost" }}
				onChange={vi.fn()}
				onSubmit={vi.fn()}
				growSpaces={[
					{
						id: "space-1",
						name: "Old tent",
						description: null,
						location: null,
						space_type: "tent",
						active: false,
						dimensions: null,
						area_m2: null,
						volume_m3: null,
						mapping_count: 0,
						live_readings: [],
						created_at: "2026-07-23T10:00:00Z",
						updated_at: "2026-07-23T10:00:00Z",
					},
				]}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent(/inactive/i);
	});
});
