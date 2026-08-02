import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
	ApiError,
	type Reservoir,
	type ReservoirLiveReading,
	type ReservoirMapping,
	useCreateReservoirMapping,
	useDeleteReservoirMapping,
	useReservoirEntityCandidates,
} from "../../api/reservoirs";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { reservoirRoleLabels, reservoirRoleOptions } from "./types";

interface ReservoirMappingFieldsProps {
	reservoirId: string;
	reservoir: Reservoir;
}

function readingFor(
	mapping: ReservoirMapping,
	readings: ReservoirLiveReading[],
): ReservoirLiveReading | undefined {
	return readings.find(
		(reading) => reading.entity_id === mapping.entity_id && reading.role === mapping.role,
	);
}

function readingText(reading: ReservoirLiveReading | undefined): string {
	if (!reading) return "Awaiting state";
	if (!reading.available) return "Unavailable";
	if (reading.normalized_value === null) return "No numeric reading";
	const value =
		typeof reading.normalized_value === "boolean"
			? reading.normalized_value
				? "On"
				: "Off"
			: String(reading.normalized_value);
	return reading.normalized_unit ? `${value} ${reading.normalized_unit}` : value;
}

export function ReservoirMappingFields({
	reservoirId,
	reservoir,
}: ReservoirMappingFieldsProps) {
	const roleId = useId();
	const manualId = useId();
	const [selectedRole, setSelectedRole] = useState<string>("level_percentage");
	const [manualEntityId, setManualEntityId] = useState("");
	const candidates = useReservoirEntityCandidates(selectedRole);
	const createMapping = useCreateReservoirMapping(reservoirId);
	const deleteMapping = useDeleteReservoirMapping(reservoirId);

	const mappedKeys = new Set(
		reservoir.mappings.map((mapping) => `${mapping.role}:${mapping.entity_id}`),
	);

	async function addMapping(entityId: string) {
		const key = `${selectedRole}:${entityId}`;
		if (mappedKeys.has(key)) return;
		try {
			await createMapping.mutateAsync({
				entity_id: entityId,
				role: selectedRole,
				priority: 100,
				enabled: true,
			});
		} catch {
			// Mutation state surfaces the error via the toast/banner layer.
		}
	}

	async function addManualEntity() {
		const normalized = manualEntityId.trim().toLowerCase();
		if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(normalized)) return;
		await addMapping(normalized);
		setManualEntityId("");
	}

	const discoveryOffline =
		candidates.error instanceof ApiError && candidates.error.status === 503;
	const errorMessage = createMapping.error?.message ?? deleteMapping.error?.message ?? null;

	return (
		<section className="capability-section">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Capability · Sensor mapping</p>
					<h2>Sensor and equipment mappings</h2>
				</div>
			</div>
			<p className="wizard-intro">
				Map Home Assistant level, leak, pump, valve, flow, and water-temperature
				entities to observe this reservoir. Mapping is read-only observation; Home
				Assistant remains responsible for pump safety and interlocks.
			</p>

			{errorMessage && (
				<div className="error-summary" role="alert">
					<strong>The mapping change was not saved.</strong>
					<span>{errorMessage}</span>
				</div>
			)}

			<div className="mapping-fields">
				<div className="mapping-role-toolbar">
					<div className="form-field">
						<label htmlFor={roleId}>Reservoir role</label>
						<select
							id={roleId}
							value={selectedRole}
							onChange={(event) => setSelectedRole(event.target.value)}
						>
							{reservoirRoleOptions.map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</div>
					<div className="mapping-role-note">
						<strong>{reservoirRoleLabels[selectedRole]}</strong>
						<span>Multiple entities may be filed under this role.</span>
					</div>
				</div>

				<section
					aria-labelledby={`${roleId}-suggestions`}
					className="entity-suggestions"
				>
					<h3 id={`${roleId}-suggestions`}>Compatible Home Assistant entities</h3>
					{candidates.isLoading && <p>Reviewing current entity metadata…</p>}
					{discoveryOffline && (
						<p role="status">
							Home Assistant discovery is unavailable. You can still enter an entity
							ID manually.
						</p>
					)}
					{candidates.data?.length === 0 && !discoveryOffline && (
						<p>No compatible cached entities were found for this role.</p>
					)}
					<div className="entity-suggestion-list">
						{candidates.data?.map((candidate) => {
							const alreadyMapped = mappedKeys.has(
								`${selectedRole}:${candidate.entity_id}`,
							);
							return (
								<article className="entity-suggestion" key={candidate.entity_id}>
									<div>
										<strong>{candidate.friendly_name}</strong>
										<code>{candidate.entity_id}</code>
										<span
											className={`compatibility-label ${candidate.compatibility}`}
										>
											{candidate.compatibility}
											{candidate.source_unit ? ` · ${candidate.source_unit}` : ""}
										</span>
									</div>
									<Button
										variant="secondary"
										disabled={alreadyMapped || createMapping.isPending}
										onClick={() => addMapping(candidate.entity_id)}
									>
										{alreadyMapped ? "Added" : `Use ${candidate.friendly_name}`}
									</Button>
								</article>
							);
						})}
					</div>
				</section>

				<div className="manual-entity-row">
					<div className="form-field">
						<label htmlFor={manualId}>Manual entity ID</label>
						<input
							id={manualId}
							placeholder="sensor.tank_level_percent"
							value={manualEntityId}
							onChange={(event) => setManualEntityId(event.target.value)}
						/>
					</div>
					<Button
						variant="secondary"
						disabled={createMapping.isPending}
						onClick={addManualEntity}
					>
						<Plus size={15} /> Add manual entity
					</Button>
				</div>
			</div>

			<section className="mapping-draft-list" aria-label="Mapped entities">
				{reservoir.mappings.length === 0 ? (
					<div className="capability-empty">
						<p>No entities are mapped yet.</p>
					</div>
				) : (
					reservoir.mappings.map((mapping) => {
						const reading = readingFor(mapping, reservoir.live_readings);
						return (
							<article className="mapping-draft" key={mapping.id}>
								<div>
									<strong>
										{reservoirRoleLabels[mapping.role] ?? mapping.role}
									</strong>
									{mapping.display_name && <span>{mapping.display_name}</span>}
									<code>{mapping.entity_id}</code>
								</div>
								<div className="environment-ledger__reading">
									<strong>{readingText(reading)}</strong>
									<Badge
										tone={
											!reading?.available
												? "attention"
												: reading.stale
													? "attention"
													: "healthy"
										}
									>
										{!reading?.available
											? "Unavailable"
											: reading.stale
												? "Stale"
												: mapping.compatibility}
									</Badge>
								</div>
								<Button
									variant="ghost"
									disabled={deleteMapping.isPending}
									onClick={() => deleteMapping.mutate(mapping.id)}
									aria-label={`Remove ${mapping.entity_id}`}
								>
									<Trash2 size={15} />
								</Button>
							</article>
						);
					})
				)}
			</section>
		</section>
	);
}
