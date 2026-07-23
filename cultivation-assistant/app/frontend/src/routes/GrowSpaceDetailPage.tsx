import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
	Archive,
	ArrowLeft,
	Droplets,
	Gauge,
	Leaf,
	Power,
	Radio,
	Target,
	Thermometer,
} from "lucide-react";
import { useArchiveGrowSpace, useGrowSpace } from "../api/growSpaces";
import { environmentalRoleLabels } from "../features/grow-spaces/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

const typeLabels: Record<string, string> = {
	tent: "Tent",
	room: "Room",
	cabinet: "Cabinet",
	greenhouse: "Greenhouse zone",
	hydroponic_system: "Hydroponic system",
	other: "Other",
};

function valueText(
	value: string | number | boolean | null,
	unit: string | null,
) {
	if (value === null) return "No numeric reading";
	return `${String(value)}${unit ? ` ${unit}` : ""}`;
}

export function GrowSpaceDetailContent({
	growSpaceId,
}: {
	growSpaceId: string;
}) {
	const [confirmArchive, setConfirmArchive] = useState(false);
	const space = useGrowSpace(growSpaceId);
	const archive = useArchiveGrowSpace();

	if (space.isLoading) {
		return (
			<div
				className="detail-register-skeleton"
				aria-label="Loading grow space"
			/>
		);
	}

	if (space.isError || !space.data) {
		return (
			<section className="state-register" role="alert">
				<p className="eyebrow">Record unavailable</p>
				<h1>Grow space could not be loaded</h1>
				<p>
					{space.error?.message ?? "This grow-space record does not exist."}
				</p>
				<Button variant="secondary" onClick={() => space.refetch()}>
					Retry
				</Button>
			</section>
		);
	}

	const record = space.data;

	async function archiveRecord() {
		await archive.mutateAsync(record.id);
		window.location.hash = "/grow-spaces";
	}

	return (
		<div className="page-stack grow-space-detail">
			<button
				className="detail-back-link"
				type="button"
				onClick={() => {
					window.location.hash = "/grow-spaces";
				}}
			>
				<ArrowLeft size={15} /> Grow-space register
			</button>

			<section className="detail-ledger-heading">
				<div>
					<p className="eyebrow">
						Premises record · {typeLabels[record.space_type]}
					</p>
					<h1>{record.name}</h1>
					<p>
						{record.description ||
							"No description has been filed for this space."}
					</p>
				</div>
				<Badge tone={record.active ? "healthy" : "neutral"}>
					{record.active ? "Active" : "Archived"}
				</Badge>
			</section>

			<div className="detail-meta-grid">
				<Card>
					<span>Location</span>
					<strong>{record.location || "Not recorded"}</strong>
				</Card>
				<Card>
					<span>Area</span>
					<strong>
						{record.area_m2 === null
							? "Not recorded"
							: `${Number(record.area_m2).toFixed(2)} m²`}
					</strong>
				</Card>
				<Card>
					<span>Volume</span>
					<strong>
						{record.volume_m3 === null
							? "Not recorded"
							: `${Number(record.volume_m3).toFixed(2)} m³`}
					</strong>
				</Card>
				<Card>
					<span>Environmental records</span>
					<strong>{record.mapping_count}</strong>
				</Card>
			</div>

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
						<p>
							No environmental entities are mapped yet. The space remains valid
							without mappings.
						</p>
					</div>
				) : (
					<div className="environment-ledger">
						{record.mappings.map((mapping) => {
							const reading = record.live_readings.find(
								(item) =>
									item.entity_id === mapping.entity_id &&
									item.role === mapping.role,
							);
							return (
								<article key={mapping.id}>
									<div>
										<span>
											{environmentalRoleLabels[mapping.role] ?? mapping.role}
										</span>
										{mapping.display_name && (
											<strong>{mapping.display_name}</strong>
										)}
										<code>{mapping.entity_id}</code>
									</div>
									<div className="environment-ledger__reading">
										<strong>
											{reading
												? valueText(
														reading.normalized_value,
														reading.normalized_unit,
													)
												: "Awaiting state"}
										</strong>
										<Badge
											tone={
												reading?.available && !reading.stale
													? "healthy"
													: "attention"
											}
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

			<section className="capability-section planned-capabilities">
				<div className="section-heading-row">
					<div>
						<p className="eyebrow">Independent attachments</p>
						<h2>Additional capabilities</h2>
					</div>
					<Leaf size={20} />
				</div>
				<div className="planned-capability-grid">
					<Card>
						<Power size={20} />
						<Badge tone="neutral">Planned</Badge>
						<h3>Equipment</h3>
						<p>
							Equipment can be attached after setup. Control will use approved
							Home Assistant scripts and safety interlocks.
						</p>
					</Card>
					<Card>
						<Target size={20} />
						<Badge tone="neutral">Planned</Badge>
						<h3>Targets and schedules</h3>
						<p>
							Environmental targets and lifecycle schedules will attach without
							changing the premises type.
						</p>
					</Card>
					<Card>
						<Droplets size={20} />
						<Badge tone="neutral">Planned</Badge>
						<h3>Reservoirs</h3>
						<p>
							Reservoir and irrigation records remain independent of
							environmental mappings.
						</p>
					</Card>
					<Card>
						<Gauge size={20} />
						<Badge tone="neutral">Planned</Badge>
						<h3>Safety policy</h3>
						<p>
							Physical actions remain subordinate to Home Assistant authority
							and interlocks.
						</p>
					</Card>
				</div>
			</section>

			{record.active && (
				<section className="archive-register">
					<div>
						<p className="eyebrow">Record lifecycle</p>
						<h2>Archive this grow space</h2>
						<p>
							Archiving hides the space from the active register while
							preserving its history.
						</p>
					</div>
					{confirmArchive ? (
						<div className="archive-confirmation">
							<span>Confirm archival of “{record.name}”?</span>
							<Button
								variant="secondary"
								onClick={() => setConfirmArchive(false)}
							>
								Cancel
							</Button>
							<Button disabled={archive.isPending} onClick={archiveRecord}>
								{archive.isPending ? "Archiving…" : "Confirm archive"}
							</Button>
						</div>
					) : (
						<Button variant="secondary" onClick={() => setConfirmArchive(true)}>
							<Archive size={15} /> Archive space
						</Button>
					)}
					{archive.isError && <p role="alert">{archive.error.message}</p>}
				</section>
			)}
		</div>
	);
}

export function GrowSpaceDetailPage() {
	const params = useParams({ strict: false }) as { growSpaceId?: string };
	if (!params.growSpaceId) {
		return (
			<section className="state-register">
				<h1>Grow space not specified</h1>
			</section>
		);
	}
	return <GrowSpaceDetailContent growSpaceId={params.growSpaceId} />;
}
