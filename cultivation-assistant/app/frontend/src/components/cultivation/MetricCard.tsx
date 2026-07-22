import type { LucideIcon } from "lucide-react";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

interface MetricCardProps {
	label: string;
	value: string;
	unit: string;
	detail: string;
	icon: LucideIcon;
	status?: "healthy" | "attention" | "neutral" | "info";
}

export function MetricCard({
	label,
	value,
	unit,
	detail,
	icon: Icon,
	status = "healthy",
}: MetricCardProps) {
	return (
		<Card className="metric-card group overflow-hidden p-4">
			<div className="flex items-start justify-between">
				<div className="metric-card__icon grid size-9 place-items-center bg-[var(--surface-raised)] text-[var(--text-muted)] transition group-hover:text-[var(--sage-strong)]">
					<Icon aria-hidden="true" size={18} strokeWidth={1.8} />
				</div>
				<Badge tone={status}>{detail}</Badge>
			</div>
			<p className="mt-6 text-xs font-bold text-[var(--text-muted)]">{label}</p>
			<p className="mt-1 flex items-baseline gap-1.5">
				<span className="text-[1.75rem] font-extrabold leading-none tracking-[-0.06em] text-[var(--text)]">
					{value}
				</span>
				<span className="text-xs font-bold text-[var(--text-faint)]">
					{unit}
				</span>
			</p>
		</Card>
	);
}
