import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, expectOk, jsonHeaders, parseResponse } from "./client";
import { growKeys } from "./grows";
import { seedTypeSchema } from "./library";

export const plantStatusSchema = z.enum([
	"planned",
	"active",
	"harvested",
	"completed",
	"lost",
	"archived",
]);

export const propagationSourceSchema = z.enum(["seed", "clone"]);

export const transitionSourceSchema = z.enum([
	"user_confirmed",
	"user_adjusted",
	"imported",
	"application_recalculation",
]);

const compactStageSchema = z.object({
	id: z.string(),
	key: z.string(),
	label: z.string(),
});

const compactRefSchema = z.object({ id: z.string(), name: z.string() });

const compactCultivarSchema = z.object({
	id: z.string(),
	name: z.string(),
	breeder_name: z.string().nullable(),
});

const transitionSchema = z.object({
	id: z.string(),
	from_stage_id: z.string().nullable(),
	to_stage_id: z.string(),
	effective_at: z.string(),
	source: transitionSourceSchema,
	notes: z.string().nullable(),
	created_at: z.string(),
});

export const plantSchema = z.object({
	id: z.string(),
	grow: compactRefSchema,
	grow_space: compactRefSchema,
	cultivar: compactCultivarSchema,
	name: z.string(),
	propagation_source: propagationSourceSchema,
	seed_type: seedTypeSchema.nullable(),
	start_date: z.string().nullable(),
	current_stage: compactStageSchema,
	status: plantStatusSchema,
	container: z.string().nullable(),
	medium: z.string().nullable(),
	location: z.string().nullable(),
	expected_harvest_start: z.string().nullable(),
	expected_harvest_end: z.string().nullable(),
	actual_harvest_date: z.string().nullable(),
	notes: z.string().nullable(),
	stage_transitions: z.array(transitionSchema),
	created_at: z.string(),
	updated_at: z.string(),
});

const plantSummarySchema = z.object({
	id: z.string(),
	grow_id: z.string(),
	name: z.string(),
	status: plantStatusSchema,
	current_stage: compactStageSchema,
	cultivar: compactCultivarSchema,
	start_date: z.string().nullable(),
});

const plantListSchema = z.object({ items: z.array(plantSummarySchema) });

const transitionResultSchema = z.object({
	transition: transitionSchema,
	plant: plantSchema,
});

export type PlantStatus = z.infer<typeof plantStatusSchema>;
export type PropagationSource = z.infer<typeof propagationSourceSchema>;
export type TransitionSource = z.infer<typeof transitionSourceSchema>;
export type Plant = z.infer<typeof plantSchema>;
export type PlantSummary = z.infer<typeof plantSummarySchema>;
export type PlantTransition = z.infer<typeof transitionSchema>;
export type PlantTransitionResult = z.infer<typeof transitionResultSchema>;

export interface PlantCreateInput {
	grow_id: string;
	cultivar_id: string;
	name: string;
	propagation_source: PropagationSource;
	seed_type?: string | null;
	start_date?: string | null;
	current_stage_id: string;
	status: PlantStatus;
	container?: string | null;
	medium?: string | null;
	location?: string | null;
	expected_harvest_start?: string | null;
	expected_harvest_end?: string | null;
	actual_harvest_date?: string | null;
	notes?: string | null;
}

export interface PlantUpdateInput {
	name?: string;
	seed_type?: string | null;
	start_date?: string | null;
	status?: PlantStatus;
	container?: string | null;
	medium?: string | null;
	location?: string | null;
	expected_harvest_start?: string | null;
	expected_harvest_end?: string | null;
	actual_harvest_date?: string | null;
	notes?: string | null;
}

export interface PlantTransitionInput {
	to_stage_id: string;
	effective_at: string;
	source?: TransitionSource;
	notes?: string | null;
	confirmed: boolean;
}

