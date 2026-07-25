import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhotoGrid } from "./PhotoGrid";

const photoFixture = {
	id: "photo-1",
	plant_id: "plant-1",
	journal_entry_id: null,
	measurement_id: null,
	stage: null,
	caption: "Week 3",
	tags: ["training"],
	content_type: "image/png",
	file_size: 42,
	occurred_at: "2026-07-23T10:00:00Z",
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

describe("PhotoGrid", () => {
	it("renders thumbnails for each photo", () => {
		render(<PhotoGrid photos={[photoFixture]} onDelete={vi.fn()} />);
		expect(screen.getByAltText("Week 3")).toBeVisible();
	});

	it("shows an empty state with no photos", () => {
		render(<PhotoGrid photos={[]} onDelete={vi.fn()} />);
		expect(screen.getByText(/no photos yet/i)).toBeVisible();
	});

	it("opens a lightbox with caption and tags on click", async () => {
		const user = userEvent.setup();
		render(<PhotoGrid photos={[photoFixture]} onDelete={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Week 3" }));

		expect(screen.getByRole("dialog", { name: /photo detail/i })).toBeVisible();
		expect(screen.getByText("Week 3")).toBeVisible();
		expect(screen.getByText("training")).toBeVisible();
	});

	it("deletes the selected photo and closes the lightbox", async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn();
		render(<PhotoGrid photos={[photoFixture]} onDelete={onDelete} />);

		await user.click(screen.getByRole("button", { name: "Week 3" }));
		await user.click(screen.getByRole("button", { name: /delete/i }));

		expect(onDelete).toHaveBeenCalledWith("photo-1");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
