import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, expectOk, jsonHeaders, parseResponse } from "./client";

export const growStatusSchema = z.enum([
	"planned",
	"active",
	"completed",
	"archived",
]);

const compactStageSchema = z.object({
	id: z.string(),
	key: z.string(),
	label: z.string(),
});

const compactPlantSchema = z.object({
	id: z.string(),
	name: z.string(),
	status: z.string(),
	current_stage: compactStageSchema,
	start_date: z.string().nullable(),
});

export const growSummarySchema = z.object({
	id: z.string(),
	grow_space_id: z.string(),
	grow_space_name: z.string(),
	grow_space_active: z.boolean(),
	name: z.string(),
	status: growStatusSchema,
	start_date: z.string().nullable(),
	end_date: z.string().nullable(),
	notes: z.string().nullable(),
	plant_count: z.number().int(),
	plant_status_counts: z.record(z.string(), z.number().int()),
	created_at: z.string(),
	updated_at: z.string(),
});

export const growSchema = growSummarySchema.extend({
	plants: z.array(compactPlantSchema),
});

const growListSchema = z.object({ items: z.array(growSummarySchema) });

export type GrowStatus = z.infer<typeof growStatusSchema>;
export type GrowSummary = z.infer<typeof growSummarySchema>;
export type Grow = z.infer<typeof growSchema>;
export type CompactPlant = z.infer<typeof compactPlantSchema>;

export interface GrowCreateInput {
	grow_space_id: string;
	name: string;
	status: GrowStatus;
	start_date?: string | null;
	end_date?: string | null;
	notes?: string | null;
}

export interface GrowUpdateInput {
	name?: string;
	status?: GrowStatus;
	start_date?: string | null;
	end_date?: string | null;
	notes?: string | null;
}

export interface GrowFilters {
	growSpaceId?: string | null;
	statuses?: GrowStatus[];
	includeArchived?: boolean;
}

function growQuery(filters: GrowFilters): string {
	const params = new URLSearchParams();
	if (filters.growSpaceId) params.set("grow_space_id", filters.growSpaceId);
	for (const status of filters.statuses ?? []) params.append("status", status);
	if (filters.includeArchived) params.set("include_archived", "true");
	const query = params.toString();
	return query ? `?${query}` : "";
}

export async function listGrows(
	filters: GrowFilters = {},
	fetcher: typeof fetch = fetch,
): Promise<GrowSummary[]> {
	const response = await fetcher(`api/v1/grows${growQuery(filters)}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		growListSchema,
		"Invalid grow response",
	);
	return result.items;
}

export async function getGrow(
	growId: string,
	fetcher: typeof fetch = fetch,
): Promise<Grow> {
	const response = await fetcher(`api/v1/grows/${growId}`, {
		headers: acceptJson,
	});
	return parseResponse(response, growSchema, "Invalid grow response");
}

export async function createGrow(
	input: GrowCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Grow> {
	const response = await fetcher("api/v1/grows", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, growSchema, "Invalid grow response");
}

export async function updateGrow(
	growId: string,
	input: GrowUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<Grow> {
	const response = await fetcher(`api/v1/grows/${growId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, growSchema, "Invalid grow response");
}

export async function archiveGrow(
	growId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/grows/${growId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to archive grow", "archive_failed");
}

export const growKeys = {
	all: ["grows"] as const,
	list: (filters: GrowFilters) => ["grows", "list", filters] as const,
	detail: (id: string) => ["grows", "detail", id] as const,
};

export function useGrows(filters: GrowFilters = {}) {
	return useQuery({
		queryKey: growKeys.list(filters),
		queryFn: () => listGrows(filters),
	});
}

export function useGrow(growId: string) {
	return useQuery({
		queryKey: growKeys.detail(growId),
		queryFn: () => getGrow(growId),
	});
}

function refreshGrow(queryClient: QueryClient, grow: Grow) {
	queryClient.setQueryData(growKeys.detail(grow.id), grow);
	return queryClient.invalidateQueries({ queryKey: growKeys.all });
}

export function useCreateGrow() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: GrowCreateInput) => createGrow(input),
		onSuccess: (grow) => refreshGrow(queryClient, grow),
	});
}

export function useUpdateGrow() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ growId, input }: { growId: string; input: GrowUpdateInput }) =>
			updateGrow(growId, input),
		onSuccess: (grow) => refreshGrow(queryClient, grow),
	});
}

export function useArchiveGrow() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (growId: string) => archiveGrow(growId),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: growKeys.all }),
	});
}
