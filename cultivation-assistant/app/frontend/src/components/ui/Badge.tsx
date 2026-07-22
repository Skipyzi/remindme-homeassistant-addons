import type { HTMLAttributes } from "react";
import { cn } from "../../lib";

type Tone = "healthy" | "attention" | "neutral" | "info";

const tones: Record<Tone, string> = {
	healthy: "bg-[var(--sage-soft)] text-[var(--sage-strong)]",
	attention: "bg-[var(--amber-soft)] text-[var(--amber-strong)]",
	neutral: "bg-[var(--surface-raised)] text-[var(--text-muted)]",
	info: "bg-[var(--sky-soft)] text-[var(--sky-strong)]",
};

export function Badge({
	className,
	tone = "neutral",
	...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-[2px] border border-current/20 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em]",
				tones[tone],
				className,
			)}
			{...props}
		/>
	);
}
