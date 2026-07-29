import { describe, expect, it } from "vitest";
import {
	calibrationRowsToInput,
	emptyReservoirDraft,
	validateCalibrationRows,
	validateReservoirDetails,
	validateReservoirGeometry,
	draftToCreateInput,
} from "./types";

describe("validateReservoirDetails", () => {
	it("requires a name", () => {
		expect(validateReservoirDetails({ ...emptyReservoirDraft, name: "  " })).toBe(
			"Name is required before continuing.",
		);
	});

	it("requires a positive capacity", () => {
		expect(
			validateReservoirDetails({ ...emptyReservoirDraft, name: "Tank", capacityLiters: "0" }),
		).toBe("Capacity must be a positive number of liters.");
	});

	it("rejects usable capacity above capacity", () => {
		expect(
			validateReservoirDetails({
				...emptyReservoirDraft,
				name: "Tank",
				capacityLiters: "50",
				usableCapacityLiters: "60",
			}),
		).toBe("Usable capacity cannot exceed capacity.");
	});

	it("accepts a complete draft with optional thresholds", () => {
		expect(
			validateReservoirDetails({
				...emptyReservoirDraft,
				name: "Tank",
				capacityLiters: "100",
				usableCapacityLiters: "90",
				refillThresholdLiters: "20",
			}),
		).toBeNull();
	});
});

describe("validateReservoirGeometry", () => {
	it("skips validation for custom calibration tables", () => {
		expect(
			validateReservoirGeometry({
				...emptyReservoirDraft,
				geometry: {
					...emptyReservoirDraft.geometry,
					shape: "custom_calibration_table",
				},
			}),
		).toBeNull();
	});

	it("requires all three rectangular dimensions", () => {
		expect(
			validateReservoirGeometry({
				...emptyReservoirDraft,
				geometry: { ...emptyReservoirDraft.geometry, length: "50", width: "", height: "60" },
			}),
		).toBe("Width is required for a rectangular tank.");
	});

	it("requires diameter and height for vertical cylinders", () => {
		expect(
			validateReservoirGeometry({
				...emptyReservoirDraft,
				geometry: {
					...emptyReservoirDraft.geometry,
					shape: "vertical_cylinder",
					diameter: "",
					height: "80",
				},
			}),
		).toBe("Diameter is required for a vertical cylinder.");
	});

	it("requires diameter and length for horizontal cylinders", () => {
		expect(
			validateReservoirGeometry({
				...emptyReservoirDraft,
				geometry: {
					...emptyReservoirDraft.geometry,
					shape: "horizontal_cylinder",
					diameter: "30",
					length: "",
				},
			}),
		).toBe("Length is required for a horizontal cylinder.");
	});
});

describe("draftToCreateInput", () => {
	it("converts a rectangular draft to a create payload", () => {
		const input = draftToCreateInput({
			...emptyReservoirDraft,
			name: " Mixing tank ",
			capacityLiters: "100",
			usableCapacityLiters: "90",
			geometry: {
				...emptyReservoirDraft.geometry,
				length: "50",
				width: "40",
				height: "60",
			},
		});
		expect(input.name).toBe("Mixing tank");
		expect(input.capacity_liters).toBe("100");
		expect(input.usable_capacity_liters).toBe("90");
		expect(input.geometry).toEqual({
			shape: "rectangular",
			unit: "cm",
			length: "50",
			width: "40",
			height: "60",
			diameter: null,
		});
	});

	it("omits dimensions for a custom calibration table", () => {
		const input = draftToCreateInput({
			...emptyReservoirDraft,
			name: "Calibrated tank",
			capacityLiters: "200",
			geometry: {
				...emptyReservoirDraft.geometry,
				shape: "custom_calibration_table",
			},
		});
		expect(input.geometry).toEqual({ shape: "custom_calibration_table" });
	});
});

describe("calibration helpers", () => {
	it("requires at least two complete points", () => {
		expect(
			validateCalibrationRows([
				{ rawValue: "0", volumeLiters: "0" },
				{ rawValue: "100", volumeLiters: "" },
			]),
		).toBe("A calibration table requires at least two complete points.");
	});

	it("rejects duplicate raw readings", () => {
		expect(
			validateCalibrationRows([
				{ rawValue: "0", volumeLiters: "0" },
				{ rawValue: "0", volumeLiters: "100" },
			]),
		).toBe("Calibration points must have distinct raw readings.");
	});

	it("rejects negative volumes", () => {
		expect(
			validateCalibrationRows([
				{ rawValue: "0", volumeLiters: "-5" },
				{ rawValue: "100", volumeLiters: "100" },
			]),
		).toBe("Every volume must be a non-negative number of liters.");
	});

	it("accepts a valid table and filters partial rows on export", () => {
		expect(
			validateCalibrationRows([
				{ rawValue: "0", volumeLiters: "0" },
				{ rawValue: "100", volumeLiters: "200" },
				{ rawValue: "", volumeLiters: "" },
			]),
		).toBeNull();
		expect(
			calibrationRowsToInput([
				{ rawValue: "0", volumeLiters: "0" },
				{ rawValue: "100", volumeLiters: "200" },
				{ rawValue: "", volumeLiters: "" },
			]),
		).toEqual([
			{ raw_value: "0", volume_liters: "0" },
			{ raw_value: "100", volume_liters: "200" },
		]);
	});
});
