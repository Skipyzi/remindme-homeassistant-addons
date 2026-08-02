import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Cultivar } from "../../api/library";
import { CultivarCombobox } from "./CultivarCombobox";

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

describe("CultivarCombobox", () => {
	it("exposes an accessible combobox and listbox", async () => {
		const user = userEvent.setup();
		render(
			<CultivarCombobox
				cultivars={cultivars}
				value=""
				onChange={vi.fn()}
				onCreateCultivar={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("combobox"));
		expect(screen.getByRole("listbox")).toBeVisible();
		expect(screen.getByRole("option", { name: /blue dream/i })).toBeVisible();
	});

	it("creates a minimal cultivar without requiring a breeder", async () => {
		const user = userEvent.setup();
		const created: Cultivar = { ...cultivars[0], id: "cultivar-2", name: "Mystery Cut" };
		const onCreateCultivar = vi.fn().mockResolvedValue(created);
		const onChange = vi.fn();
		render(
			<CultivarCombobox
				cultivars={cultivars}
				value=""
				onChange={onChange}
				onCreateCultivar={onCreateCultivar}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /add cultivar/i }));
		await user.type(screen.getByLabelText(/cultivar name/i), "Mystery Cut");
		await user.click(screen.getByRole("button", { name: /save cultivar/i }));

		expect(onCreateCultivar).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Mystery Cut", breeder_id: null }),
		);
		expect(onChange).toHaveBeenCalledWith("cultivar-2");
	});
});
