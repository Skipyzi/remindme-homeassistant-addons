import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LifecycleStage } from "../../api/lifecycle";
import { StageTransitionDialog } from "./StageTransitionDialog";

function stage(id: string, key: string, position: number): LifecycleStage {
	return {
		id,
		key,
		label: key[0].toUpperCase() + key.slice(1),
		position,
		enabled: true,
		built_in: true,
		created_at: "2026-07-23T10:00:00Z",
		updated_at: "2026-07-23T10:00:00Z",
	};
}

const stages = [
	stage("s1", "seedling", 0),
	stage("s2", "vegetative", 1),
	stage("s3", "flowering", 2),
];

describe("StageTransitionDialog", () => {
	it("warns and confirms a backward stage change", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<StageTransitionDialog
				stages={stages}
				currentStageId="s3"
				onSubmit={onSubmit}
				onClose={vi.fn()}
			/>,
		);

		await user.selectOptions(
			screen.getByLabelText(/destination stage/i),
			"s2",
		);
		expect(screen.getByText(/does not erase history/i)).toBeVisible();

		await user.click(
			screen.getByRole("button", { name: /confirm stage change/i }),
		);
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ confirmed: true, to_stage_id: "s2" }),
		);
	});

	it("does not warn for an adjacent forward change", () => {
		render(
			<StageTransitionDialog
				stages={stages}
				currentStageId="s1"
				onSubmit={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.queryByText(/does not erase history/i)).not.toBeInTheDocument();
	});
});
