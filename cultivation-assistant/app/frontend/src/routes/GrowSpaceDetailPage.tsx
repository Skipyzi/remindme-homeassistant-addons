import { useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
	ArrowLeft,
	Droplets,
	Gauge,
	Leaf,
	Pencil,
	Power,
	Radio,
	Target,
	Thermometer,
} from "lucide-react";
import {
	useGrowSpace,
	useUpdateGrowSpace,
	type GrowSpace,
	type GrowSpaceType,
	type GrowSpaceUpdateInput,
} from "../api/growSpaces";
import { GrowSpaceDetailsForm } from "../features/grow-spaces/GrowSpaceDetailsForm";
import {
	environmentalRoleLabels,
	growSpaceTypeLabels,
	growSpaceTypeOptions,
	validateGrowSpaceDetails,
	type GrowSpaceDetailsDraft,
} from "../features/grow-spaces/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

function valueText(
	value: string | number | boolean | null,
	unit: string | null,
) {
	if (value === null) return "No numeric reading";
	return `${String(value)}${unit ? ` ${unit}` : ""}`;
}

function detailsDraft(record: GrowSpace): GrowSpaceDetailsDraft {
	return {
		name: record.name,
		description: record.description ?? "",
		location: record.location ?? "",
		spaceType: record.space_type as GrowSpaceDetailsDraft["spaceType"],
		length: record.dimensions ? String(record.dimensions.length) : "",
		width: record.dimensions ? String(record.dimensions.width) : "",
		height: record.dimensions?.height ? String(record.dimensions.height) : "",
		dimensionUnit: record.dimensions?.unit ?? "cm",
		active: record.active,
	};
}

function buildUpdateInput(
	record: GrowSpace,
	draft: GrowSpaceDetailsDraft,
): GrowSpaceUpdateInput {
	const input: GrowSpaceUpdateInput = {};
	if (draft.name.trim() !== record.name) input.name = draft.name.trim();
	if ((draft.description.trim() || null) !== record.description) {
		input.description = draft.description.trim() || null;
	}
	if ((draft.location.trim() || null) !== record.location) {
		input.location = draft.location.trim() || null;
	}
	if (draft.active !== record.active) input.active = draft.active;
	if (
		draft.spaceType !== record.space_type &&
		growSpaceTypeOptions.some(([type]) => type === draft.spaceType)
	) {
		input.space_type = draft.spaceType as GrowSpaceType;
	}

	const currentDimensions = record.dimensions;
	const dimensionsChanged =
		!currentDimensions ||
		draft.length !== String(currentDimensions.length) ||
		draft.width !== String(currentDimensions.width) ||
		draft.height !==
			(currentDimensions.height === null ? "" : String(currentDimensions.height)) ||
		draft.dimensionUnit !== currentDimensions.unit;
	if (dimensionsChanged && (draft.length || draft.width || draft.height)) {
		input.dimensions = {
			length: draft.length,
			width: draft.width,
			height: draft.height.trim() || null,
			unit: draft.dimensionUnit,
		};
	}
	return input;
}

function dimensionsText(record: GrowSpace) {
	if (!record.dimensions) return null;
	return `${[
		record.dimensions.length,
		record.dimensions.width,
		record.dimensions.height,
	]
		.filter((value) => value !== null)
		.join(" × ")} ${record.dimensions.unit}`;
}

function EnvironmentalRecords({ record }: { record: GrowSpace }) {
	return (
		<section className="capability-section">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Capability 01 · Available</p>
					<h2>Environmental records</h2>
				</div>
				<Radio size={20} />
			</div>
			{record.mappings.length === 0 ? (
				<div className="capability-empty">
					<Thermometer size={22} />
					<p>No environmental entities are mapped yet.</p>
				</div>
			) : (
				<div className="environment-ledger">
					{record.mappings.map((mapping) => {
						const reading = record.live_readings.find(
							(item) =>
								item.entity_id === mapping.entity_id && item.role === mapping.role,
						);
						return (
							<article key={mapping.id}>
								<div>
									<span>{environmentalRoleLabels[mapping.role] ?? mapping.role}</span>
									{mapping.display_name && <strong>{mapping.display_name}</strong>}
									<code>{mapping.entity_id}</code>
								</div>
								<div className="environment-ledger__reading">
									<strong>
										{reading
											? valueText(reading.normalized_value, reading.normalized_unit)
											: "Awaiting state"}
									</strong>
									<Badge
										tone={reading?.available && !reading.stale ? "healthy" : "attention"}
									>
										{!reading?.available
											? "Unavailable"
											: reading.stale
												? "Stale"
												: mapping.compatibility}
									</Badge>
								</div>
							</article>
						);
					})}
				</div>
			)}
		</section>
	);
}

function PlannedCapabilities() {
	return (
		<section className="capability-section planned-capabilities">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Independent attachments</p>
					<h2>Additional capabilities</h2>
				</div>
				<Leaf size={20} />
			</div>
			<div className="planned-capability-grid">
				<Card><Power size={20} /><Badge tone="neutral">Planned</Badge><h3>Equipment</h3><p>Equipment can be attached after setup. Control will use approved Home Assistant scripts and safety interlocks.</p></Card>
				<Card><Target size={20} /><Badge tone="neutral">Planned</Badge><h3>Targets and schedules</h3><p>Environmental targets and lifecycle schedules attach independently.</p></Card>
				<Card><Droplets size={20} /><Badge tone="neutral">Planned</Badge><h3>Reservoirs</h3><p>Reservoir and irrigation records remain independent.</p></Card>
				<Card><Gauge size={20} /><Badge tone="neutral">Planned</Badge><h3>Safety policy</h3><p>Physical actions remain subordinate to Home Assistant authority and interlocks.</p></Card>
			</div>
		</section>
	);
}

