import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import type { LifecycleStage } from "../../api/lifecycle";
import { Button } from "../../components/ui/Button";

export interface LifecycleStageSettingsProps {
	stages: LifecycleStage[];
	onReorder: (stageIds: string[]) => void;
	onRename: (stageId: string, label: string) => void;
	onToggle: (stageId: string, enabled: boolean) => void;
	onCreate: (input: { key: string; label: string }) => void;
	onDelete: (stageId: string) => void;
}

function move(ids: string[], index: number, delta: number): string[] {
	const next = [...ids];
	const target = index + delta;
	if (target < 0 || target >= next.length) return next;
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

export function LifecycleStageSettings({
	stages,
	onReorder,
	onRename,
	onToggle,
	onCreate,
	onDelete,
}: LifecycleStageSettingsProps) {
	const [newKey, setNewKey] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const ids = stages.map((stage) => stage.id);

	return (
		<section className="lifecycle-settings" aria-label="Lifecycle stages">
			<p className="lifecycle-settings__note">
				Rename, reorder, disable, or add lifecycle stages. Disabling a stage
				removes it from new transitions, but existing history is preserved.
			</p>

			<ol className="lifecycle-stage-list">
				{stages.map((stage, index) => (
					<li key={stage.id} className="lifecycle-stage-row">
						<div className="lifecycle-stage-row__reorder">
							<button
								type="button"
								aria-label={`Move ${stage.label} up`}
								disabled={index === 0}
								onClick={() => onReorder(move(ids, index, -1))}
							>
								<ChevronUp size={15} />
							</button>
							<button
								type="button"
								aria-label={`Move ${stage.label} down`}
								disabled={index === stages.length - 1}
								onClick={() => onReorder(move(ids, index, 1))}
							>
								<ChevronDown size={15} />
							</button>
						</div>
						<label className="field lifecycle-stage-row__label">
							<span className="sr-only">{`Label for ${stage.key}`}</span>
							<input
								defaultValue={stage.label}
								onBlur={(event) => {
									if (event.target.value.trim() !== stage.label) {
										onRename(stage.id, event.target.value.trim());
									}
								}}
							/>
						</label>
						<label className="lifecycle-stage-row__enabled">
							<input
								type="checkbox"
								checked={stage.enabled}
								onChange={(event) => onToggle(stage.id, event.target.checked)}
							/>
							<span>{stage.enabled ? "Enabled" : "Disabled"}</span>
						</label>
						{!stage.built_in && (
							<button
								type="button"
								className="lifecycle-stage-row__delete"
								aria-label={`Delete ${stage.label}`}
								onClick={() => onDelete(stage.id)}
							>
								<Trash2 size={15} />
							</button>
						)}
					</li>
				))}
			</ol>

			<div className="lifecycle-stage-create">
				<label className="field">
					<span>New stage key</span>
					<input
						value={newKey}
						onChange={(event) =>
							setNewKey(event.target.value.toLowerCase().replaceAll(/\s+/g, "_"))
						}
						placeholder="mothering"
					/>
				</label>
				<label className="field">
					<span>New stage label</span>
					<input
						value={newLabel}
						onChange={(event) => setNewLabel(event.target.value)}
						placeholder="Mothering"
					/>
				</label>
				<Button
					type="button"
					size="sm"
					disabled={!newKey.trim() || !newLabel.trim()}
					onClick={() => {
						onCreate({ key: newKey.trim(), label: newLabel.trim() });
						setNewKey("");
						setNewLabel("");
					}}
				>
					<Plus size={14} /> Add stage
				</Button>
			</div>
		</section>
	);
}