export interface PlantFilters {
	growId?: string | null;
	growSpaceId?: string | null;
	statuses?: PlantStatus[];
	stageId?: string | null;
	query?: string | null;
	includeArchived?: boolean;
}

function plantQuery(filters: PlantFilters): string {
	const params = new URLSearchParams();
	if (filters.growId) params.set("grow_id", filters.growId);
	if (filters.growSpaceId) params.set("grow_space_id", filters.growSpaceId);
	for (const status of filters.statuses ?? []) params.append("status", status);
	if (filters.stageId) params.set("stage_id", filters.stageId);
	if (filters.query) params.set("query", filters.query);
	if (filters.includeArchived) params.set("include_archived", "true");
	const query = params.toString();
	return query ? `?${query}` : "";
}

export async function listPlants(
	filters: PlantFilters = {},
	fetcher: typeof fetch = fetch,
): Promise<PlantSummary[]> {
	const response = await fetcher(`api/v1/plants${plantQuery(filters)}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		plantListSchema,
		"Invalid plant response",
	);
	return result.items;
}

export async function getPlant(
	plantId: string,
	fetcher: typeof fetch = fetch,
): Promise<Plant> {
	const response = await fetcher(`api/v1/plants/${plantId}`, {
		headers: acceptJson,
	});
	return parseResponse(response, plantSchema, "Invalid plant response");
}

export async function createPlant(
	input: PlantCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Plant> {
	const response = await fetcher("api/v1/plants", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, plantSchema, "Invalid plant response");
}

export async function updatePlant(
	plantId: string,
	input: PlantUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<Plant> {
	const response = await fetcher(`api/v1/plants/${plantId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, plantSchema, "Invalid plant response");
}

export async function archivePlant(
	plantId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/plants/${plantId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to archive plant", "archive_failed");
}

export async function transitionPlantStage(
	plantId: string,
	input: PlantTransitionInput,
	fetcher: typeof fetch = fetch,
): Promise<PlantTransitionResult> {
	const response = await fetcher(`api/v1/plants/${plantId}/stage-transitions`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(
		response,
		transitionResultSchema,
		"Invalid transition response",
	);
}

export const plantKeys = {
	all: ["plants"] as const,
	list: (filters: PlantFilters) => ["plants", "list", filters] as const,
	detail: (id: string) => ["plants", "detail", id] as const,
};

export function usePlants(filters: PlantFilters = {}) {
	return useQuery({
		queryKey: plantKeys.list(filters),
		queryFn: () => listPlants(filters),
	});
}

export function usePlant(plantId: string) {
	return useQuery({
		queryKey: plantKeys.detail(plantId),
		queryFn: () => getPlant(plantId),
	});
}

function refreshAfterPlant(queryClient: QueryClient, plant: Plant) {
	queryClient.setQueryData(plantKeys.detail(plant.id), plant);
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: plantKeys.all }),
		queryClient.invalidateQueries({ queryKey: growKeys.detail(plant.grow.id) }),
		queryClient.invalidateQueries({ queryKey: growKeys.all }),
	]);
}

export function useCreatePlant() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: PlantCreateInput) => createPlant(input),
		onSuccess: (plant) => refreshAfterPlant(queryClient, plant),
	});
}

export function useUpdatePlant() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			plantId,
			input,
		}: {
			plantId: string;
			input: PlantUpdateInput;
		}) => updatePlant(plantId, input),
		onSuccess: (plant) => refreshAfterPlant(queryClient, plant),
	});
}

export function useArchivePlant() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (plantId: string) => archivePlant(plantId),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: plantKeys.all }),
				queryClient.invalidateQueries({ queryKey: growKeys.all }),
			]),
	});
}

export function useTransitionPlantStage() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			plantId,
			input,
		}: {
			plantId: string;
			input: PlantTransitionInput;
		}) => transitionPlantStage(plantId, input),
		onSuccess: (result) => refreshAfterPlant(queryClient, result.plant),
	});
}