export function GrowSpaceDetailContent({ growSpaceId }: { growSpaceId: string }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<GrowSpaceDetailsDraft | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const errorRef = useRef<HTMLDivElement>(null);
	const space = useGrowSpace(growSpaceId);
	const update = useUpdateGrowSpace();

	useEffect(() => {
		if (validationError || update.error) errorRef.current?.focus();
	}, [validationError, update.error]);

	if (space.isLoading) {
		return <div className="detail-register-skeleton" aria-label="Loading grow space" />;
	}
	if (space.isError || !space.data) {
		return (
			<section className="state-register" role="alert">
				<p className="eyebrow">Record unavailable</p>
				<h1>Grow space could not be loaded</h1>
				<p>{space.error?.message ?? "This grow-space record does not exist."}</p>
				<Button variant="secondary" onClick={() => space.refetch()}>Retry</Button>
			</section>
		);
	}

	const record = space.data;
	const legacyType = !(record.space_type in growSpaceTypeLabels);
	const measurement = dimensionsText(record);

	function beginEditing() {
		setDraft(detailsDraft(record));
		setValidationError(null);
		setEditing(true);
	}

	async function saveChanges() {
		if (!draft) return;
		const input = buildUpdateInput(record, draft);
		const geometryIsRequired =
		record.dimensions !== null || input.dimensions !== undefined || input.space_type !== undefined;
		const error = geometryIsRequired
			? validateGrowSpaceDetails(draft)
			: draft.name.trim()
				? null
				: "Name is required.";
		if (error) {
			setValidationError(error);
			return;
		}
		setValidationError(null);
		try {
			await update.mutateAsync({ growSpaceId: record.id, input });
			setEditing(false);
			setDraft(null);
		} catch {
			// Mutation state renders and focuses the stable error summary.
		}
	}

	return (
		<div className="page-stack grow-space-detail">
			<button className="detail-back-link" type="button" onClick={() => { window.location.hash = "/grow-spaces"; }}>
				<ArrowLeft size={15} /> Grow-space register
			</button>

			<section className="detail-ledger-heading">
				<div>
					<p className="eyebrow">Premises record · {growSpaceTypeLabels[record.space_type] ?? record.space_type.replaceAll("_", " ")}</p>
					<h1>{record.name}</h1>
					<p>{record.description || "No description has been filed for this space."}</p>
				</div>
				<div className="detail-heading-actions">
					{legacyType && <Badge tone="attention">Legacy type</Badge>}
					<Badge tone={record.active ? "healthy" : "neutral"}>{record.active ? "Active" : "Inactive"}</Badge>
					<Button variant="secondary" onClick={beginEditing}><Pencil size={14} /> Edit details</Button>
				</div>
			</section>

			{editing && draft && (
				<section className="capability-section detail-editor" aria-labelledby="edit-details-heading">
					<div className="section-heading-row"><div><p className="eyebrow">Premises amendment</p><h2 id="edit-details-heading">Edit details</h2></div></div>
					{(validationError || update.error) && (
						<div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
							<strong>The changes were not saved.</strong>
							<span>{validationError ?? update.error?.message}</span>
						</div>
					)}
					<div className="detail-editor__form">
						<GrowSpaceDetailsForm mode="edit" value={draft} onChange={setDraft} />
					</div>
					<div className="detail-editor__actions">
						<Button variant="ghost" onClick={() => setEditing(false)}>Discard</Button>
						<Button disabled={update.isPending} onClick={saveChanges}>{update.isPending ? "Saving…" : "Save changes"}</Button>
					</div>
				</section>
			)}

			{measurement && <p className="detail-dimensions-record">{measurement}</p>}
			<div className="detail-meta-grid">
				<Card><span>Location</span><strong>{record.location || "Not recorded"}</strong></Card>
				<Card><span>Area</span><strong>{record.area_m2 === null ? "Not recorded" : `${Number(record.area_m2).toFixed(2)} m²`}</strong></Card>
				<Card><span>Volume</span><strong>{record.volume_m3 === null ? "Volume not available" : `${Number(record.volume_m3).toFixed(2)} m³`}</strong></Card>
				<Card><span>Environmental records</span><strong>{record.mapping_count}</strong></Card>
			</div>

			<EnvironmentalRecords record={record} />
			<PlannedCapabilities />
			<section className="inactive-policy-note">
				<p>Inactive spaces remain in history, retain mappings, and can be reactivated.</p>
			</section>
		</div>
	);
}

export function GrowSpaceDetailPage() {
	const params = useParams({ strict: false }) as { growSpaceId?: string };
	if (!params.growSpaceId) return <section className="state-register"><h1>Grow space not specified</h1></section>;
	return <GrowSpaceDetailContent growSpaceId={params.growSpaceId} />;
}
