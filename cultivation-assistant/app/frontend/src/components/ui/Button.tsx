import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib";

const buttonVariants = cva(
	"inline-flex h-10 items-center justify-center gap-2 rounded-[3px] px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				primary:
					"bg-[var(--routing-violet)] text-white shadow-[2px_2px_0_var(--ink)] hover:bg-[var(--ink)]",
				secondary:
					"border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-raised)]",
				ghost:
					"text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]",
			},
			size: { sm: "h-8 rounded-[2px] px-3 text-[10px]", icon: "size-10 px-0" },
		},
		defaultVariants: { variant: "primary" },
	},
);

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, ...props }, ref) => (
		<button
			ref={ref}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	),
);
Button.displayName = "Button";
