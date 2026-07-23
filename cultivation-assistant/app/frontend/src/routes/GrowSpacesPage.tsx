import { useState } from "react";
import {
	ArrowRight,
	Boxes,
	CircleDot,
	Plus,
	Thermometer,
	Wifi,
} from "lucide-react";
import { useGrowSpaces, type GrowSpaceSummary } from "../api/growSpaces";
import { GrowSpaceWizard } from "../features/grow-spaces/GrowSpaceWizard";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

const typeLabels: Record<string, string> = {
	tent: "Indoor tent",
	room: "Room",
	cabinet: "Cabinet",
	greenhouse: "Greenhouse zone",
	hydroponic_system: "Hydroponic system",
	other: "Other",
};

function dimensionSummary(space: GrowSpaceSummary) {
	const dimensions: string[] = [];
	if (space.area_m2 !== null)
		dimensions.push(`${Number(space.area_m2).toFixed(2)} m²`);
	if (space.volume_m3 !== null)
		dimensions.push(`${Number(space.volume_m3).toFixed(2)} m³`);
	return dimensions.join(" · ");
}

function airTemperature(space: GrowSpaceSummary) {
	return space.live_readings.find(
		(reading) =>
			reading.role === "air_temperature" && reading.available && !reading.stale,
	);
}

export function GrowSpacesPage() {
	const [includeArchived, setIncludeArchived] = useState(false);
	const [wizardOpen, setWizardOpen] = useState(false);
	const spaces = useGrowSpaces(includeArchived);

	function openCreatedSpace(growSpaceId: string) {
		setWizardOpen(false);
		window.location.hash = `/grow-spaces/${growSpaceId}`;
	}

	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Spaces & environmental records</p>
					<h1>Grow spaces</h1>
					<p>
						Create each physical cultivation area first, then attach sensors,
						equipment, targets, and reservoirs as separate capabilities.
					</p>
				</div>
				<Button onClick={() => setWizardOpen(true)}>
					<Plus size={17} /> New grow space
				</Button>
			</section>

			<div className="space-list-controls">
				<label>
					<input
						checked={includeArchived}
						type="checkbox"
						onChange={(event) => setIncludeArchived(event.target.checked)}
					/>
					Include archived spaces
				</label>
			</div>

			{spaces.isLoading && (
				<div className="space-grid" aria-label="Loading grow spaces">
					<div className="space-card-skeleton" />
					<div className="space-card-skeleton" />
				</div>
			)}

			{spaces.isError && (
				<section className="state-register" role="alert">
					<p className="eyebrow">Register unavailable</p>
					<h2>Grow spaces could not be loaded</h2>
					<p>{spaces.error.message}</p>
					<Button variant="secondary" onClick={() => spaces.refetch()}>
						Retry loading grow spaces
					</Button>
				</section>
			)}

			{spaces.data?.items.length === 0 && (
				<section className="state-register empty-space-register">
					<div className="space-orbit space-orbit--sage">
						<Boxes size={27} />
					</div>
					<p className="eyebrow">No premises records</p>
					<h2>Create your first grow space</h2>
					<p>
						Start with a tent, room, cabinet, greenhouse zone, or hydroponic
						system. Environmental mappings are optional during setup.
					</p>
					<Button onClick={() => setWizardOpen(true)}>
						<Plus size={16} /> Create grow space
					</Button>
				</section>
			)}

			{spaces.data && spaces.data.items.length > 0 && (
				<div className="space-grid">
					{spaces.data.items.map((space, index) => {
						const temperature = airTemperature(space);
						const dimensions = dimensionSummary(space);
						return (
							<Card className="space-card" key={space.id}>
								<div className="space-card__image">
									<div
										className={`space-orbit ${index % 2 === 0 ? "space-orbit--sage" : "space-orbit--sky"}`}
									>
										<Boxes size={26} />
									</div>
									<Badge tone={space.active ? "healthy" : "neutral"}>
										<CircleDot size={10} />{" "}
										{space.active ? "Active" : "Archived"}
									</Badge>
								</div>
								<div className="space-card__body">
									<h2>{space.name}</h2>
									<p>
										{[space.location, typeLabels[space.space_type], dimensions]
											.filter(Boolean)
											.join(" · ")}
									</p>
									<div className="space-stats">
										<span>
											<Wifi size={15} />
											{space.mapping_count} mapped{" "}
											{space.mapping_count === 1 ? "entity" : "entities"}
										</span>
										<span>
											<Thermometer size={15} />
											{temperature
												? `${temperature.normalized_value} ${temperature.normalized_unit}`
												: "No fresh air reading"}
										</span>
									</div>
									<button
										type="button"
										onClick={() => {
											window.location.hash = `/grow-spaces/${space.id}`;
										}}
									>
										Manage space <ArrowRight size={14} />
									</button>
								</div>
							</Card>
						);
					})}
					<button
						className="new-space-card"
						onClick={() => setWizardOpen(true)}
					>
						<span>
							<Plus size={20} />
						</span>
						<strong>Create another space</strong>
						<small>Map environmental records now; attach equipment later</small>
					</button>
				</div>
			)}

			<GrowSpaceWizard
				open={wizardOpen}
				onClose={() => setWizardOpen(false)}
				onCreated={openCreatedSpace}
			/>
		</div>
	);
}
