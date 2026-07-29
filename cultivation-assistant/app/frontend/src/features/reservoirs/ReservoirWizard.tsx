import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useCreateReservoir } from "../../api/reservoirs";
import { Button } from "../../components/ui/Button";
import { ReservoirDetailsForm } from "./ReservoirDetailsForm";
import { ReservoirGeometryForm } from "./ReservoirGeometryForm";
import {
	calculateGeometryPreview,
	type GeometryDraft,
} from "./geometry";
import {
	draftToCreateInput,
	emptyReservoirDraft,
	geometryShapeLabels,
	reservoirTypeLabels,
	validateReservoirDetails,
	validateReservoirGeometry,
	type ReservoirDraft,
	type WizardStep,
} from "./types";

interface ReservoirWizardProps {
	open: boolean;
	onClose: () => void;
	onCreated: (reservoirId: string) => void;
}

const steps: Array<{ key: WizardStep; label: string }> = [
	{ key: "details", label: "Reservoir details" },
	{ key: "geometry", label: "Tank geometry" },
	{ key: "review", label: "Review and create" },
];

function geometrySummary(draft: ReservoirDraft): string {
	const { geometry } = draft;
	if (geometry.shape === "custom_calibration_table") {
		return "Custom calibration table";
	}
	const parts: string[] = [];
	if (geometry.length.trim()) parts.push(`L ${geometry.length}`);
	if (geometry.width.trim()) parts.push(`W ${geometry.width}`);
	if (geometry.height.trim()) parts.push(`H ${geometry.height}`);
	if (geometry.diameter.trim()) parts.push(`Ø ${geometry.diameter}`);
	return parts.length > 0 ? `${parts.join(" · ")} ${geometry.unit}` : "—";
}

export function ReservoirWizard({ open, onClose, onCreated }: ReservoirWizardProps) {
	const [step, setStep] = useState<WizardStep>("details");
	const [draft, setDraft] = useState<ReservoirDraft>(emptyReservoirDraft);
	const [validationError, setValidationError] = useState<string | null>(null);
	const createMutation = useCreateReservoir();
	const errorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (validationError || createMutation.error) errorRef.current?.focus();
	}, [validationError, createMutation.error]);

	if (!open) return null;

	function updateDraft(patch: Partial<ReservoirDraft>) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function continueToGeometry() {
		const detailsError = validateReservoirDetails(draft);
		if (detailsError) {
			setValidationError(detailsError);
			return;
		}
		setValidationError(null);
		setStep("geometry");
	}

	async function submit() {
		setValidationError(null);
		try {
			const reservoir = await createMutation.mutateAsync(draftToCreateInput(draft));
			onCreated(reservoir.id);
			onClose();
		} catch {
			// Mutation state renders and focuses the stable error summary.
		}
	}

	const errorMessage = validationError ?? createMutation.error?.message ?? null;
	const stepIndex = steps.findIndex((item) => item.key === step);
	const preview = calculateGeometryPreview(draft.geometry as GeometryDraft);

	return (
		<div className="wizard-backdrop">
			<section
				aria-labelledby="reservoir-wizard-title"
				aria-modal="true"
				className="grow-space-wizard"
				role="dialog"
			>
				<header className="wizard-header">
					<div>
						<p className="eyebrow">Tank intake · New reservoir</p>
						<h2 id="reservoir-wizard-title">Establish a reservoir</h2>
					</div>
					<Button
						aria-label="Close reservoir wizard"
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
					<div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
						<strong>The reservoir was not filed.</strong>
						<span>{errorMessage}</span>
					</div>
				)}

				<div className="wizard-body">
					{step === "details" && (
						<section aria-labelledby="reservoir-details-heading">
							<p className="eyebrow">Step 1 · Tank record</p>
							<h3 id="reservoir-details-heading">Record the reservoir</h3>
							<p className="wizard-intro">
								Name the tank and record its capacity. Sensor mapping, forecasts,
								and irrigation remain independent attachments.
							</p>
							<ReservoirDetailsForm
								mode="create"
								value={draft}
								onChange={updateDraft}
							/>
						</section>
					)}

					{step === "geometry" && (
						<section aria-labelledby="geometry-heading">
							<p className="eyebrow">Step 2 · Tank geometry</p>
							<h3 id="geometry-heading">Define the tank shape</h3>
							<p className="wizard-intro">
								Choose a shape and enter its dimensions, or use a custom
								calibration table for raw sensor readings.
							</p>
							<ReservoirGeometryForm value={draft} onChange={updateDraft} />
						</section>
					)}

					{step === "review" && (
						<section aria-labelledby="review-heading">
							<p className="eyebrow">Step 3 · Determination</p>
							<h3 id="review-heading">Review the reservoir record</h3>
							<div className="wizard-review">
								<div>
									<span>Name</span>
									<strong>{draft.name}</strong>
								</div>
								<div>
									<span>Type</span>
									<strong>{reservoirTypeLabels[draft.reservoirType]}</strong>
								</div>
								<div>
									<span>Capacity</span>
									<strong>
										{draft.capacityLiters.trim()
											? `${draft.capacityLiters.trim()} L`
											: "—"}
									</strong>
								</div>
								<div>
									<span>Geometry</span>
									<strong>
										{geometryShapeLabels[draft.geometry.shape]} ·{" "}
										{geometrySummary(draft)}
									</strong>
								</div>
								{draft.geometry.shape !== "custom_calibration_table" && (
									<div>
										<span>Estimated volume</span>
										<strong>
											{preview ? `${preview.volumeLiters} L` : "Awaiting dimensions"}
										</strong>
									</div>
								)}
								<div>
									<span>Usable capacity</span>
									<strong>
										{draft.usableCapacityLiters.trim()
											? `${draft.usableCapacityLiters.trim()} L`
											: "Same as capacity"}
									</strong>
								</div>
							</div>
						</section>
					)}
				</div>

				<footer className="wizard-footer">
					{step === "details" && (
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button onClick={continueToGeometry}>
								Continue to geometry <ArrowRight size={15} />
							</Button>
						</>
					)}
					{step === "geometry" && (
						<>
							<Button variant="ghost" onClick={() => setStep("details")}>
								<ArrowLeft size={15} /> Back to details
							</Button>
							<Button
								onClick={() => {
									const error = validateReservoirGeometry(draft);
									if (error) {
										setValidationError(error);
										return;
									}
									setValidationError(null);
									setStep("review");
								}}
							>
								Review reservoir <ArrowRight size={15} />
							</Button>
						</>
					)}
					{step === "review" && (
						<>
							<Button variant="ghost" onClick={() => setStep("geometry")}>
								<ArrowLeft size={15} /> Back to geometry
							</Button>
							<Button disabled={createMutation.isPending} onClick={submit}>
								{createMutation.isPending ? "Creating…" : "Create reservoir"}
							</Button>
						</>
					)}
				</footer>
			</section>
		</div>
	);
}
