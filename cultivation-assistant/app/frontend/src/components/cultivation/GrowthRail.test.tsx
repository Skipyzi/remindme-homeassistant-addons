import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GrowthRail } from "./GrowthRail";

describe("GrowthRail", () => {
	it("renders uniquely colored progress segments through the current stage", () => {
		const { container } = render(<GrowthRail />);
		const segments = container.querySelectorAll(".growth-rail__segment");

		expect(segments).toHaveLength(4);
		expect(segments[0]).toHaveClass("segment-1", "is-filled");
		expect(segments[1]).toHaveClass("segment-2", "is-filled");
		expect(segments[2]).toHaveClass("segment-3", "is-current");
		expect(segments[3]).toHaveClass("segment-4");
	});
});
