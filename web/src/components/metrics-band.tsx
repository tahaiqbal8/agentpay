import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The money line: escrow, spent, remaining, decisions.
 *
 * ONE band, not four cards. Four separate tiles read as four unrelated facts,
 * and the landing page's whole problem was that it looked like a collection of
 * cards rather than a control surface. Escrow, spent and remaining are three
 * views of a single quantity — they belong inside one frame, separated by rules
 * rather than by gaps, so the eye reads them as an equation.
 *
 * `emphasis` decides the type size. Money is the number a reader came for;
 * counts support it. Nothing here formats its own values — everything arrives
 * pre-formatted from real gateway data, and an absent value is rendered as an
 * honest dash by the caller rather than as a zero this component invented.
 */

export interface Metric {
  label: string;
  value: React.ReactNode;
  /** One short line under the number. Real detail, never filler. */
  support?: React.ReactNode;
  tone?: "default" | "accent" | "warn" | "agent";
  emphasis?: "money" | "count";
}

export function MetricsBand({
  metrics,
  className,
}: {
  metrics: Metric[];
  className?: string;
}) {
  return (
    <section
      aria-label="Key figures"
      className={cn(
        "surface-card grid grid-cols-2 overflow-hidden rounded-xl lg:grid-cols-4",
        className
      )}
    >
      {metrics.map((m, i) => {
        const tone = m.tone ?? "default";
        const valueColour = {
          default: "text-[var(--color-fg)]",
          accent: "text-[var(--color-accent)]",
          warn: "text-[var(--color-warn)]",
          agent: "text-[var(--color-agent)]",
        }[tone];

        return (
          <div
            key={m.label}
            className={cn(
              "min-w-0 px-4 py-3.5",
              /* Rules, not gaps. A 1px divider keeps the four readings inside
                 one object; whitespace between them would split it back into
                 tiles. The right-hand border is dropped at the end of each row,
                 which differs between the two-column and four-column layouts. */
              "border-[var(--color-border)]",
              i % 2 === 0 && "border-r lg:border-r",
              i < 2 && "border-b lg:border-b-0",
              i === 3 && "lg:border-r-0",
              i === 1 && "border-r-0 lg:border-r"
            )}
          >
            <p className="t-label truncate">{m.label}</p>
            <p
              className={cn(
                "tnum mt-1.5 font-semibold leading-none tracking-tight",
                m.emphasis === "count" ? "text-[22px]" : "text-[26px]",
                valueColour
              )}
            >
              {m.value}
            </p>
            {m.support && (
              <p className="t-support mt-1.5 truncate">{m.support}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
