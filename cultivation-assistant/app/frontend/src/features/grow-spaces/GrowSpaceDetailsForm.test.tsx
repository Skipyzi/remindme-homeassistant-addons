import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GrowSpaceDetailsForm } from "./GrowSpaceDetailsForm";
import {
	emptyGrowSpaceDetailsDraft,
	type GrowSpaceDetailsDraft,
} from "./types";

function DetailsHarness({ mode = "create" }: { mode?: "create" | "edit" }) {
	const [value, setValue] = useState<GrowSpaceDetailsDraft>(
		emptyGrowSpaceDetailsDraft,
	);
	return (
		<GrowSpaceDetailsForm
			mode={mode}
			value={value}
			onChange={setValue}
		/>
	);
}

describe("GrowSpaceDetailsForm", () => {
	it("offers only the four physical space types", () => {
		render(<DetailsHarness />);
		const options = within(screen.getByLabelText(/Space type/))
			.getAllByRole("option")
			.map((option) => option.textContent);

		expect(options).toEqual(["Indoor Tent", "Greenhouse", "Outdoor", "Room"]);
		expect(options).not.toContain("Cabinet");
		expect(options).not.toContain("Hydroponic system");
	});

	it("previews area and volume from linear dimensions", async () => {
		const user = userEvent.setup();
		render(<DetailsHarness />);

		await user.type(screen.getByLabelText(/^Length/), "80");
		await user.type(screen.getByLabelText(/^Width/), "80");
		await user.type(screen.getByLabelText(/^Height/), "180");

		expect(screen.getByText("0.64 m²")).toBeVisible();
		expect(screen.getByText("1.152 m³")).toBeVisible();
	});

	it("converts entered values when switching the shared unit", async () => {
		const user = userEvent.setup();
		render(<DetailsHarness />);
		await user.type(screen.getByLabelText(/^Length/), "80");
		await user.type(screen.getByLabelText(/^Width/), "80");
		await user.type(screen.getByLabelText(/^Height/), "180");

		await user.selectOptions(screen.getByLabelText(/dimension unit/i), "in");

		expect(screen.getByLabelText(/^Length/)).toHaveValue("31.5");
		expect(screen.getByLabelText(/^Width/)).toHaveValue("31.5");
		expect(screen.getByLabelText(/^Height/)).toHaveValue("70.87");
	});

	it("makes height optional for Outdoor", async () => {
		const user = userEvent.setup();
		render(<DetailsHarness />);

		await user.selectOptions(screen.getByLabelText(/Space type/), "outdoor");

		expect(screen.getByLabelText(/Height · optional/)).toBeVisible();
	});

	it("shows reversible status only while editing", () => {
		const { rerender } = render(<DetailsHarness />);
		expect(screen.queryByText("Inactive")).not.toBeInTheDocument();

		rerender(<DetailsHarness mode="edit" />);
		expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "Inactive" })).not.toBeChecked();
	});
});
