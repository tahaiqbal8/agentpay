import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
  {
    variants: {
      variant: {
        // Emerald means the chain agrees. Nothing else uses it.
        allowed: "border-[var(--color-accent-dim)] bg-[#10b9811a] text-[var(--color-accent)]",
        // Amber, not red: a denial is the enforcement layer working.
        denied: "border-[var(--color-warn-dim)] bg-[#f59e0b1a] text-[var(--color-warn)]",
        info: "border-[var(--color-cyan-dim)] bg-[#22d3ee1a] text-[var(--color-cyan)]",
        neutral: "border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]",
        danger: "border-[#7f1d1d] bg-[#ef44441a] text-[var(--color-danger)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
