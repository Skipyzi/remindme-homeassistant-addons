import { Droplets, Waves } from "lucide-react";
import {
	useReservoirDashboard,
	type DataQuality,
	type ReservoirDashboard as Dashboard,
} from "../../api/reservoirs";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";

const qualityTone: Record<DataQuality, "healthy" | "neutral" | "attention"> = {
	good: "healthy",
	no_level_source: "neutral",
	sensor_unavailable: "attention",
	no_readings: "neutral",
	insufficient_history: "neutral",
};

const qualityLabels: Record<DataQuality, string> = {
	good: "Live",
	no_level_source: "No level source",
	sensor_unavailable: "Sensor unavailable",
	no_readings: "Awaiting readings",
	insufficient_history: "Building history",
};

function formatHours(hours: number): string {
	if (hours < 1) return "due now";
	if (hours < 48) return `~${Math.round(hours)} h`;
	return `~${Math.round(hours / 24)} days`;
}

function formatVolume(value: string | number | null): string {
	if (value === null) return "—";
	return `${Number(value).toFixed(1)} L`;
}

function formatLiters(value: string | number | null): string {
	if (value === null) return "—";
	return `${Number(value).toFixed(1)} L`;
}

function formatDateTime(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return "—";
	return parsed.toLocaleString(undefined, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function TankVisual({ dashboard }: { dashboard: Dashboard }) {
	const percent =
		dashboard.current?.level_percent !== null &&
		dashboard.current?.level_percent !== undefined
			? Number(dashboard.current.level_percent)
			: 0;
	const fill = Math.max(0, Math.min(100, percent));
	return (
		<div
			className="tank-visual"
			role="img"
			aria-label={`Reservoir ${fill.toFixed(0)} percent full`}
		>
			<div className="tank-water" style={{ height: `${fill.toFixed(1)}%` }}>
				<span className="wave" />
			</div>
			<Waves size={20} />
		</div>
	);
}

function TankDetails({ dashboard }: { dashboard: Dashboard }) {
	const { current, consumption, forecast } = dashboard;
	return (
		<div className="tank-details">
			<strong>
				{formatVolume(current?.volume_liters ?? null)} <small>L</small>
			</strong>
			<p>
				{current?.level_percent !== null && current?.level_percent !== undefined
					? `${Number(current.level_percent).toFixed(0)}% of usable volume`
					: "Volume without a level percentage"}
			</p>
			<div>
				<span>Daily use</span>
				<b>{formatLiters(consumption?.daily_liters ?? null)}</b>
			</div>
			<div>
				<span>7-day average</span>
				<b>{formatLiters(consumption?.seven_day_average_liters ?? null)}</b>
			</div>
			<div>
				<span>Est. refill</span>
				<b>
					{forecast?.hours_remaining !== null &&
					forecast?.hours_remaining !== undefined
						? formatHours(Number(forecast.hours_remaining))
						: "Needs more history"}
				</b>
			</div>
			{forecast?.estimated_refill_at && (
				<div>
					<span>Projected at</span>
					<b>{formatDateTime(forecast.estimated_refill_at)}</b>
				</div>
			)}
		</div>
	);
}

export function ReservoirDashboard({ reservoirId }: { reservoirId: string }) {
	const dashboard = useReservoirDashboard(reservoirId);

	return (
		<section className="capability-section">
			<div className="section-heading-row">
				<div>
					<p className="eyebrow">Capability · Volume &amp; forecast</p>
					<h2>Reservoir dashboard</h2>
				</div>
				{dashboard.data && (
					<Badge tone={qualityTone[dashboard.data.data_quality]}>
						{qualityLabels[dashboard.data.data_quality]}
					</Badge>
				)}
			</div>

			{dashboard.isLoading && (
				<div className="capability-empty">
					<p>Loading reservoir dashboard…</p>
				</div>
			)}

			{dashboard.isError && (
				<div className="capability-empty" role="alert">
					<p>The reservoir dashboard could not be loaded.</p>
					<Button variant="secondary" onClick={() => dashboard.refetch()}>
						Retry
					</Button>
				</div>
			)}

			{dashboard.data?.data_quality === "no_level_source" && (
				<div className="capability-empty">
					<Droplets size={22} />
					<p>
						Map a level percentage, depth, or distance sensor — or a calibration
						table — to see live volume, consumption, and refill forecasts.
					</p>
				</div>
			)}

			{dashboard.data && dashboard.data.data_quality !== "no_level_source" && (
				<>
					<div className="reservoir-content">
						<TankVisual dashboard={dashboard.data} />
						<TankDetails dashboard={dashboard.data} />
					</div>
					<p className="wizard-intro">
						Consumption counts volume decreases only; refills are excluded until
						refill events are recorded. Forecasts need at least a full day of
						readings.
					</p>
				</>
			)}
		</section>
	);
}
