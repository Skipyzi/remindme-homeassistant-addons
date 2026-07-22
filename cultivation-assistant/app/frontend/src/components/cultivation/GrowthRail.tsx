import { Check } from "lucide-react";
import { cn } from "../../lib";

const stages = [
	{ name: "Seed", short: "Seed", done: true },
	{ name: "Seedling", short: "Seedling", done: true },
	{ name: "Vegetative", short: "Veg", current: true },
	{ name: "Flowering", short: "Flower", future: true },
	{ name: "Harvest", short: "Harvest", future: true },
];

export function GrowthRail() {
	const currentStageIndex = stages.findIndex((stage) => stage.current);

	return (
		<div className="growth-rail" aria-label="Plant lifecycle timeline">
			<div className="growth-rail__segments" aria-hidden="true">
				{stages.slice(0, -1).map((stage, index) => (
					<span
						key={`${stage.name}-segment`}
						className={cn(
							"growth-rail__segment",
							`segment-${index + 1}`,
							index < currentStageIndex && "is-filled",
							index === currentStageIndex && "is-current",
						)}
					>
						<i />
					</span>
				))}
			</div>
			{stages.map((stage, index) => (
				<div
					key={stage.name}
					className={cn(
						"growth-rail__stage",
						`stage-${index + 1}`,
						stage.current && "is-current",
						stage.done && "is-done",
					)}
				>
					<div className="growth-rail__node">
						{stage.done ? (
							<Check size={12} strokeWidth={3} />
						) : stage.current ? (
							<span className="growth-rail__leaf">●</span>
						) : null}
					</div>
					<span className="hidden sm:inline">{stage.name}</span>
					<span className="sm:hidden">{stage.short}</span>
					{stage.current && <small>Day 18</small>}
				</div>
			))}
		</div>
	);
}
