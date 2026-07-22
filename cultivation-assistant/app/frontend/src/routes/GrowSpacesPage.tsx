import {
	ArrowRight,
	Boxes,
	CircleDot,
	Plus,
	Thermometer,
	Wifi,
} from "lucide-react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

const spaces = [
	{
		name: "North tent",
		detail: "120 × 120 cm · Indoor tent",
		entities: 14,
		temperature: "25.4 °C",
		status: "Growing",
		accent: "space-orbit--sage",
	},
	{
		name: "Propagation shelf",
		detail: "90 × 45 cm · Seedlings",
		entities: 6,
		temperature: "23.1 °C",
		status: "Ready",
		accent: "space-orbit--sky",
	},
];

export function GrowSpacesPage() {
	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Spaces & equipment</p>
					<h1>Grow spaces</h1>
					<p>
						Connect each growing area to the entities that measure and support
						it.
					</p>
				</div>
				<Button>
					<Plus size={17} /> New grow space
				</Button>
			</section>
			<div className="space-grid">
				{spaces.map((space) => (
					<Card className="space-card" key={space.name}>
						<div className="space-card__image">
							<div className={`space-orbit ${space.accent}`}>
								<Boxes size={26} />
							</div>
							<Badge tone="healthy">
								<CircleDot size={10} /> {space.status}
							</Badge>
						</div>
						<div className="space-card__body">
							<h2>{space.name}</h2>
							<p>{space.detail}</p>
							<div className="space-stats">
								<span>
									<Wifi size={15} />
									{space.entities} entities
								</span>
								<span>
									<Thermometer size={15} />
									{space.temperature}
								</span>
							</div>
							<button>
								Manage space <ArrowRight size={14} />
							</button>
						</div>
					</Card>
				))}
				<button className="new-space-card">
					<span>
						<Plus size={20} />
					</span>
					<strong>Create another space</strong>
					<small>Map sensors and equipment from Home Assistant</small>
				</button>
			</div>
		</div>
	);
}
