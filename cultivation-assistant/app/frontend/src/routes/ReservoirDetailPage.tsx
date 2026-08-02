import { useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
	ArrowLeft,
	Droplets,
	Gauge,
	Pencil,
	Power,
	Ruler,
	Target,
} from "lucide-react";
import {
	useArchiveReservoir,
	useReservoir,
	useUpdateReservoir,
	type Reservoir,
	type ReservoirUpdateInput,
} from "../api/reservoirs";
import { CalibrationTableEditor } from "../features/reservoirs/CalibrationTableEditor";
import { ReservoirMappingFields } from "../features/reservoirs/ReservoirMappingFields";
import {
	calculateGeometryPreview,
	type GeometryDraft,
} from "../features/reservoirs/geometry";
import { ReservoirDetailsForm } from "../features/reservoirs/ReservoirDetailsForm";
import { ReservoirGeometryForm } from "../features/reservoirs/ReservoirGeometryForm";
import {
	geometryShapeLabels,
	reservoirTypeLabels,
	validateReservoirDetails,
	validateReservoirGeometry,
	type ReservoirDraft,
} from "../features/reservoirs/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

function draftFromReservoir(record: Reservoir): ReservoirDraft {
	const geometry = record.geometry;
	return {
		name: record.name,
		reservoirType: record.reservoir_type,
		primaryGrowSpaceId: record.primary_grow_space_id ?? "",
		capacityLiters: String(record.capacity_liters),
		usableCapacityLiters:
			record.usable_capacity_liters === null
				? ""
				: String(record.usable_capacity_liters),
		minimumSafeVolumeLiters:
			record.minimum_safe_volume_liters === null
				? ""
				: String(record.minimum_safe_volume_liters),
		refillThresholdLiters:
			record.refill_threshold_liters === null
				? ""
				: String(record.refill_threshold_liters),
		overflowThresholdLiters:
			record.overflow_threshold_liters === null
				? ""
				: String(record.overflow_threshold_liters),
		geometry: {
			shape: geometry.shape,
			unit: geometry.unit ?? "cm",
			length: geometry.length === null ? "" : String(geometry.length),
			width: geometry.width === null ? "" : String(geometry.width),
			height: geometry.height === null ? "" : String(geometry.height),
			diameter: geometry.diameter === null ? "" : String(geometry.diameter),
		},
		active: record.active,
	};
}

function optionalOrUndefined(
	current: string,
	record: string | number | null,
): string | null | undefined {
	if (current.trim()) return current.trim();
	// Sending null explicitly clears a previously set value.
	return record === null ? undefined : null;
}

function buildUpdateInput(
	record: Reservoir,
	draft: ReservoirDraft,
): ReservoirUpdateInput {
	const input: ReservoirUpdateInput = {};
	if (draft.name.trim() !== record.name) input.name = draft.name.trim();

	const growSpaceId = draft.primaryGrowSpaceId.trim() || null;
	if (growSpaceId !== record.primary_grow_space_id) {
		input.primary_grow_space_id = growSpaceId;
	}

	if (String(draft.capacityLiters.trim()) !== String(record.capacity_liters)) {
		input.capacity_liters = draft.capacityLiters.trim();
	}

	const usable = optionalOrUndefined(
		draft.usableCapacityLiters,
		record.usable_capacity_liters,
	);
	if (usable !== undefined) input.usable_capacity_liters = usable;

	const minSafe = optionalOrUndefined(
		draft.minimumSafeVolumeLiters,
		record.minimum_safe_volume_liters,
	);
	if (minSafe !== undefined) input.minimum_safe_volume_liters = minSafe;

	const refill = optionalOrUndefined(
		draft.refillThresholdLiters,
		record.refill_threshold_liters,
	);
	if (refill !== undefined) input.refill_threshold_liters = refill;

	const overflow = optionalOrUndefined(
		draft.overflowThresholdLiters,
		record.overflow_threshold_liters,
	);
	if (overflow !== undefined) input.overflow_threshold_liters = overflow;

	if (draft.active !== record.active) input.active = draft.active;

	const current = record.geometry;
	const geometryChanged =
		draft.geometry.shape !== current.shape ||
		draft.geometry.unit !== (current.unit ?? "cm") ||
		draft.geometry.length !== (current.length === null ? "" : String(current.length)) ||
		draft.geometry.width !== (current.width === null ? "" : String(current.width)) ||
		draft.geometry.height !== (current.height === null ? "" : String(current.height)) ||
		draft.geometry.diameter !==
			(current.diameter === null ? "" : String(current.diameter));
	if (geometryChanged) {
		if (draft.geometry.shape === "custom_calibration_table") {
			input.geometry = { shape: "custom_calibration_table" };
		} else {
			input.geometry = {
				shape: draft.geometry.shape,
				unit: draft.geometry.unit,
				length: draft.geometry.length.trim() || null,
				width: draft.geometry.width.trim() || null,
				height: draft.geometry.height.trim() || null,
				diameter: draft.geometry.diameter.trim() || null,
			};
		}
	}
	return input;
}

