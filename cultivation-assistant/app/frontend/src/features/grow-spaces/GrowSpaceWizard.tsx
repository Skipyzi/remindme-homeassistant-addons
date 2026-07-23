import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useCreateGrowSpace } from "../../api/growSpaces";
import { Button } from "../../components/ui/Button";
import { calculateDimensionPreview } from "./dimensions";
import { EntityMappingFields } from "./EntityMappingFields";
import { GrowSpaceDetailsForm } from "./GrowSpaceDetailsForm";
import {
	draftToCreateInput,
	environmentalRoleLabels,
	emptyGrowSpaceDraft,
	growSpaceTypeLabels,
	validateGrowSpaceDetails,
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
		const detailsError = validateGrowSpaceDetails(draft);
		if (detailsError) {
			setValidationError(detailsError);
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
	const dimensionPreview = calculateDimensionPreview({
		length: draft.length,
		width: draft.width,
		height: draft.height,
		unit: draft.dimensionUnit,
	});

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
							<GrowSpaceDetailsForm
								mode="create"
								value={draft}
								onChange={(details) =>
									updateDraft({
										...details,
										spaceType: details.spaceType as GrowSpaceDraft["spaceType"],
									})
								}
							/>
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
									<strong>{growSpaceTypeLabels[draft.spaceType]}</strong>
								</div>
								<div>
									<span>Location</span>
									<strong>{draft.location || "Not recorded"}</strong>
								</div>
								<div>
									<span>Dimensions</span>
									<strong>
										{[draft.length, draft.width, draft.height]
											.filter(Boolean)
											.join(" × ")} {draft.dimensionUnit}
									</strong>
								</div>
								<div>
									<span>Floor area</span>
									<strong>{dimensionPreview?.areaM2 ?? "—"} m²</strong>
								</div>
								<div>
									<span>Volume</span>
									<strong>
										{dimensionPreview?.volumeM3
											? `${dimensionPreview.volumeM3} m³`
											: "Volume not available"}
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
