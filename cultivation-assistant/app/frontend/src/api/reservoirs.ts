import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, ApiError, expectOk, jsonHeaders, parseResponse } from "./client";

export { ApiError };

export const reservoirTypeSchema = z.enum([
	"autopot_reservoir",
	"dwc_bucket",
	"rdwc_control_reservoir",
	"irrigation_supply_tank",
	"mixing_tank",
	"top_off_tank",
	"ro_source_water_tank",
	"runoff_waste_tank",
	"custom_reservoir",
]);

export const geometryShapeSchema = z.enum([
	"rectangular",
	"vertical_cylinder",
	"horizontal_cylinder",
	"custom_calibration_table",
]);

const decimalish = z.union([z.string(), z.number()]);

export const geometryResponseSchema = z.object({
	shape: geometryShapeSchema,
	unit: z.enum(["cm", "in"]).nullable(),
	length: decimalish.nullable(),
	width: decimalish.nullable(),
	height: decimalish.nullable(),
	diameter: decimalish.nullable(),
});

const compatibilitySchema = z.enum([
	"compatible",
	"convertible",
	"unknown",
	"incompatible",
]);

const liveReadingSchema = z.object({
	entity_id: z.string(),
	role: z.string(),
	raw_value: z.string(),
	normalized_value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
	normalized_unit: z.string().nullable(),
	last_updated: z.string(),
	stale: z.boolean(),
	available: z.boolean(),
});

export const reservoirMappingSchema = z.object({
	id: z.string(),
	reservoir_id: z.string(),
	entity_id: z.string(),
	role: z.string(),
	display_name: z.string().nullable(),
	priority: z.number().int(),
	source_unit: z.string().nullable(),
	normalized_unit: z.string().nullable(),
	enabled: z.boolean(),
	calibration: z.record(z.string(), z.unknown()).nullable(),
	stale_after_seconds: z.number().int(),
	compatibility: compatibilitySchema,
	compatibility_explanation: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
});

const entityCandidateSchema = z.object({
	entity_id: z.string(),
	friendly_name: z.string(),
	domain: z.string(),
	device_class: z.string().nullable(),
	source_unit: z.string().nullable(),
	current_state: z.string(),
	last_updated: z.string(),
	available: z.boolean(),
	compatibility: compatibilitySchema,
	explanation: z.string(),
});

const entityDiscoverySchema = z.object({
	items: z.array(entityCandidateSchema),
});

export const reservoirSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	reservoir_type: reservoirTypeSchema,
	primary_grow_space_id: z.string().nullable(),
	capacity_liters: decimalish,
	usable_capacity_liters: decimalish.nullable(),
	active: z.boolean(),
	geometry: geometryResponseSchema,
	mapping_count: z.number().int(),
	live_readings: z.array(liveReadingSchema),
	created_at: z.string(),
	updated_at: z.string(),
});

export const reservoirSchema = reservoirSummarySchema.extend({
	minimum_safe_volume_liters: decimalish.nullable(),
	refill_threshold_liters: decimalish.nullable(),
	overflow_threshold_liters: decimalish.nullable(),
	mappings: z.array(reservoirMappingSchema),
});

const reservoirListSchema = z.object({
	items: z.array(reservoirSummarySchema),
});

export const calibrationPointSchema = z.object({
	id: z.string(),
	reservoir_id: z.string(),
	raw_value: decimalish,
	volume_liters: decimalish,
});

const calibrationListSchema = z.object({
	items: z.array(calibrationPointSchema),
});

export type ReservoirType = z.infer<typeof reservoirTypeSchema>;
export type GeometryShape = z.infer<typeof geometryShapeSchema>;
export type GeometryResponse = z.infer<typeof geometryResponseSchema>;
export type ReservoirSummary = z.infer<typeof reservoirSummarySchema>;
export type Reservoir = z.infer<typeof reservoirSchema>;
export type CalibrationPoint = z.infer<typeof calibrationPointSchema>;
export type ReservoirMapping = z.infer<typeof reservoirMappingSchema>;
export type ReservoirLiveReading = z.infer<typeof liveReadingSchema>;
export type ReservoirEntityCandidate = z.infer<typeof entityCandidateSchema>;
export type Compatibility = z.infer<typeof compatibilitySchema>;

