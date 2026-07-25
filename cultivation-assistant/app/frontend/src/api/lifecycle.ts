import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, expectOk, jsonHeaders, parseResponse } from "./client";

export const lifecycleStageSchema = z.object({
	id: z.string(),
	key: z.string(),
	label: z.string(),
	position: z.number().int(),
	enabled: z.boolean(),
	built_in: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
});

const lifecycleStageListSchema = z.object({
	items: z.array(lifecycleStageSchema),
});

export type LifecycleStage = z.infer<typeof lifecycleStageSchema>;

export async function listLifecycleStages(
	includeDisabled = false,
	fetcher: typeof fetch = fetch,
): Promise<LifecycleStage[]> {
	const suffix = includeDisabled ? "?include_disabled=true" : "";
	const response = await fetcher(`api/v1/lifecycle-stages${suffix}`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		lifecycleStageListSchema,
		"Invalid lifecycle stage response",
	);
	return result.items;
}

export async function createLifecycleStage(
	input: { key: string; label: string; enabled?: boolean },
	fetcher: typeof fetch = fetch,
): Promise<LifecycleStage> {
	const response = await fetcher("api/v1/lifecycle-stages", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(
		response,
		lifecycleStageSchema,
		"Invalid lifecycle stage response",
	);
}

export async function updateLifecycleStage(
	stageId: string,
	input: { label?: string; enabled?: boolean },
	fetcher: typeof fetch = fetch,
): Promise<LifecycleStage> {
	const response = await fetcher(`api/v1/lifecycle-stages/${stageId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(
		response,
		lifecycleStageSchema,
		"Invalid lifecycle stage response",
	);
}

export async function updateLifecycleStageOrder(
	stageIds: string[],
	fetcher: typeof fetch = fetch,
): Promise<LifecycleStage[]> {
	const response = await fetcher("api/v1/lifecycle-stages/order", {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ stage_ids: stageIds }),
	});
	const result = await parseResponse(
		response,
		lifecycleStageListSchema,
		"Invalid lifecycle stage response",
	);
	return result.items;
}

export async function deleteLifecycleStage(
	stageId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/lifecycle-stages/${stageId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to delete stage", "delete_failed");
}

export const lifecycleKeys = {
	stages: (includeDisabled: boolean) =>
		["lifecycle-stages", { includeDisabled }] as const,
};

export function useLifecycleStages(includeDisabled = false) {
	return useQuery({
		queryKey: lifecycleKeys.stages(includeDisabled),
		queryFn: () => listLifecycleStages(includeDisabled),
	});
}

function invalidateStages(queryClient: QueryClient) {
	return queryClient.invalidateQueries({ queryKey: ["lifecycle-stages"] });
}

export function useCreateLifecycleStage() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { key: string; label: string; enabled?: boolean }) =>
			createLifecycleStage(input),
		onSuccess: () => invalidateStages(queryClient),
	});
}

export function useUpdateLifecycleStage() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			stageId,
			input,
		}: {
			stageId: string;
			input: { label?: string; enabled?: boolean };
		}) => updateLifecycleStage(stageId, input),
		onSuccess: () => invalidateStages(queryClient),
	});
}

export function useReorderLifecycleStages() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (stageIds: string[]) => updateLifecycleStageOrder(stageIds),
		onSuccess: () => invalidateStages(queryClient),
	});
}

export function useDeleteLifecycleStage() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (stageId: string) => deleteLifecycleStage(stageId),
		onSuccess: () => invalidateStages(queryClient),
	});
}