function geometryText(record: Reservoir): string {
	const geometry = record.geometry;
	if (geometry.shape === "custom_calibration_table") return "";
	const parts: string[] = [];
	if (geometry.length !== null) parts.push(`L ${geometry.length}`);
	if (geometry.width !== null) parts.push(`W ${geometry.width}`);
	if (geometry.height !== null) parts.push(`H ${geometry.height}`);
	if (geometry.diameter !== null) parts.push(`Ø ${geometry.diameter}`);
	const unitLabel = geometry.unit ? ` ${geometry.unit}` : "";
	return parts.length > 0 ? `${parts.join(" · ")}${unitLabel}` : "";
}

function PlannedReservoirCapabilities() {
	return (
		<section className="capability-section planned-capabilities">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Independent attachments</p>
					<h2>Additional capabilities</h2>
				</div>
				<Gauge size={20} />
			</div>
			<div className="planned-capability-grid">
				<Card>
					<Target size={20} />
					<Badge tone="neutral">Planned</Badge>
					<h3>Consumption &amp; forecast</h3>
					<p>
						Daily consumption, seven-day average, and refill forecasts will derive
						from mapped level sensors.
					</p>
				</Card>
				<Card>
					<Power size={20} />
					<Badge tone="neutral">Planned</Badge>
					<h3>Irrigation events</h3>
					<p>Logged irrigation runs and source-volume reconciliation attach here.</p>
				</Card>
			</div>
		</section>
	);
}

