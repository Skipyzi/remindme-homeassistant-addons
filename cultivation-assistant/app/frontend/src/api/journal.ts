import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { acceptJson, expectOk, jsonHeaders, parseResponse } from "./client";

export const journalEntryTypeSchema = z.enum([
	"watered",
	"fed",
	"transplanted",
	"topped",
	"trained",
	"defoliated",
	"light_schedule_changed",
	"flowering_initiated",
	"first_flowers_observed",
	"problem_observed",
	"treatment_applied",
	"harvested",
	"drying_started",
	"jarred",
	"cure_milestone",
	"note",
]);

export const measurementMetricSchema = z.enum([
	"height",
	"width",
	"canopy_diameter",
	"stem_diameter",
	"node_count",
	"container_weight",
	"plant_weight",
	"custom",
]);

const compactStageRefSchema = z.object({
	id: z.string(),
	key: z.string(),
	label: z.string(),
});

export const journalEntrySchema = z.object({
	id: z.string(),
	subject_type: z.enum(["plant", "grow"]),
	subject_id: z.string(),
	entry_type: journalEntryTypeSchema,
	occurred_at: z.string(),
	title: z.string().nullable(),
	notes: z.string().nullable(),
	tags: z.array(z.string()),
	related_stage: compactStageRefSchema.nullable(),
	related_issue: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

const journalEntryListSchema = z.object({ items: z.array(journalEntrySchema) });

export const measurementSchema = z.object({
	id: z.string(),
	plant_id: z.string(),
	metric_type: measurementMetricSchema,
	custom_metric_name: z.string().nullable(),
	value: z.number(),
	unit: z.string(),
	occurred_at: z.string(),
	notes: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

const measurementListSchema = z.object({ items: z.array(measurementSchema) });

export const photoSchema = z.object({
	id: z.string(),
	plant_id: z.string(),
	journal_entry_id: z.string().nullable(),
	measurement_id: z.string().nullable(),
	stage: compactStageRefSchema.nullable(),
	caption: z.string().nullable(),
	tags: z.array(z.string()),
	content_type: z.string(),
	file_size: z.number(),
	occurred_at: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
});

const photoListSchema = z.object({ items: z.array(photoSchema) });

const timelineStageTransitionSchema = z.object({
	id: z.string(),
	from_stage: compactStageRefSchema.nullable(),
	to_stage: compactStageRefSchema,
	effective_at: z.string(),
	source: z.string(),
	notes: z.string().nullable(),
	created_at: z.string(),
});

export const timelineEntrySchema = z.object({
	id: z.string(),
	event_type: z.string(),
	occurred_at: z.string(),
	summary: z.string(),
	journal_entry: journalEntrySchema.nullable(),
	measurement: measurementSchema.nullable(),
	photo: photoSchema.nullable(),
	stage_transition: timelineStageTransitionSchema.nullable(),
});

const timelineListSchema = z.object({ items: z.array(timelineEntrySchema) });

export type JournalEntryType = z.infer<typeof journalEntryTypeSchema>;
export type MeasurementMetric = z.infer<typeof measurementMetricSchema>;
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type Photo = z.infer<typeof photoSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type TimelineList = z.infer<typeof timelineListSchema>;

export interface JournalEntryCreateInput {
	entry_type: JournalEntryType;
	occurred_at?: string;
	title?: string | null;
	notes?: string | null;
	tags?: string[];
	related_stage_id?: string | null;
	related_issue?: string | null;
}

export interface JournalEntryUpdateInput {
	entry_type?: JournalEntryType;
	occurred_at?: string;
	title?: string | null;
	notes?: string | null;
	tags?: string[];
	related_stage_id?: string | null;
	related_issue?: string | null;
}

export interface MeasurementCreateInput {
	metric_type: MeasurementMetric;
	custom_metric_name?: string | null;
	value: number;
	unit: string;
	occurred_at?: string;
	notes?: string | null;
}

export interface MeasurementUpdateInput {
	metric_type?: MeasurementMetric;
	custom_metric_name?: string | null;
	value?: number;
	unit?: string;
	occurred_at?: string;
	notes?: string | null;
}

export interface PhotoUploadInput {
	file: File;
	caption?: string | null;
	tags?: string[];
	journalEntryId?: string | null;
	measurementId?: string | null;
	stageId?: string | null;
	occurredAt?: string;
}

export interface PhotoUpdateInput {
	caption?: string | null;
	tags?: string[];
	journal_entry_id?: string | null;
	measurement_id?: string | null;
}

export interface TimelineFilters {
	limit?: number;
	offset?: number;
}

export async function createPlantJournalEntry(
	plantId: string,
	input: JournalEntryCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<JournalEntry> {
	const response = await fetcher(`api/v1/plants/${plantId}/journal-entries`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, journalEntrySchema, "Invalid journal entry response");
}

export async function createGrowJournalEntry(
	growId: string,
	input: JournalEntryCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<JournalEntry> {
	const response = await fetcher(`api/v1/grows/${growId}/journal-entries`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, journalEntrySchema, "Invalid journal entry response");
}

export async function listPlantJournalEntries(
	plantId: string,
	fetcher: typeof fetch = fetch,
): Promise<JournalEntry[]> {
	const response = await fetcher(`api/v1/plants/${plantId}/journal-entries`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		journalEntryListSchema,
		"Invalid journal entry response",
	);
	return result.items;
}

export async function listGrowJournalEntries(
	growId: string,
	fetcher: typeof fetch = fetch,
): Promise<JournalEntry[]> {
	const response = await fetcher(`api/v1/grows/${growId}/journal-entries`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		journalEntryListSchema,
		"Invalid journal entry response",
	);
	return result.items;
}

export async function updateJournalEntry(
	entryId: string,
	input: JournalEntryUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<JournalEntry> {
	const response = await fetcher(`api/v1/journal-entries/${entryId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, journalEntrySchema, "Invalid journal entry response");
}

export async function deleteJournalEntry(
	entryId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/journal-entries/${entryId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to delete journal entry", "delete_failed");
}

export async function createMeasurement(
	plantId: string,
	input: MeasurementCreateInput,
	fetcher: typeof fetch = fetch,
): Promise<Measurement> {
	const response = await fetcher(`api/v1/plants/${plantId}/measurements`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, measurementSchema, "Invalid measurement response");
}

export async function listMeasurements(
	plantId: string,
	fetcher: typeof fetch = fetch,
): Promise<Measurement[]> {
	const response = await fetcher(`api/v1/plants/${plantId}/measurements`, {
		headers: acceptJson,
	});
	const result = await parseResponse(
		response,
		measurementListSchema,
		"Invalid measurement response",
	);
	return result.items;
}

export async function updateMeasurement(
	measurementId: string,
	input: MeasurementUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<Measurement> {
	const response = await fetcher(`api/v1/measurements/${measurementId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, measurementSchema, "Invalid measurement response");
}

export async function deleteMeasurement(
	measurementId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/measurements/${measurementId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to delete measurement", "delete_failed");
}

export async function uploadPhoto(
	plantId: string,
	input: PhotoUploadInput,
	fetcher: typeof fetch = fetch,
): Promise<Photo> {
	const body = new FormData();
	body.set("file", input.file);
	if (input.caption) body.set("caption", input.caption);
	for (const tag of input.tags ?? []) body.append("tags", tag);
	if (input.journalEntryId) body.set("journal_entry_id", input.journalEntryId);
	if (input.measurementId) body.set("measurement_id", input.measurementId);
	if (input.stageId) body.set("stage_id", input.stageId);
	if (input.occurredAt) body.set("occurred_at", input.occurredAt);

	const response = await fetcher(`api/v1/plants/${plantId}/photos`, {
		method: "POST",
		headers: acceptJson,
		body,
	});
	return parseResponse(response, photoSchema, "Invalid photo response");
}

export async function listPhotos(
	plantId: string,
	fetcher: typeof fetch = fetch,
): Promise<Photo[]> {
	const response = await fetcher(`api/v1/plants/${plantId}/photos`, {
		headers: acceptJson,
	});
	const result = await parseResponse(response, photoListSchema, "Invalid photo response");
	return result.items;
}

export async function updatePhoto(
	photoId: string,
	input: PhotoUpdateInput,
	fetcher: typeof fetch = fetch,
): Promise<Photo> {
	const response = await fetcher(`api/v1/photos/${photoId}`, {
		method: "PATCH",
		headers: jsonHeaders,
		body: JSON.stringify(input),
	});
	return parseResponse(response, photoSchema, "Invalid photo response");
}

export async function deletePhoto(
	photoId: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(`api/v1/photos/${photoId}`, {
		method: "DELETE",
		headers: acceptJson,
	});
	await expectOk(response, "Unable to delete photo", "delete_failed");
}

export function photoFileUrl(photoId: string): string {
	return `api/v1/photos/${photoId}/file`;
}

export async function fetchPlantTimeline(
	plantId: string,
	filters: TimelineFilters = {},
	fetcher: typeof fetch = fetch,
): Promise<TimelineList> {
	const params = new URLSearchParams();
	if (filters.limit !== undefined) params.set("limit", String(filters.limit));
	if (filters.offset !== undefined) params.set("offset", String(filters.offset));
	const query = params.toString();
	const response = await fetcher(`api/v1/plants/${plantId}/timeline${query ? `?${query}` : ""}`, {
		headers: acceptJson,
	});
	return parseResponse(response, timelineListSchema, "Invalid timeline response");
}

export const journalKeys = {
	plant: (plantId: string) => ["journal-entries", "plant", plantId] as const,
	grow: (growId: string) => ["journal-entries", "grow", growId] as const,
};

export const measurementKeys = {
	plant: (plantId: string) => ["measurements", "plant", plantId] as const,
};

export const photoKeys = {
	plant: (plantId: string) => ["photos", "plant", plantId] as const,
};

export const timelineKeys = {
	plant: (plantId: string, filters: TimelineFilters = {}) =>
		["timeline", "plant", plantId, filters] as const,
};

function invalidatePlantActivity(queryClient: QueryClient, plantId: string) {
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: journalKeys.plant(plantId) }),
		queryClient.invalidateQueries({ queryKey: measurementKeys.plant(plantId) }),
		queryClient.invalidateQueries({ queryKey: photoKeys.plant(plantId) }),
		queryClient.invalidateQueries({ queryKey: ["timeline", "plant", plantId] }),
	]);
}

export function usePlantJournalEntries(plantId: string) {
	return useQuery({
		queryKey: journalKeys.plant(plantId),
		queryFn: () => listPlantJournalEntries(plantId),
	});
}

export function useGrowJournalEntries(growId: string) {
	return useQuery({
		queryKey: journalKeys.grow(growId),
		queryFn: () => listGrowJournalEntries(growId),
	});
}

export function useCreatePlantJournalEntry(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: JournalEntryCreateInput) => createPlantJournalEntry(plantId, input),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function useCreateGrowJournalEntry(growId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: JournalEntryCreateInput) => createGrowJournalEntry(growId, input),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: journalKeys.grow(growId) }),
	});
}

