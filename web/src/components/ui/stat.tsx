import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

/**
 * A KPI card.
 *
 * Deliberately has no chart. There is no time-series endpoint on the gateway,
 * so any sparkline here would be drawn from numbers nobody measured — and a
 * dashboard that invents a trend line is worse than one that shows none. When
 * history exists, this is where it goes.
 */
export function Stat({
  label,
  value,
  support,
  icon: Icon,
  tone = "neutral",
  className,
}: {
  label: string;
  /** Pre-formatted. Amounts arrive as strings from BigInt maths upstream. */
  value: React.ReactNode;
  support?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "neutral" | "accent" | "cyan" | "agent" | "warn" | "danger";
  className?: string;
}) {
  const colour = {
    neutral: "text-[var(--color-fg-muted)]",
    accent: "text-[var(--color-accent)]",
    cyan: "text-[var(--color-cyan)]",
    agent: "text-[var(--color-agent)]",
    warn: "text-[var(--color-warn)]",
    danger: "text-[var(--color-danger)]",
  }[tone];

  const ring = {
    neutral: "bg-[var(--color-surface-2)]",
    accent: "bg-[#10b9811a]",
    cyan: "bg-[#22d3ee1a]",
    agent: "bg-[#a78bfa1a]",
    warn: "bg-[#f59e0b1a]",
    danger: "bg-[#ef44441a]",
  }[tone];

  return (
    <Card className={cn("p-4", className)}>
      <div className="flex items-start gap-3">
        {Icon && (
          <span
            aria-hidden="true"
            className={cn("grid size-7 shrink-0 place-items-center rounded-md", ring)}
          >
            <Icon className={cn("size-3.5", colour)} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="t-label">{label}</p>
          <p className={cn("t-kpi mt-1.5", tone === "neutral" ? "" : colour)}>{value}</p>
          {support && <p className="t-support mt-1">{support}</p>}
        </div>
      </div>
    </Card>
  );
}
