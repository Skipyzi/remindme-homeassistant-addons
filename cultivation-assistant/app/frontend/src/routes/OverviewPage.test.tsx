import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewPage } from "./OverviewPage";

describe("OverviewPage", () => {
	it("shows the active grow and sensor freshness context", () => {
		render(<OverviewPage />);

		expect(
			screen.getByRole("heading", { name: "Basilisk" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Fresh readings from Home Assistant"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("Plant lifecycle timeline"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("Reservoir 68 percent full"),
		).toBeInTheDocument();
	});
});
