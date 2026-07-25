import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Cultivar } from "../../api/library";
import type { LifecycleStage } from "../../api/lifecycle";
import { PlantForm } from "./PlantForm";
import { emptyPlantDraft } from "./types";

const cultivars: Cultivar[] = [
	{
		id: "cultivar-1",
		name: "Blue Dream",
		breeder: null,
		seed_type: "feminized",
		active: true,
		created_at: "2026-07-23T10:00:00Z",
		updated_at: "2026-07-23T10:00:00Z",
	},
];

const stages: LifecycleStage[] = [
	{
		id: "stage-seedling",
		key: "seedling",
		label: "Seedling",
		position: 0,
		enabled: true,
		built_in: true,
		created_at: "2026-07-23T10:00:00Z",
		updated_at: "2026-07-23T10:00:00Z",
	},
];

function baseDraft() {
	return {
		...emptyPlantDraft("grow-1"),
		name: "North 1",
		cultivarId: "cultivar-1",
		currentStageId: "stage-seedling",
	};
}

function renderForm(overrides: Partial<Parameters<typeof PlantForm>[0]> = {}) {
	return render(
		<PlantForm
			mode="create"
			value={baseDraft()}
			onChange={vi.fn()}
			onSubmit={vi.fn()}
			cultivars={cultivars}
			stages={stages}
			onCreateCultivar={vi.fn()}
			{...overrides}
		/>,
	);
}

describe("PlantForm", () => {
	it("hides seed type for clones", async () => {
		const user = userEvent.setup();
		let current = { ...baseDraft() };
		const onChange = vi.fn((next) => {
			current = next;
		});
		const { rerender } = renderForm({ value: current, onChange });

		await user.selectOptions(screen.getByLabelText(/source/i), "clone");
		rerender(
			<PlantForm
				mode="create"
				value={current}
				onChange={onChange}
				onSubmit={vi.fn()}
				cultivars={cultivars}
				stages={stages}
				onCreateCultivar={vi.fn()}
			/>,
		);

		expect(screen.queryByLabelText(/seed type/i)).not.toBeInTheDocument();
	});

	it("requires a cultivar before submitting", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderForm({ value: { ...baseDraft(), cultivarId: "" }, onSubmit });

		await user.click(screen.getByRole("button", { name: /create plant/i }));

		expect(screen.getByRole("alert")).toHaveTextContent(/cultivar/i);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits a valid plant", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderForm({ onSubmit });

		await user.click(screen.getByRole("button", { name: /create plant/i }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
});
