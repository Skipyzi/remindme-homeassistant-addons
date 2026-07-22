import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
	it("renders and handles keyboard activation", async () => {
		const onClick = vi.fn();
		render(<Button onClick={onClick}>Save changes</Button>);

		const button = screen.getByRole("button", { name: "Save changes" });
		button.focus();
		await userEvent.keyboard("{Enter}");

		expect(onClick).toHaveBeenCalledOnce();
	});
});
