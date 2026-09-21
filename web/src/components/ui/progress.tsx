import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A consumption bar.
 *
 * `percent` is presentation-only and the CALLER computes it in integer space.
 * That division is the only place a float is permitted anywhere near an
 * amount, and it happens after the comparison has already been made in BigInt
 * — the bar reflects a decision, it never makes one.
 *
 * Carries ARIA so the value is available without seeing the bar: a progress
 * bar that only exists visually is invisible to a screen reader.
 */
export function Progress({
  percent,
  className,
  tone = "accent",
  label,
}: {
  percent: number;
  className?: string;
  tone?: "accent" | "cyan" | "agent" | "warn" | "danger";
  /** What the bar measures, for assistive technology. */
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fill = {
    accent: "bg-[var(--color-accent)]",
    cyan: "bg-[var(--color-cyan)]",
    agent: "bg-[var(--color-agent)]",
    warn: "bg-[var(--color-warn)]",
    danger: "bg-[var(--color-danger)]",
  }[tone];

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn(
        "h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]",
        className
      )}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-300", fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
