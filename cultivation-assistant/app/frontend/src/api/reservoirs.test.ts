import { describe, expect, it, vi } from "vitest";
import {
	archiveReservoir,
	createReservoir,
	listCalibrationPoints,
	listReservoirs,
	replaceCalibrationPoints,
	updateReservoir,
} from "./reservoirs";

const summaryFixture = {
	id: "res-1",
	name: "Mixing tank",
	reservoir_type: "mixing_tank",
	primary_grow_space_id: null,
	capacity_liters: "100.0000",
	usable_capacity_liters: "95.0000",
	active: true,
	geometry: {
		shape: "rectangular",
		unit: "cm",
		length: "50",
		width: "40",
		height: "60",
		diameter: null,
	},
	mapping_count: 0,
	live_readings: [],
	created_at: "2026-07-25T12:00:00Z",
	updated_at: "2026-07-25T12:00:00Z",
};

const reservoirFixture = {
	...summaryFixture,
	minimum_safe_volume_liters: "10.0000",
	refill_threshold_liters: "20.0000",
	overflow_threshold_liters: "95.0000",
	mappings: [],
};

const calibrationFixture = [
	{
		id: "cp-1",
		reservoir_id: "res-1",
		raw_value: "0.0000",
		volume_liters: "0.0000",
	},
	{
		id: "cp-2",
		reservoir_id: "res-1",
		raw_value: "100.0000",
		volume_liters: "100.0000",
	},
];

describe("reservoirs API", () => {
	it("lists reservoirs through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [summaryFixture] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const items = await listReservoirs(false, fetcher);

		expect(fetcher).toHaveBeenCalledWith("api/v1/reservoirs", expect.any(Object));
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe("Mixing tank");
	});

	it("appends include_archived to the list URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await listReservoirs(true, fetcher);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs?include_archived=true",
			expect.any(Object),
		);
	});

	it("creates a reservoir through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(reservoirFixture), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await createReservoir(
			{
				name: "Mixing tank",
				reservoir_type: "mixing_tank",
				capacity_liters: "100",
				geometry: {
					shape: "rectangular",
					unit: "cm",
					length: "50",
					width: "40",
					height: "60",
				},
			},
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("patches a reservoir through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ...reservoirFixture, active: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await updateReservoir("res-1", { active: false }, fetcher);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs/res-1",
			expect.objectContaining({ method: "PATCH" }),
		);
	});

	it("archives a reservoir with a DELETE", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

		await archiveReservoir("res-1", fetcher);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs/res-1",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("lists calibration points through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: calibrationFixture }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const points = await listCalibrationPoints("res-1", fetcher);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs/res-1/calibration-points",
			expect.any(Object),
		);
		expect(points).toHaveLength(2);
	});

	it("replaces calibration points with a PUT", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: calibrationFixture }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await replaceCalibrationPoints(
			"res-1",
			[
				{ raw_value: "0", volume_liters: "0" },
				{ raw_value: "100", volume_liters: "100" },
			],
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/reservoirs/res-1/calibration-points",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("rejects a malformed reservoir response", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [{}] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(listReservoirs(false, fetcher)).rejects.toThrow(
			"Invalid reservoir response",
		);
	});
});