export function ReservoirDetailContent({
	reservoirId,
}: {
	reservoirId: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<ReservoirDraft | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const errorRef = useRef<HTMLDivElement>(null);
	const reservoir = useReservoir(reservoirId);
	const update = useUpdateReservoir();
	const archive = useArchiveReservoir();

	useEffect(() => {
		if (validationError || update.error) errorRef.current?.focus();
	}, [validationError, update.error]);

	if (reservoir.isLoading) {
		return (
			<div className="detail-register-skeleton" aria-label="Loading reservoir" />
		);
	}
	if (reservoir.isError || !reservoir.data) {
		return (
			<section className="state-register" role="alert">
				<p className="eyebrow">Record unavailable</p>
				<h1>Reservoir could not be loaded</h1>
				<p>
					{reservoir.error?.message ?? "This reservoir record does not exist."}
				</p>
				<Button variant="secondary" onClick={() => reservoir.refetch()}>
					Retry
				</Button>
			</section>
		);
	}

	const record = reservoir.data;
	const measurement = geometryText(record);
	const preview =
		record.geometry.shape === "custom_calibration_table"
			? null
			: calculateGeometryPreview(draft?.geometry ?? (draftFromReservoir(record).geometry as GeometryDraft));

	function beginEditing() {
		setDraft(draftFromReservoir(record));
		setValidationError(null);
		setEditing(true);
	}

	async function saveChanges() {
		if (!draft) return;
		const detailsError = validateReservoirDetails(draft);
		const geometryError = validateReservoirGeometry(draft);
		const error = detailsError ?? geometryError;
		if (error) {
			setValidationError(error);
			return;
		}
		setValidationError(null);
		try {
			await update.mutateAsync({ reservoirId: record.id, input: buildUpdateInput(record, draft) });
			setEditing(false);
			setDraft(null);
		} catch {
			// Mutation state renders and focuses the stable error summary.
		}
	}

	async function toggleArchive() {
		if (record.active) {
			await archive.mutateAsync(record.id);
		} else {
			await update.mutateAsync({ reservoirId: record.id, input: { active: true } });
		}
	}

	return (
		<div className="page-stack reservoir-detail">
			<button
				className="detail-back-link"
				type="button"
				onClick={() => {
					window.location.hash = "/reservoirs";
				}}
			>
				<ArrowLeft size={15} /> Reservoir register
			</button>

			<section className="detail-ledger-heading">
				<div>
					<p className="eyebrow">
						Tank record ·{" "}
						{reservoirTypeLabels[record.reservoir_type] ??
							record.reservoir_type.replaceAll("_", " ")}
					</p>
					<h1>{record.name}</h1>
					<p>
						{record.active
							? "Active reservoir record. Home Assistant remains responsible for physical safety and interlocks."
							: "Inactive reservoir retained in history with its calibration and audit trail."}
					</p>
				</div>
				<div className="detail-heading-actions">
					<Badge tone={record.active ? "healthy" : "neutral"}>
						{record.active ? "Active" : "Inactive"}
					</Badge>
					{!editing && (
						<>
							<Button variant="secondary" onClick={beginEditing}>
								<Pencil size={14} /> Edit details
							</Button>
							<Button
								variant="ghost"
								disabled={archive.isPending || update.isPending}
								onClick={toggleArchive}
							>
								{record.active ? "Archive" : "Reactivate"}
							</Button>
						</>
					)}
				</div>
			</section>

			{editing && draft && (
				<section
					className="capability-section detail-editor"
					aria-labelledby="edit-details-heading"
				>
					<div className="section-heading-row">
						<div>
							<p className="eyebrow">Tank amendment</p>
							<h2 id="edit-details-heading">Edit details</h2>
						</div>
					</div>
					{(validationError || update.error) && (
						<div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
							<strong>The changes were not saved.</strong>
							<span>{validationError ?? update.error?.message}</span>
						</div>
					)}
					<div className="detail-editor__form">
						<ReservoirDetailsForm
							mode="edit"
							value={draft}
							onChange={setDraft}
						/>
						<div className="reservoir-geometry-edit">
							<ReservoirGeometryForm value={draft} onChange={setDraft} />
						</div>
					</div>
					<div className="detail-editor__actions">
						<Button variant="ghost" onClick={() => setEditing(false)}>
							Discard
						</Button>
						<Button disabled={update.isPending} onClick={saveChanges}>
							{update.isPending ? "Saving…" : "Save changes"}
						</Button>
					</div>
				</section>
			)}

			{measurement && (
				<p className="detail-dimensions-record">
					<Ruler size={14} /> {measurement}
				</p>
			)}
			<div className="detail-meta-grid">
				<Card>
					<span>Capacity</span>
					<strong>{Number(record.capacity_liters)} L</strong>
				</Card>
				<Card>
					<span>Usable capacity</span>
					<strong>
						{record.usable_capacity_liters === null
							? "Same as capacity"
							: `${Number(record.usable_capacity_liters)} L`}
					</strong>
				</Card>
				<Card>
					<span>Geometry</span>
					<strong>
						{geometryShapeLabels[record.geometry.shape] ??
							record.geometry.shape.replaceAll("_", " ")}
					</strong>
				</Card>
				<Card>
					<span>Estimated volume</span>
					<strong>
						{preview ? `${preview.volumeLiters} L` : "Not available"}
					</strong>
				</Card>
			</div>

			{(record.refill_threshold_liters !== null ||
				record.minimum_safe_volume_liters !== null ||
				record.overflow_threshold_liters !== null) && (
				<div className="detail-meta-grid">
					<Card>
						<span>Refill threshold</span>
						<strong>
							{record.refill_threshold_liters === null
								? "Not set"
								: `${Number(record.refill_threshold_liters)} L`}
						</strong>
					</Card>
					<Card>
						<span>Minimum safe volume</span>
						<strong>
							{record.minimum_safe_volume_liters === null
								? "Not set"
								: `${Number(record.minimum_safe_volume_liters)} L`}
						</strong>
					</Card>
					<Card>
						<span>Overflow threshold</span>
						<strong>
							{record.overflow_threshold_liters === null
								? "Not set"
								: `${Number(record.overflow_threshold_liters)} L`}
						</strong>
					</Card>
				</div>
			)}

			<ReservoirMappingFields reservoirId={record.id} reservoir={record} />
			<CalibrationTableEditor reservoirId={record.id} reservoirName={record.name} />
			<PlannedReservoirCapabilities />
			<section className="inactive-policy-note">
				<p>
					<Droplets size={13} /> Inactive reservoirs remain in history, retain their
					calibration tables, and can be reactivated.
				</p>
			</section>
		</div>
	);
}

export function ReservoirDetailPage() {
	const params = useParams({ strict: false }) as { reservoirId?: string };
	if (!params.reservoirId)
		return (
			<section className="state-register">
				<h1>Reservoir not specified</h1>
			</section>
		);
	return <ReservoirDetailContent reservoirId={params.reservoirId} />;
}