export function useUpdateJournalEntry(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, input }: { entryId: string; input: JournalEntryUpdateInput }) =>
			updateJournalEntry(entryId, input),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function useDeleteJournalEntry(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (entryId: string) => deleteJournalEntry(entryId),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function useMeasurements(plantId: string) {
	return useQuery({
		queryKey: measurementKeys.plant(plantId),
		queryFn: () => listMeasurements(plantId),
	});
}

export function useCreateMeasurement(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: MeasurementCreateInput) => createMeasurement(plantId, input),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function useDeleteMeasurement(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (measurementId: string) => deleteMeasurement(measurementId),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function usePhotos(plantId: string) {
	return useQuery({
		queryKey: photoKeys.plant(plantId),
		queryFn: () => listPhotos(plantId),
	});
}

export function useUploadPhoto(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: PhotoUploadInput) => uploadPhoto(plantId, input),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function useDeletePhoto(plantId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (photoId: string) => deletePhoto(photoId),
		onSuccess: () => invalidatePlantActivity(queryClient, plantId),
	});
}

export function usePlantTimeline(plantId: string, filters: TimelineFilters = {}) {
	return useQuery({
		queryKey: timelineKeys.plant(plantId, filters),
		queryFn: () => fetchPlantTimeline(plantId, filters),
	});
}
