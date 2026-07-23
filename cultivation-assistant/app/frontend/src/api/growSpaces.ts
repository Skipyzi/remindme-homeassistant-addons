import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

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

const entityMappingSchema = z.object({
	id: z.string(),
	grow_space_id: z.string(),
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

const dimensionsSchema = z.object({
	length: z.union([z.string(), z.number()]),
	width: z.union([z.string(), z.number()]),
	height: z.union([z.string(), z.number()]).nullable(),
	unit: z.enum(["cm", "in"]),
});

const growSpaceSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	location: z.string().nullable(),
	space_type: z.string(),
	active: z.boolean(),
	dimensions: dimensionsSchema.nullable(),
	area_m2: z.union([z.string(), z.number()]).nullable(),
	volume_m3: z.union([z.string(), z.number()]).nullable(),
	mapping_count: z.number().int(),
	live_readings: z.array(liveReadingSchema),
	created_at: z.string(),
	updated_at: z.string(),
});

export const growSpaceSchema = growSpaceSummarySchema.extend({
	mappings: z.array(entityMappingSchema),
});

const growSpaceListSchema = z.object({
	items: z.array(growSpaceSummarySchema),
});

export const entityCandidateSchema = z.object({
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

const errorEnvelopeSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.record(z.string(), z.unknown()),
	}),
});

export type GrowSpace = z.infer<typeof growSpaceSchema>;
export type GrowSpaceSummary = z.infer<typeof growSpaceSummarySchema>;
export type EntityMapping = z.infer<typeof entityMappingSchema>;
export type EntityCandidate = z.infer<typeof entityCandidateSchema>;
export type Compatibility = z.infer<typeof compatibilitySchema>;

export type GrowSpaceType = "tent" | "greenhouse" | "outdoor" | "room";
export type LegacyGrowSpaceType = "cabinet" | "hydroponic_system" | "other";
export type DimensionUnit = "cm" | "in";

export interface DimensionsInput {
	length: string;
	width: string;
	height: string | null;
	unit: DimensionUnit;
}

export interface EntityMappingInput {
	entity_id: string;
	role: string;
	display_name?: string | null;
	priority?: number;
	enabled?: boolean;
	stale_after_seconds?: number | null;
}

export interface GrowSpaceCreateInput {
	name: string;
	description?: string | null;
	location?: string | null;
	space_type: GrowSpaceType;
	dimensions: DimensionsInput;
	mappings?: EntityMappingInput[];
}

export interface GrowSpaceUpdateInput {
	name?: string;
	description?: string | null;
	location?: string | null;
	space_type?: GrowSpaceType;
	dimensions?: DimensionsInput;
	active?: boolean;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function parseResponse<T>(
	response: Response,
	schema: z.ZodType<T>,
	invalidMessage: string,
): Promise<T> {
	const payload: unknown = await response.json();
	if (!response.ok) {
		const parsedError = errorEnvelopeSchema.safeParse(payload);
		throw new ApiError(
			parsedError.success ? parsedError.data.error.message : "Request failed",
			response.status,
			parsedError.success ? parsedError.data.error.code : "request_failed",
		);
	}
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(invalidMessage);
	}
	return parsed.data;
}

const jsonHeaders = {
	Accept: "application/json",
	"Content-Type": "application/json",
};

export async function listGrowSpaces(
	includeArchived = false,
	fetcher: typeof fetch = fetch,
) {
	const suffix = includeArchived ? "?include_archived=true" : "";
	const response = await fetcher(`api/v1/grow-spaces${suffix}`, {
		headers: { Accept: "application/json" },
	});
	return parseResponse(
		response,
		growSpaceListSchema,
		"Invalid grow-space response",
	);
}

export async function getGrowSpace(
	growSpaceId: string,
	fetcher: typeof fetch = fetch,
): Promise<GrowSpace> {
	const response = await fetcher(`api/v1/grow-spaces/${growSpaceId}`, {
		headers: { Accept: "application/json" },
	});
	return parseResponse(
		response,
		growSpaceSchema,
		"Invalid grow-space response",
	);
}

export async function createGrowSpace(
	input: GrowSpaceCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<GrowSpace> {
	const response = await fetcher("api/v1/grow-spaces", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(
		response,
		growSpaceSchema,
		"Invalid grow-space response",
	);
}

export async function updateGrowSpace(
	growSpaceId: string,
	input: GrowSpaceUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<GrowSpace> {
	const response = await fetcher(`api/v1/grow-spaces/${growSpaceId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(
		response,
		growSpaceSchema,
		"Invalid grow-space response",
	);
}

export async function archiveGrowSpace(
	growSpaceId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/grow-spaces/${growSpaceId}`, {
		method: "DELETE",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new ApiError(
			"Unable to archive grow space",
			response.status,
			"archive_failed",
		);
	}
}

export async function discoverEntities(
	role: string,
	fetcher: typeof fetch = fetch,
): Promise<EntityCandidate[]> {
	const response = await fetcher(
		`api/v1/home-assistant/entities?role=${encodeURIComponent(role)}`,
		{ headers: { Accept: "application/json" } },
	);
	const result = await parseResponse(
		response,
		entityDiscoverySchema,
		"Invalid entity-discovery response",
	);
	return result.items;
}

export const growSpaceKeys = {
	all: ["grow-spaces"] as const,
	list: (includeArchived: boolean) =>
		["grow-spaces", { includeArchived }] as const,
	detail: (id: string) => ["grow-spaces", id] as const,
	candidates: (role: string) => ["home-assistant", "entities", role] as const,
};

export function useGrowSpaces(includeArchived = false) {
	return useQuery({
		queryKey: growSpaceKeys.list(includeArchived),
		queryFn: () => listGrowSpaces(includeArchived),
	});
}

export function useGrowSpace(growSpaceId: string) {
	return useQuery({
		queryKey: growSpaceKeys.detail(growSpaceId),
		queryFn: () => getGrowSpace(growSpaceId),
	});
}

function updateCreatedCache(queryClient: QueryClient, growSpace: GrowSpace) {
	queryClient.setQueryData(growSpaceKeys.detail(growSpace.id), growSpace);
	return queryClient.invalidateQueries({ queryKey: growSpaceKeys.all });
}

export function useCreateGrowSpace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: GrowSpaceCreateInput) => createGrowSpace(input),
		onSuccess: (growSpace) => updateCreatedCache(queryClient, growSpace),
	});
}

export function useUpdateGrowSpace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			growSpaceId,
			input,
		}: {
			growSpaceId: string;
			input: GrowSpaceUpdateInput;
		}) => updateGrowSpace(growSpaceId, input),
		onSuccess: (growSpace) => updateCreatedCache(queryClient, growSpace),
	});
}

export function useArchiveGrowSpace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (growSpaceId: string) => archiveGrowSpace(growSpaceId),
		onSuccess: (_result, growSpaceId) =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: growSpaceKeys.all }),
				queryClient.invalidateQueries({
					queryKey: growSpaceKeys.detail(growSpaceId),
				}),
			]),
	});
}

export function useEntityCandidates(role: string | null) {
	return useQuery({
		queryKey: growSpaceKeys.candidates(role ?? "none"),
		queryFn: () => discoverEntities(role ?? ""),
		enabled: role !== null,
		retry: (failureCount, error) =>
			!(error instanceof ApiError && error.status === 422) && failureCount < 1,
	});
}
