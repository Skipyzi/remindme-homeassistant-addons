import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, jsonHeaders, parseResponse } from "./client";

export const seedTypeSchema = z.enum([
	"regular",
	"feminized",
	"autoflower",
	"unknown",
]);

const compactBreederSchema = z.object({
	id: z.string(),
	name: z.string(),
});

export const breederSchema = z.object({
	id: z.string(),
	name: z.string(),
	active: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
});

const breederListSchema = z.object({ items: z.array(breederSchema) });

export const cultivarSchema = z.object({
	id: z.string(),
	name: z.string(),
	breeder: compactBreederSchema.nullable(),
	seed_type: seedTypeSchema,
	active: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
});

const cultivarListSchema = z.object({ items: z.array(cultivarSchema) });

export type SeedType = z.infer<typeof seedTypeSchema>;
export type Breeder = z.infer<typeof breederSchema>;
export type Cultivar = z.infer<typeof cultivarSchema>;

export interface BreederCreateInput {
	name: string;
}

export interface CultivarCreateInput {
	name: string;
	breeder_id: string | null;
	seed_type: SeedType;
}

export interface CultivarFilters {
	includeInactive?: boolean;
	breederId?: string | null;
	query?: string | null;
}

export async function listBreeders(
	includeInactive = false,
	fetcher: typeof fetch = fetch,
): Promise<Breeder[]> {
	const suffix = includeInactive ? "?include_inactive=true" : "";
	const response = await fetcher(`api/v1/breeders${suffix}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		breederListSchema,
		"Invalid breeder response",
	);
	return result.items;
}

export async function createBreeder(
	input: BreederCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Breeder> {
	const response = await fetcher("api/v1/breeders", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, breederSchema, "Invalid breeder response");
}

export async function listCultivars(
	filters: CultivarFilters = {},
	fetcher: typeof fetch = fetch,
): Promise<Cultivar[]> {
	const params = new URLSearchParams();
	if (filters.includeInactive) params.set("include_inactive", "true");
	if (filters.breederId) params.set("breeder_id", filters.breederId);
	if (filters.query) params.set("query", filters.query);
	const suffix = params.toString() ? `?${params.toString()}` : "";
	const response = await fetcher(`api/v1/cultivars${suffix}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		cultivarListSchema,
		"Invalid cultivar response",
	);
	return result.items;
}

export async function createCultivar(
	input: CultivarCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Cultivar> {
	const response = await fetcher("api/v1/cultivars", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, cultivarSchema, "Invalid cultivar response");
}

export const libraryKeys = {
	breeders: (includeInactive: boolean) =>
		["breeders", { includeInactive }] as const,
	cultivars: (filters: CultivarFilters) => ["cultivars", filters] as const,
};

export function useBreeders(includeInactive = false) {
	return useQuery({
		queryKey: libraryKeys.breeders(includeInactive),
		queryFn: () => listBreeders(includeInactive),
	});
}

export function useCultivars(filters: CultivarFilters = {}) {
	return useQuery({
		queryKey: libraryKeys.cultivars(filters),
		queryFn: () => listCultivars(filters),
	});
}

function invalidateCultivars(queryClient: QueryClient) {
	return queryClient.invalidateQueries({ queryKey: ["cultivars"] });
}

export function useCreateCultivar() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CultivarCreateInput) => createCultivar(input),
		onSuccess: () => invalidateCultivars(queryClient),
	});
}

export function useCreateBreeder() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: BreederCreateInput) => createBreeder(input),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["breeders"] }),
	});
}