export interface ReservoirMappingInput {
	entity_id: string;
	role: string;
	display_name?: string | null;
	priority?: number;
	enabled?: boolean;
	calibration?: Record<string, unknown> | null;
	stale_after_seconds?: number | null;
}

export interface ReservoirMappingUpdateInput {
	display_name?: string | null;
	priority?: number;
	enabled?: boolean;
	calibration?: Record<string, unknown> | null;
	stale_after_seconds?: number | null;
}

export interface GeometryInput {
	shape: GeometryShape;
	unit?: "cm" | "in" | null;
	length?: string | null;
	width?: string | null;
	height?: string | null;
	diameter?: string | null;
}

export interface ReservoirCreateInput {
	name: string;
	reservoir_type: ReservoirType;
	primary_grow_space_id?: string | null;
	capacity_liters: string;
	usable_capacity_liters?: string | null;
	minimum_safe_volume_liters?: string | null;
	refill_threshold_liters?: string | null;
	overflow_threshold_liters?: string | null;
	geometry: GeometryInput;
}

export interface ReservoirUpdateInput {
	name?: string;
	reservoir_type?: ReservoirType;
	primary_grow_space_id?: string | null;
	capacity_liters?: string;
	usable_capacity_liters?: string | null;
	minimum_safe_volume_liters?: string | null;
	refill_threshold_liters?: string | null;
	overflow_threshold_liters?: string | null;
	geometry?: GeometryInput;
	active?: boolean;
}

export interface CalibrationPointInput {
	raw_value: string;
	volume_liters: string;
}

export async function listReservoirs(
	includeArchived = false,
	fetcher: typeof fetch = fetch,
): Promise<ReservoirSummary[]> {
	const suffix = includeArchived ? "?include_archived=true" : "";
	const response = await fetcher(`api/v1/reservoirs${suffix}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		reservoirListSchema,
		"Invalid reservoir response",
	);
	return result.items;
}

export async function getReservoir(
	reservoirId: string,
	fetcher: typeof fetch = fetch,
): Promise<Reservoir> {
	const response = await fetcher(`api/v1/reservoirs/${reservoirId}`, {
		headers: acceptJson,
	});
	return parseResponse(response, reservoirSchema, "Invalid reservoir response");
}

export async function createReservoir(
	input: ReservoirCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Reservoir> {
	const response = await fetcher("api/v1/reservoirs", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, reservoirSchema, "Invalid reservoir response");
}

export async function updateReservoir(
	reservoirId: string,
	input: ReservoirUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<Reservoir> {
	const response = await fetcher(`api/v1/reservoirs/${reservoirId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, reservoirSchema, "Invalid reservoir response");
}

export async function archiveReservoir(
	reservoirId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/reservoirs/${reservoirId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to archive reservoir", "archive_failed");
}

export async function listCalibrationPoints(
	reservoirId: string,
	fetcher: typeof fetch = fetch,
): Promise<CalibrationPoint[]> {
	const response = await fetcher(
		`api/v1/reservoirs/${reservoirId}/calibration-points`,
		{ headers: acceptJson },
	);
	const result = await parseResponse(
		response,
		calibrationListSchema,
		"Invalid calibration response",
	);
	return result.items;
}

export async function replaceCalibrationPoints(
	reservoirId: string,
	points: CalibrationPointInput[],
	fetcher: typeof fetch = fetch,
): Promise<CalibrationPoint[]> {
	const response = await fetcher(
		`api/v1/reservoirs/${reservoirId}/calibration-points`,
		{
			method: "PUT",
			headers: jsonHeaders,
			body: JSON.stringify({ points }),
		},
	);
	const result = await parseResponse(
		response,
		calibrationListSchema,
		"Invalid calibration response",
	);
	return result.items;
}

export async function discoverReservoirEntities(
	role: string,
	fetcher: typeof fetch = fetch,
): Promise<ReservoirEntityCandidate[]> {
	const response = await fetcher(
		`api/v1/home-assistant/reservoir-entities?role=${encodeURIComponent(role)}`,
		{ headers: acceptJson },
	);
	const result = await parseResponse(
		response,
		entityDiscoverySchema,
		"Invalid reservoir entity discovery response",
	);
	return result.items;
}

export async function createReservoirMapping(
	reservoirId: string,
	input: ReservoirMappingInput,
	fetcher: typeof fetch = fetch,
): Promise<ReservoirMapping> {
	const response = await fetcher(
		`api/v1/reservoirs/${reservoirId}/entity-mappings`,
		{
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify(input),
		},
	);
	return parseResponse(response, reservoirMappingSchema, "Invalid reservoir mapping response");
}

export async function updateReservoirMapping(
	reservoirId: string,
	mappingId: string,
	input: ReservoirMappingUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<ReservoirMapping> {
	const response = await fetcher(
		`api/v1/reservoirs/${reservoirId}/entity-mappings/${mappingId}`,
		{
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify(input),
		},
	);
	return parseResponse(response, reservoirMappingSchema, "Invalid reservoir mapping response");
}

export async function deleteReservoirMapping(
	reservoirId: string,
	mappingId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(
		`api/v1/reservoirs/${reservoirId}/entity-mappings/${mappingId}`,
		{ method: "DELETE", headers: acceptJson },
	);
	await expectOk(response, "Unable to delete reservoir mapping", "delete_failed");
}

export const reservoirKeys = {
	all: ["reservoirs"] as const,
	list: (includeArchived: boolean) =>
		["reservoirs", { includeArchived }] as const,
	detail: (id: string) => ["reservoirs", id] as const,
	calibration: (id: string) => ["reservoirs", id, "calibration"] as const,
	candidates: (role: string) => ["home-assistant", "reservoir-entities", role] as const,
};

export function useReservoirs(includeArchived = false) {
	return useQuery({
		queryKey: reservoirKeys.list(includeArchived),
		queryFn: () => listReservoirs(includeArchived),
	});
}

export function useReservoir(reservoirId: string) {
	return useQuery({
		queryKey: reservoirKeys.detail(reservoirId),
		queryFn: () => getReservoir(reservoirId),
	});
}

export function useCalibrationPoints(reservoirId: string) {
	return useQuery({
		queryKey: reservoirKeys.calibration(reservoirId),
		queryFn: () => listCalibrationPoints(reservoirId),
	});
}

function refreshReservoir(queryClient: QueryClient, reservoir: Reservoir) {
	queryClient.setQueryData(reservoirKeys.detail(reservoir.id), reservoir);
	return queryClient.invalidateQueries({ queryKey: reservoirKeys.all });
}

export function useCreateReservoir() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ReservoirCreateInput) => createReservoir(input),
		onSuccess: (reservoir) => refreshReservoir(queryClient, reservoir),
	});
}

