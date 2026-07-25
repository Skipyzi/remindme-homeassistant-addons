import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LifecycleStage } from "../../api/lifecycle";
import { LifecycleStageSettings } from "./LifecycleStageSettings";

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
	stage("s1", "seed", 0),
	stage("s2", "seedling", 1),
	stage("s3", "vegetative", 2),
];

function renderSettings(overrides = {}) {
	const props = {
		stages,
		onReorder: vi.fn(),
		onRename: vi.fn(),
		onToggle: vi.fn(),
		onCreate: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
	render(<LifecycleStageSettings {...props} />);
	return props;
}

describe("LifecycleStageSettings", () => {
	it("keyboard-reorders stages and submits the complete order", async () => {
		const user = userEvent.setup();
		const onReorder = vi.fn();
		renderSettings({ onReorder });

		screen.getByRole("button", { name: /move seedling up/i }).focus();
		await user.keyboard("{Enter}");

		expect(onReorder).toHaveBeenCalledWith(["s2", "s1", "s3"]);
	});

	it("explains that disabling preserves history", () => {
		renderSettings();
		expect(
			screen.getByText(/existing history is preserved/i),
		).toBeVisible();
	});
});
