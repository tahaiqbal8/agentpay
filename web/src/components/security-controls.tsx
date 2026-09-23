"use client";

import * as React from "react";
import { Check, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The five controls that make this a security product, and whether each one
 * is actually on.
 *
 * Three states, deliberately — not two. `unknown` exists because the console
 * cannot confirm every control from the gateway's public surface, and a tick
 * it has not earned is the single most damaging thing this panel could draw.
 * A judge who later learns a green check meant "we assumed so" stops trusting
 * the ones that were real.
 *
 * Every caller must pass a value derived from a response, never a literal.
 */

export type ControlState = "on" | "off" | "unknown";

export interface SecurityControl {
  label: string;
  state: ControlState;
  /** What the tick is asserting, in one line. Shown under the label. */
  evidence: string;
}

const ICON: Record<ControlState, React.ElementType> = {
  on: Check,
  off: X,
  unknown: Minus,
};

const TONE: Record<ControlState, { dot: string; text: string; ring: string }> = {
  on: {
    dot: "bg-[var(--color-accent)] text-black",
    text: "text-[var(--color-accent)]",
    ring: "border-[var(--color-accent-dim)]",
  },
  off: {
    dot: "bg-[var(--color-danger)] text-white",
    text: "text-[var(--color-danger)]",
    ring: "border-[var(--color-danger-dim)]",
  },
  unknown: {
    dot: "bg-[var(--color-surface-2)] text-[var(--color-fg-dim)]",
    text: "text-[var(--color-fg-dim)]",
    ring: "border-[var(--color-border)]",
  },
};

const WORD: Record<ControlState, string> = {
  on: "Active",
  off: "Off",
  unknown: "Not reported",
};

export function SecurityControls({
  controls,
  className,
}: {
  controls: SecurityControl[];
  className?: string;
}) {
  return (
    <div className={cn("surface-card rounded-xl p-5", className)}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="t-section">Security controls</h2>
        <p className="t-support">What the gateway reports, not what it intends</p>
      </div>

      <ul className="mt-4 flex flex-col divide-y divide-[var(--color-border)]">
        {controls.map((c) => {
          const Icon = ICON[c.state];
          const tone = TONE[c.state];
          return (
            <li key={c.label} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                  tone.dot,
                  tone.ring
                )}
              >
                <Icon className="size-3" strokeWidth={3} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium leading-tight text-[var(--color-fg)]">
                  {c.label}
                </span>
                <span className="t-support mt-0.5">{c.evidence}</span>
              </span>
              <span className={cn("t-label shrink-0 pt-0.5", tone.text)}>{WORD[c.state]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
