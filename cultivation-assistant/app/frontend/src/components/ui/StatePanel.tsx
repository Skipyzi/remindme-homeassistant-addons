import {
	AlertTriangle,
	LoaderCircle,
	Plus,
	type LucideIcon,
} from "lucide-react";
import { Button } from "./Button";
import { Card } from "./Card";

interface StatePanelProps {
	title: string;
	description: string;
	icon?: LucideIcon;
	actionLabel?: string;
	onAction?: () => void;
}

export function EmptyState({
	title,
	description,
	icon: Icon = Plus,
	actionLabel,
	onAction,
}: StatePanelProps) {
	return (
		<StatePanel
			title={title}
			description={description}
			icon={Icon}
			actionLabel={actionLabel}
			onAction={onAction}
		/>
	);
}

export function ErrorState({
	title = "This view could not load",
	description,
	actionLabel = "Try again",
	onAction,
}: Omit<StatePanelProps, "icon">) {
	return (
		<StatePanel
			title={title}
			description={description}
			icon={AlertTriangle}
			actionLabel={actionLabel}
			onAction={onAction}
			tone="error"
		/>
	);
}

export function LoadingState({
	label = "Loading current data",
}: {
	label?: string;
}) {
	return (
		<div className="loading-state" role="status">
			<LoaderCircle className="animate-spin" size={20} />
			<span>{label}</span>
		</div>
	);
}

function StatePanel({
	title,
	description,
	icon: Icon = Plus,
	actionLabel,
	onAction,
	tone,
}: StatePanelProps & { tone?: "error" }) {
	return (
		<Card className="state-panel">
			<div
				className={
					tone === "error"
						? "state-panel__icon state-panel__icon--error"
						: "state-panel__icon"
				}
			>
				<Icon size={23} />
			</div>
			<h2>{title}</h2>
			<p>{description}</p>
			{actionLabel && (
				<Button variant="secondary" onClick={onAction}>
					{actionLabel}
				</Button>
			)}
		</Card>
	);
}
