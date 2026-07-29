import { useState } from "react";
import { ArrowRight, CircleDot, Droplets, Plus, Ruler } from "lucide-react";
import { useReservoirs, type ReservoirSummary } from "../api/reservoirs";
import { ReservoirWizard } from "../features/reservoirs/ReservoirWizard";
import {
	geometryShapeLabels,
	reservoirTypeLabels,
} from "../features/reservoirs/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

function geometrySummary(reservoir: ReservoirSummary): string {
	const { geometry } = reservoir;
	if (geometry.shape === "custom_calibration_table") {
		return "Calibration table";
	}
	const parts: string[] = [];
	if (geometry.length !== null) parts.push(`L ${geometry.length}`);
	if (geometry.width !== null) parts.push(`W ${geometry.width}`);
	if (geometry.height !== null) parts.push(`H ${geometry.height}`);
	if (geometry.diameter !== null) parts.push(`Ø ${geometry.diameter}`);
	const unitLabel = geometry.unit ? ` ${geometry.unit}` : "";
	return parts.length > 0 ? `${parts.join(" · ")}${unitLabel}` : "—";
}

export function ReservoirsPage() {
	const [includeArchived, setIncludeArchived] = useState(false);
	const [wizardOpen, setWizardOpen] = useState(false);
	const reservoirs = useReservoirs(includeArchived);

	function openCreatedReservoir(reservoirId: string) {
		setWizardOpen(false);
		window.location.hash = `/reservoirs/${reservoirId}`;
	}

	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Tanks & reservoir records</p>
					<h1>Reservoirs</h1>
					<p>
						Record each nutrient, mixing, top-off, supply, or waste tank. Sensor
						mapping, consumption forecasts, and irrigation events attach as separate
						capabilities.
					</p>
				</div>
				<Button onClick={() => setWizardOpen(true)}>
					<Plus size={17} /> New reservoir
				</Button>
			</section>

			<div className="space-list-controls">
				<label>
					<input
						checked={includeArchived}
						type="checkbox"
						onChange={(event) => setIncludeArchived(event.target.checked)}
					/>
					Include inactive reservoirs
				</label>
			</div>

			{reservoirs.isLoading && (
				<div className="space-grid" aria-label="Loading reservoirs">
					<div className="space-card-skeleton" />
					<div className="space-card-skeleton" />
				</div>
			)}

			{reservoirs.isError && (
				<section className="state-register" role="alert">
					<p className="eyebrow">Register unavailable</p>
					<h2>Reservoirs could not be loaded</h2>
					<p>{reservoirs.error.message}</p>
					<Button variant="secondary" onClick={() => reservoirs.refetch()}>
						Retry loading reservoirs
					</Button>
				</section>
			)}

			{reservoirs.data?.length === 0 && (
				<section className="state-register empty-space-register">
					<div className="space-orbit space-orbit--sky">
						<Droplets size={27} />
					</div>
					<p className="eyebrow">No tank records</p>
					<h2>Create your first reservoir</h2>
					<p>
						Start with a mixing tank, AutoPot reservoir, DWC bucket, or any custom
						tank. Geometry and calibration are optional during setup.
					</p>
					<Button onClick={() => setWizardOpen(true)}>
						<Plus size={16} /> Create reservoir
					</Button>
				</section>
			)}

			{reservoirs.data && reservoirs.data.length > 0 && (
				<div className="space-grid">
					{reservoirs.data.map((reservoir, index) => {
						const dimensions = geometrySummary(reservoir);
						return (
							<Card className="space-card" key={reservoir.id}>
								<div className="space-card__image">
									<div
										className={`space-orbit ${index % 2 === 0 ? "space-orbit--sky" : "space-orbit--sage"}`}
									>
										<Droplets size={26} />
									</div>
									<div className="space-card__badges">
										<Badge tone={reservoir.active ? "healthy" : "neutral"}>
											<CircleDot size={10} />{" "}
											{reservoir.active ? "Active" : "Inactive"}
										</Badge>
									</div>
								</div>
								<div className="space-card__body">
									<h2>{reservoir.name}</h2>
									<p>
										{reservoirTypeLabels[reservoir.reservoir_type] ??
											reservoir.reservoir_type.replaceAll("_", " ")}
									</p>
									{dimensions !== "—" && (
										<p className="space-card__dimensions">
											<Ruler size={13} /> {dimensions}
										</p>
									)}
									<div className="space-stats">
										<span>
											<Droplets size={15} />
											{Number(reservoir.capacity_liters)} L capacity
										</span>
										<span>
											{geometryShapeLabels[reservoir.geometry.shape] ??
												reservoir.geometry.shape.replaceAll("_", " ")}
										</span>
									</div>
									<button
										type="button"
										onClick={() => {
											window.location.hash = `/reservoirs/${reservoir.id}`;
										}}
									>
										Manage reservoir <ArrowRight size={14} />
									</button>
								</div>
							</Card>
						);
					})}
					<button className="new-space-card" onClick={() => setWizardOpen(true)}>
						<span>
							<Plus size={20} />
						</span>
						<strong>Create another reservoir</strong>
						<small>Define geometry and calibration after creation</small>
					</button>
				</div>
			)}

			<ReservoirWizard
				open={wizardOpen}
				onClose={() => setWizardOpen(false)}
				onCreated={openCreatedReservoir}
			/>
		</div>
	);
}
