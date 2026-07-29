import { describe, expect, it } from "vitest";
import { calculateGeometryPreview } from "./geometry";

describe("calculateGeometryPreview", () => {
	it("returns null for custom calibration tables", () => {
		expect(
			calculateGeometryPreview({
				shape: "custom_calibration_table",
				unit: "cm",
				length: "",
				width: "",
				height: "",
				diameter: "",
			}),
		).toBeNull();
	});

	it("returns null when rectangular dimensions are incomplete", () => {
		expect(
			calculateGeometryPreview({
				shape: "rectangular",
				unit: "cm",
				length: "50",
				width: "",
				height: "60",
				diameter: "",
			}),
		).toBeNull();
	});

	it("computes rectangular volume in liters", () => {
		// 50cm x 40cm x 60cm = 0.5 x 0.4 x 0.6 m3 = 0.12 m3 = 120 L
		const preview = calculateGeometryPreview({
			shape: "rectangular",
			unit: "cm",
			length: "50",
			width: "40",
			height: "60",
			diameter: "",
		});
		expect(preview?.volumeLiters).toBe("120");
	});

	it("converts inches to meters for rectangular tanks", () => {
		// 20in x 16in x 24in -> metres: 0.508 x 0.4064 x 0.6096 = 0.12585272 m3
		const preview = calculateGeometryPreview({
			shape: "rectangular",
			unit: "in",
			length: "20",
			width: "16",
			height: "24",
			diameter: "",
		});
		expect(preview).not.toBeNull();
		expect(Number(preview?.volumeLiters)).toBeCloseTo(125.8527, 1);
	});

	it("computes vertical cylinder volume from diameter and height", () => {
		// diameter 40cm -> r=0.2m, height 80cm -> 0.8m
		// area = pi * 0.04 = 0.12566..., * 0.8 = 0.10053 m3 = 100.53 L
		const preview = calculateGeometryPreview({
			shape: "vertical_cylinder",
			unit: "cm",
			length: "",
			width: "",
			height: "80",
			diameter: "40",
		});
		expect(preview).not.toBeNull();
		expect(Number(preview?.volumeLiters)).toBeCloseTo(100.531, 2);
	});

	it("computes horizontal cylinder volume from diameter and length", () => {
		// diameter 30cm -> r=0.15m, length 100cm -> 1m
		// pi * 0.0225 * 1 = 0.070686 m3 = 70.686 L
		const preview = calculateGeometryPreview({
			shape: "horizontal_cylinder",
			unit: "cm",
			length: "100",
			width: "",
			height: "",
			diameter: "30",
		});
		expect(preview).not.toBeNull();
		expect(Number(preview?.volumeLiters)).toBeCloseTo(70.686, 2);
	});

	it("rejects non-positive geometry values", () => {
		expect(
			calculateGeometryPreview({
				shape: "rectangular",
				unit: "cm",
				length: "0",
				width: "40",
				height: "60",
				diameter: "",
			}),
		).toBeNull();
	});
});
