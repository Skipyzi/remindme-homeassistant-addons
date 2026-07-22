import type { HTMLAttributes } from "react";
import { cn } from "../../lib";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"rounded-[3px] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]",
				className,
			)}
			{...props}
		/>
	);
}

export function CardHeader({
	className,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"flex items-start justify-between gap-4 p-5 pb-0",
				className,
			)}
			{...props}
		/>
	);
}

export function CardTitle({
	className,
	...props
}: HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h2
			className={cn(
				"text-sm font-extrabold tracking-[-0.01em] text-[var(--text)]",
				className,
			)}
			{...props}
		/>
	);
}

export function CardContent({
	className,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("p-5", className)} {...props} />;
}
