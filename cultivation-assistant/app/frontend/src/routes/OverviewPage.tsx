import {
	ArrowRight,
	CloudSun,
	Droplets,
	Fan,
	Leaf,
	Lightbulb,
	Plus,
	Thermometer,
	Waves,
	Wind,
} from "lucide-react";
import { GrowthRail } from "../components/cultivation/GrowthRail";
import { MetricCard } from "../components/cultivation/MetricCard";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/Card";

const activity = [
	{
		icon: Droplets,
		title: "Reservoir reading recorded",
		meta: "North tent · 42.8 L",
		time: "12 min",
	},
	{
		icon: Leaf,
		title: "Stage check-in completed",
		meta: "Basilisk · Vegetative day 18",
		time: "2 hr",
	},
	{
		icon: Lightbulb,
		title: "Light period started",
		meta: "Home Assistant automation",
		time: "5 hr",
	},
];

export function OverviewPage() {
	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Daily cultivation register · 16 July 2026</p>
					<h1>Current case summary</h1>
					<p>
						Premises North Tent is within filed tolerances. One observation
						awaits review.
					</p>
				</div>
				<Button>
					<Plus size={17} /> File new entry
				</Button>
			</section>

			<section className="grow-hero">
				<div className="dossier-tab">ACTIVE CULTIVATION FILE</div>
				<div className="grow-hero__header">
					<div className="plant-avatar">
						<Leaf size={24} fill="currentColor" />
					</div>
					<div>
						<div className="flex flex-wrap items-center gap-2">
							<h2>Basilisk</h2>
							<Badge tone="healthy">On track</Badge>
						</div>
						<p>Emerald Grove · Photoperiod · Started 28 Jun</p>
					</div>
					<div className="grow-hero__harvest">
						<small>Projected harvest window</small>
						<strong>12–19 October</strong>
						<span>Confidence: high</span>
					</div>
					<div
						className="determination-stamp"
						aria-label="Status determination: conditions acceptable"
					>
						<span>Conditions</span>
						<strong>Acceptable</strong>
						<small>Review upon material change</small>
					</div>
				</div>
				<div className="routing-caption">
					<span>Routing: Intake</span>
					<span>Stage confirmation</span>
					<span>Environmental review</span>
					<span>Harvest determination</span>
				</div>
				<GrowthRail />
			</section>

			<section>
				<div className="section-heading">
					<div>
						<h2>Live environment</h2>
						<p>Fresh readings from Home Assistant</p>
					</div>
					<button>
						View environment <ArrowRight size={14} />
					</button>
				</div>
				<div className="metric-grid">
					<MetricCard
						label="Temperature"
						value="25.4"
						unit="°C"
						detail="In range"
						icon={Thermometer}
					/>
					<MetricCard
						label="Humidity"
						value="61"
						unit="%"
						detail="In range"
						icon={Droplets}
					/>
					<MetricCard
						label="VPD"
						value="1.18"
						unit="kPa"
						detail="Optimal"
						icon={Wind}
					/>
					<MetricCard
						label="CO₂"
						value="842"
						unit="ppm"
						detail="+12%"
						icon={CloudSun}
						status="info"
					/>
					<MetricCard
						label="PPFD"
						value="516"
						unit="µmol"
						detail="Fresh"
						icon={Lightbulb}
					/>
				</div>
			</section>

			<section className="dashboard-grid">
				<Card className="guidance-card">
					<CardHeader>
						<div>
							<p className="eyebrow">Guidance</p>
							<CardTitle>Airflow may be uneven</CardTitle>
						</div>
						<Badge tone="attention">Check today</Badge>
					</CardHeader>
					<CardContent>
						<p className="guidance-copy">
							Humidity near the canopy stayed 8% higher than the room sensor for
							43 minutes. This can indicate a low-airflow pocket.
						</p>
						<div className="evidence-row">
							<Fan size={17} />
							<div>
								<strong>What to check</strong>
								<span>Fan direction and canopy spacing</span>
							</div>
						</div>
						<div className="confidence">
							<span>Confidence</span>
							<div>
								<i />
								<i />
								<i />
								<i className="off" />
							</div>
							<strong>Moderate</strong>
						</div>
						<Button variant="secondary" className="w-full">
							Review observation <ArrowRight size={15} />
						</Button>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div>
							<p className="eyebrow">Reservoir</p>
							<CardTitle>Main nutrient tank</CardTitle>
						</div>
						<Badge tone="healthy">Fresh</Badge>
					</CardHeader>
					<CardContent className="reservoir-content">
						<div className="tank-visual" aria-label="Reservoir 68 percent full">
							<div className="tank-water">
								<span className="wave" />
							</div>
							<Waves size={20} />
						</div>
						<div className="tank-details">
							<strong>
								42.8 <small>L</small>
							</strong>
							<p>68% available</p>
							<div>
								<span>Est. refill</span>
								<b>Friday</b>
							</div>
							<div>
								<span>Daily use</span>
								<b>3.1 L</b>
							</div>
							<div>
								<span>Last update</span>
								<b>2 min ago</b>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div>
							<p className="eyebrow">Activity</p>
							<CardTitle>Latest events</CardTitle>
						</div>
						<button className="text-link">View all</button>
					</CardHeader>
					<CardContent className="activity-list">
						{activity.map((item) => (
							<div className="activity-item" key={item.title}>
								<div>
									<item.icon size={16} />
								</div>
								<p>
									<strong>{item.title}</strong>
									<span>{item.meta}</span>
								</p>
								<time>{item.time}</time>
							</div>
						))}
					</CardContent>
				</Card>
			</section>
		</div>
	);
}
