import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useCreateGrowSpace } from "../../api/growSpaces";
import { Button } from "../../components/ui/Button";
import { EntityMappingFields } from "./EntityMappingFields";
import {
	draftToCreateInput,
	environmentalRoleLabels,
	emptyGrowSpaceDraft,
	type GrowSpaceDraft,
	type WizardStep,
} from "./types";

interface GrowSpaceWizardProps {
	open: boolean;
	onClose: () => void;
	onCreated: (growSpaceId: string) => void;
}

const steps: Array<{ key: WizardStep; label: string }> = [
	{ key: "details", label: "Space details" },
	{ key: "mappings", label: "Environmental records" },
	{ key: "review", label: "Review and create" },
];

export function GrowSpaceWizard({
	open,
	onClose,
	onCreated,
}: GrowSpaceWizardProps) {
	const [step, setStep] = useState<WizardStep>("details");
	const [draft, setDraft] = useState<GrowSpaceDraft>(emptyGrowSpaceDraft);
	const [validationError, setValidationError] = useState<string | null>(null);
	const createMutation = useCreateGrowSpace();
	const errorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (validationError || createMutation.error) errorRef.current?.focus();
	}, [validationError, createMutation.error]);

	if (!open) return null;

	function updateDraft(patch: Partial<GrowSpaceDraft>) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function continueToMappings() {
		if (!draft.name.trim()) {
			setValidationError("Name is required before continuing.");
			return;
		}
		setValidationError(null);
		setStep("mappings");
	}

	async function submit() {
		setValidationError(null);
		try {
			const growSpace = await createMutation.mutateAsync(
				draftToCreateInput(draft),
			);
			onCreated(growSpace.id);
			onClose();
		} catch {
			// Mutation state renders and focuses the stable error summary.
		}
	}

	const errorMessage = validationError ?? createMutation.error?.message ?? null;
	const stepIndex = steps.findIndex((item) => item.key === step);

	return (
		<div className="wizard-backdrop">
			<section
				aria-labelledby="grow-space-wizard-title"
				aria-modal="true"
				className="grow-space-wizard"
				role="dialog"
			>
				<header className="wizard-header">
					<div>
						<p className="eyebrow">Premises intake · New cultivation area</p>
						<h2 id="grow-space-wizard-title">Establish a grow space</h2>
					</div>
					<Button
						aria-label="Close grow-space wizard"
						size="icon"
						variant="ghost"
						onClick={onClose}
					>
						<X size={18} />
					</Button>
				</header>

				<ol className="wizard-steps" aria-label="Setup progress">
					{steps.map((item, index) => {
						const current = item.key === step;
						const complete = index < stepIndex;
						return (
							<li
								aria-current={current ? "step" : undefined}
								className={current ? "current" : complete ? "complete" : ""}
								key={item.key}
							>
								<span>{complete ? <Check size={13} /> : index + 1}</span>
								{item.label}
							</li>
						);
					})}
				</ol>

				{errorMessage && (
					<div
						className="error-summary"
						ref={errorRef}
						role="alert"
						tabIndex={-1}
					>
						<strong>The grow space was not filed.</strong>
						<span>{errorMessage}</span>
					</div>
				)}

				<div className="wizard-body">
					{step === "details" && (
						<section aria-labelledby="space-details-heading">
							<p className="eyebrow">Step 1 · Premises record</p>
							<h3 id="space-details-heading">Record the space</h3>
							<p className="wizard-intro">
								Describe the physical area first. Sensors and equipment remain
								independent attachments.
							</p>
							<div className="wizard-form-grid">
								<label className="form-field span-two">
									<span>Name · required</span>
									<input
										autoFocus
										value={draft.name}
										onChange={(event) =>
											updateDraft({ name: event.target.value })
										}
									/>
								</label>
								<label className="form-field">
									<span>Space type</span>
									<select
										value={draft.spaceType}
										onChange={(event) =>
											updateDraft({
												spaceType: event.target
													.value as GrowSpaceDraft["spaceType"],
											})
										}
									>
										<option value="tent">Indoor tent</option>
										<option value="room">Room</option>
										<option value="cabinet">Cabinet</option>
										<option value="greenhouse">Greenhouse zone</option>
										<option value="hydroponic_system">Hydroponic system</option>
										<option value="other">Other</option>
									</select>
								</label>
								<label className="form-field">
									<span>Location</span>
									<input
										placeholder="Basement · north wall"
										value={draft.location}
										onChange={(event) =>
											updateDraft({ location: event.target.value })
										}
									/>
								</label>
								<label className="form-field span-two">
									<span>Description</span>
									<textarea
										rows={3}
										value={draft.description}
										onChange={(event) =>
											updateDraft({ description: event.target.value })
										}
									/>
								</label>
								<div className="dimension-field">
									<label className="form-field">
										<span>Area</span>
										<input
											inputMode="decimal"
											value={draft.areaValue}
											onChange={(event) =>
												updateDraft({ areaValue: event.target.value })
											}
										/>
									</label>
									<select
										aria-label="Area unit"
										value={draft.areaUnit}
										onChange={(event) =>
											updateDraft({
												areaUnit: event.target.value as "m²" | "ft²",
											})
										}
									>
										<option value="m²">m²</option>
										<option value="ft²">ft²</option>
									</select>
								</div>
								<div className="dimension-field">
									<label className="form-field">
										<span>Volume</span>
										<input
											inputMode="decimal"
											value={draft.volumeValue}
											onChange={(event) =>
												updateDraft({ volumeValue: event.target.value })
											}
										/>
									</label>
									<select
										aria-label="Volume unit"
										value={draft.volumeUnit}
										onChange={(event) =>
											updateDraft({
												volumeUnit: event.target.value as "m³" | "ft³",
											})
										}
									>
										<option value="m³">m³</option>
										<option value="ft³">ft³</option>
									</select>
								</div>
							</div>
						</section>
					)}

					{step === "mappings" && (
						<section aria-labelledby="mapping-heading">
							<p className="eyebrow">Step 2 · Environmental records</p>
							<h3 id="mapping-heading">Map sensors to {draft.name}</h3>
							<p className="wizard-intro">
								This step is optional. Equipment such as lights and fans is
								added after the space exists.
							</p>
							<EntityMappingFields
								mappings={draft.mappings}
								onChange={(mappings) => updateDraft({ mappings })}
							/>
						</section>
					)}

					{step === "review" && (
						<section aria-labelledby="review-heading">
							<p className="eyebrow">Step 3 · Determination</p>
							<h3 id="review-heading">Review the premises record</h3>
							<div className="wizard-review">
								<div>
									<span>Name</span>
									<strong>{draft.name}</strong>
								</div>
								<div>
									<span>Type</span>
									<strong>{draft.spaceType.replaceAll("_", " ")}</strong>
								</div>
								<div>
									<span>Location</span>
									<strong>{draft.location || "Not recorded"}</strong>
								</div>
								<div>
									<span>Area</span>
									<strong>
										{draft.areaValue
											? `${draft.areaValue} ${draft.areaUnit}`
											: "Not recorded"}
									</strong>
								</div>
								<div>
									<span>Volume</span>
									<strong>
										{draft.volumeValue
											? `${draft.volumeValue} ${draft.volumeUnit}`
											: "Not recorded"}
									</strong>
								</div>
								<div>
									<span>Environmental mappings</span>
									<strong>{draft.mappings.length}</strong>
								</div>
							</div>
							{draft.mappings.length > 0 && (
								<ul className="review-mapping-list">
									{draft.mappings.map((mapping) => (
										<li key={`${mapping.role}:${mapping.entity_id}`}>
											<span>
												{environmentalRoleLabels[mapping.role] ?? mapping.role}
											</span>
											<code>{mapping.entity_id}</code>
										</li>
									))}
								</ul>
							)}
						</section>
					)}
				</div>

				<footer className="wizard-footer">
					{step === "details" && (
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button onClick={continueToMappings}>
								Continue to mappings <ArrowRight size={15} />
							</Button>
						</>
					)}
					{step === "mappings" && (
						<>
							<Button variant="ghost" onClick={() => setStep("details")}>
								<ArrowLeft size={15} /> Back to details
							</Button>
							<Button onClick={() => setStep("review")}>
								Review grow space <ArrowRight size={15} />
							</Button>
						</>
					)}
					{step === "review" && (
						<>
							<Button variant="ghost" onClick={() => setStep("mappings")}>
								<ArrowLeft size={15} /> Back to mappings
							</Button>
							<Button disabled={createMutation.isPending} onClick={submit}>
								{createMutation.isPending ? "Creating…" : "Create grow space"}
							</Button>
						</>
					)}
				</footer>
			</section>
		</div>
	);
}
