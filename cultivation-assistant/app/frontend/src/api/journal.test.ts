import { describe, expect, it, vi } from "vitest";
import {
	createGrowJournalEntry,
	createMeasurement,
	createPlantJournalEntry,
	deletePhoto,
	fetchPlantTimeline,
	listMeasurements,
	listPhotos,
	listPlantJournalEntries,
	uploadPhoto,
} from "./journal";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const journalEntryFixture = {
	id: "entry-1",
	subject_type: "plant",
	subject_id: "plant-1",
	entry_type: "note",
	occurred_at: "2026-07-23T10:00:00Z",
	title: "Topped today",
	notes: null,
	tags: ["training"],
	related_stage: null,
	related_issue: null,
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

const measurementFixture = {
	id: "measurement-1",
	plant_id: "plant-1",
	metric_type: "height",
	custom_metric_name: null,
	value: 32.5,
	unit: "cm",
	occurred_at: "2026-07-23T10:00:00Z",
	notes: null,
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

const photoFixture = {
	id: "photo-1",
	plant_id: "plant-1",
	journal_entry_id: null,
	measurement_id: null,
	stage: null,
	caption: null,
	tags: [],
	content_type: "image/png",
	file_size: 42,
	occurred_at: "2026-07-23T10:00:00Z",
	created_at: "2026-07-23T10:00:00Z",
	updated_at: "2026-07-23T10:00:00Z",
};

const timelineFixture = {
	items: [
		{
			id: "photo:photo-1",
			event_type: "photo_added",
			occurred_at: "2026-07-23T10:00:00Z",
			summary: "Photo added",
			journal_entry: null,
			measurement: null,
			photo: photoFixture,
			stage_transition: null,
		},
	],
};

describe("journal API", () => {
	it("creates a plant journal entry through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(journalEntryFixture, 201));
		await createPlantJournalEntry(
			"plant-1",
			{ entry_type: "note", title: "Topped today", tags: ["training"] },
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants/plant-1/journal-entries",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("creates a grow journal entry through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(journalEntryFixture, 201));
		await createGrowJournalEntry("grow-1", { entry_type: "note" }, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/grows/grow-1/journal-entries",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("lists journal entries for a plant", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [journalEntryFixture] }));
		const entries = await listPlantJournalEntries("plant-1", fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants/plant-1/journal-entries",
			expect.anything(),
		);
		expect(entries).toHaveLength(1);
	});

	it("creates a measurement through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(measurementFixture, 201));
		await createMeasurement(
			"plant-1",
			{ metric_type: "height", value: 32.5, unit: "cm" },
			fetcher,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants/plant-1/measurements",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("lists measurements for a plant", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [measurementFixture] }));
		const measurements = await listMeasurements("plant-1", fetcher);
		expect(measurements).toHaveLength(1);
	});

	it("uploads a photo as multipart form data", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(photoFixture, 201));
		await uploadPhoto(
			"plant-1",
			{ file: new File(["x"], "leaf.png", { type: "image/png" }), caption: "Week 3" },
			fetcher,
		);
		const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("api/v1/plants/plant-1/photos");
		expect(init.method).toBe("POST");
		expect(init.body).toBeInstanceOf(FormData);
	});

	it("lists photos for a plant", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ items: [photoFixture] }));
		const photos = await listPhotos("plant-1", fetcher);
		expect(photos).toHaveLength(1);
	});

	it("deletes a photo through an Ingress-relative URL", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		await deletePhoto("photo-1", fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/photos/photo-1",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("fetches the merged plant timeline", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse(timelineFixture));
		const timeline = await fetchPlantTimeline("plant-1", {}, fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"api/v1/plants/plant-1/timeline",
			expect.anything(),
		);
		expect(timeline.items).toHaveLength(1);
		expect(timeline.items[0].photo?.id).toBe("photo-1");
	});
});
