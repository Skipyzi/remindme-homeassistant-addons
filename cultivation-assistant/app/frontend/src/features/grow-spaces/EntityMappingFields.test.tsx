import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityMappingInput } from "../../api/growSpaces";
import { EntityMappingFields } from "./EntityMappingFields";

function renderFields(onChange = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function Harness() {
		const [mappings, setMappings] = useState<
			Parameters<typeof EntityMappingFields>[0]["mappings"]
		>([]);
		return (
			<EntityMappingFields
				mappings={mappings}
				onChange={(next: EntityMappingInput[]) => {
					setMappings(next);
					onChange(next);
				}}
			/>
		);
	}
	render(
		<QueryClientProvider client={queryClient}>
			<Harness />
		</QueryClientProvider>,
	);
	return onChange;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("EntityMappingFields", () => {
	it("adds multiple suggested entities for the same role", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						items: [
							{
								entity_id: "sensor.left_temp",
								friendly_name: "Left temperature",
								domain: "sensor",
								device_class: "temperature",
								source_unit: "°C",
								current_state: "24",
								last_updated: "2026-07-22T12:00:00Z",
								available: true,
								compatibility: "compatible",
								explanation: "Device class and unit match this role.",
							},
							{
								entity_id: "sensor.right_temp",
								friendly_name: "Right temperature",
								domain: "sensor",
								device_class: "temperature",
								source_unit: "°C",
								current_state: "25",
								last_updated: "2026-07-22T12:00:00Z",
								available: true,
								compatibility: "compatible",
								explanation: "Device class and unit match this role.",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);
		const onChange = renderFields();

		await user.click(
			await screen.findByRole("button", { name: /use left temperature/i }),
		);
		await user.click(
			screen.getByRole("button", { name: /use right temperature/i }),
		);

		expect(onChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ entity_id: "sensor.left_temp" }),
			expect.objectContaining({ entity_id: "sensor.right_temp" }),
		]);
	});

	it("accepts a manual entity ID", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ items: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const onChange = renderFields();

		await user.type(
			screen.getByLabelText(/manual entity id/i),
			"sensor.future_probe",
		);
		await user.click(
			screen.getByRole("button", { name: /add manual entity/i }),
		);

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({
				entity_id: "sensor.future_probe",
				role: "air_temperature",
			}),
		]);
	});
});
