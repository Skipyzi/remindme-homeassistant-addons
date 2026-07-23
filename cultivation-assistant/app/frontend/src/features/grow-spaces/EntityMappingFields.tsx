import { useId, useState } from "react";
import {
	ApiError,
	type EntityMappingInput,
	useEntityCandidates,
} from "../../api/growSpaces";
import { Button } from "../../components/ui/Button";
import { environmentalRoleLabels, environmentalRoleOptions } from "./types";

interface EntityMappingFieldsProps {
	mappings: EntityMappingInput[];
	onChange: (mappings: EntityMappingInput[]) => void;
}

export function EntityMappingFields({
	mappings,
	onChange,
}: EntityMappingFieldsProps) {
	const roleId = useId();
	const manualId = useId();
	const [selectedRole, setSelectedRole] = useState<string>("air_temperature");
	const [manualEntityId, setManualEntityId] = useState("");
	const candidates = useEntityCandidates(selectedRole);
	const mappedKeys = new Set(
		mappings.map((mapping) => `${mapping.role}:${mapping.entity_id}`),
	);

	function addMapping(entityId: string) {
		const key = `${selectedRole}:${entityId}`;
		if (mappedKeys.has(key)) return;
		onChange([
			...mappings,
			{
				entity_id: entityId,
				role: selectedRole,
				priority: 100,
				enabled: true,
			},
		]);
	}

	function removeMapping(index: number) {
		onChange(
			mappings.filter((_mapping, mappingIndex) => mappingIndex !== index),
		);
	}

	function updateMapping(index: number, patch: Partial<EntityMappingInput>) {
		onChange(
			mappings.map((mapping, mappingIndex) =>
				mappingIndex === index ? { ...mapping, ...patch } : mapping,
			),
		);
	}

	function addManualEntity() {
		const normalized = manualEntityId.trim().toLowerCase();
		if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(normalized)) return;
		addMapping(normalized);
		setManualEntityId("");
	}

	const discoveryOffline =
		candidates.error instanceof ApiError && candidates.error.status === 503;

	return (
		<div className="mapping-fields">
			<div className="mapping-role-toolbar">
				<div className="form-field">
					<label htmlFor={roleId}>Environmental role</label>
					<select
						id={roleId}
						value={selectedRole}
						onChange={(event) => setSelectedRole(event.target.value)}
					>
						{environmentalRoleOptions.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
				<div className="mapping-role-note">
					<strong>{environmentalRoleLabels[selectedRole]}</strong>
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
						Home Assistant discovery is unavailable. You can still enter an
						entity ID manually.
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
									disabled={alreadyMapped}
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
						placeholder="sensor.north_tent_temperature"
						value={manualEntityId}
						onChange={(event) => setManualEntityId(event.target.value)}
					/>
				</div>
				<Button variant="secondary" onClick={addManualEntity}>
					Add manual entity
				</Button>
			</div>

			<section className="mapping-draft-list" aria-label="Selected mappings">
				{mappings.map((mapping, index) => (
					<article
						className="mapping-draft"
						key={`${mapping.role}:${mapping.entity_id}`}
					>
						<div>
							<strong>
								{environmentalRoleLabels[mapping.role] ?? mapping.role}
							</strong>
							<code>{mapping.entity_id}</code>
						</div>
						<label>
							Priority
							<input
								type="number"
								min="0"
								value={mapping.priority ?? 100}
								onChange={(event) =>
									updateMapping(index, { priority: Number(event.target.value) })
								}
							/>
						</label>
						<Button variant="ghost" onClick={() => removeMapping(index)}>
							Remove {mapping.entity_id}
						</Button>
					</article>
				))}
			</section>
		</div>
	);
}
