import { describe, expect, it } from "vitest";
import {
	calculateDimensionPreview,
	convertDimensionValue,
} from "./dimensions";

describe("grow-space dimension helpers", () => {
	it("converts centimetres to inches for editing", () => {
		expect(convertDimensionValue("80", "cm", "in")).toBe("31.5");
	});

	it("converts inches to centimetres for editing", () => {
		expect(convertDimensionValue("31.5", "in", "cm")).toBe("80.01");
	});

	it("calculates area and volume previews", () => {
		expect(
			calculateDimensionPreview({
				length: "80",
				width: "80",
				height: "180",
				unit: "cm",
			}),
		).toEqual({ areaM2: "0.64", volumeM3: "1.152" });
	});

	it("omits volume when height is blank", () => {
		expect(
			calculateDimensionPreview({
				length: "200",
				width: "300",
				height: "",
				unit: "cm",
			}),
		).toEqual({ areaM2: "6", volumeM3: null });
	});
});