export function useUpdateReservoir() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			reservoirId,
			input,
		}: {
			reservoirId: string;
			input: ReservoirUpdateInput;
		}) => updateReservoir(reservoirId, input),
		onSuccess: (reservoir) => refreshReservoir(queryClient, reservoir),
	});
}

export function useArchiveReservoir() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (reservoirId: string) => archiveReservoir(reservoirId),
		onSuccess: (_result, reservoirId) =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: reservoirKeys.all }),
				queryClient.invalidateQueries({
					queryKey: reservoirKeys.detail(reservoirId),
				}),
			]),
	});
}

export function useReplaceCalibrationPoints(reservoirId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (points: CalibrationPointInput[]) =>
			replaceCalibrationPoints(reservoirId, points),
		onSuccess: (points) =>
			queryClient.setQueryData(reservoirKeys.calibration(reservoirId), points),
	});
}

export function useReservoirEntityCandidates(role: string | null) {
	return useQuery({
		queryKey: reservoirKeys.candidates(role ?? "none"),
		queryFn: () => discoverReservoirEntities(role ?? ""),
		enabled: role !== null,
		retry: (failureCount, error) =>
			!(error instanceof ApiError && error.status === 422) && failureCount < 1,
	});
}

export function useCreateReservoirMapping(reservoirId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ReservoirMappingInput) =>
			createReservoirMapping(reservoirId, input),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: reservoirKeys.detail(reservoirId) }),
	});
}

export function useUpdateReservoirMapping(reservoirId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			mappingId,
			input,
		}: {
			mappingId: string;
			input: ReservoirMappingUpdateInput;
		}) => updateReservoirMapping(reservoirId, mappingId, input),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: reservoirKeys.detail(reservoirId) }),
	});
}

export function useDeleteReservoirMapping(reservoirId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (mappingId: string) =>
			deleteReservoirMapping(reservoirId, mappingId),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: reservoirKeys.detail(reservoirId) }),
	});
}
