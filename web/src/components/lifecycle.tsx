"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The payment lifecycle, as one strip.
 *
 * This is the component a visitor reads before anything else, so it carries
 * the whole argument of the product: a human bounds an agent, the chain holds
 * the money, every call is signed, the gateway decides, the decision is
 * recorded, and the result is provable. Nine stages, in the order they
 * actually happen.
 *
 * `reached` is an INDEX, and the caller must derive it from real state. A
 * stage is drawn complete only when the data says it happened — a lifecycle
 * that lights up on a timer would be a diagram pretending to be a status.
 */

export const LIFECYCLE_STAGES = [
  { key: "human", label: "Human", detail: "A person creates the agent" },
  { key: "agent", label: "Agent", detail: "Identity bound to a keypair" },
  { key: "policy", label: "Policy", detail: "Spending envelope set" },
  { key: "escrow", label: "Escrow", detail: "Funds locked on Solana" },
  { key: "claim", label: "Claim", detail: "Agent signs a cumulative claim" },
  { key: "enforcement", label: "Enforcement", detail: "Gateway verifies and decides" },
  { key: "evidence", label: "Evidence", detail: "Decision hashed into a chain" },
  { key: "settlement", label: "Settlement", detail: "Escrow moves to the provider" },
  { key: "verified", label: "Verified", detail: "Root anchored and recomputed" },
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]["key"];

export function PaymentLifecycle({
  reached,
  className,
  /** Shown when nothing has happened yet, instead of a fully dim strip. */
  caption,
}: {
  /** Index of the last COMPLETED stage. -1 means none. */
  reached: number;
  className?: string;
  caption?: string;
}) {
  const total = LIFECYCLE_STAGES.length;
  const pct = reached < 0 ? 0 : ((reached + 1) / total) * 100;

  return (
    <div className={cn("surface-card rounded-xl p-5", className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="t-section">Payment lifecycle</h2>
        <p className="t-support">
          {caption ??
            (reached < 0
              ? "No session has started yet"
              : `${reached + 1} of ${total} stages complete`)}
        </p>
      </div>

      {/* Scrolls rather than squeezing: nine labels cannot fit a phone, and a
          strip that wraps mid-flow stops reading as a sequence. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <ol className="flex min-w-[46rem] items-start gap-0">
          {LIFECYCLE_STAGES.map((stage, i) => {
            const done = i <= reached;
            const current = i === reached;
            const last = i === total - 1;
            return (
              <li key={stage.key} className="flex min-w-0 flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  {/* left half-rail */}
                  <span
                    className={cn(
                      "h-px flex-1",
                      i === 0
                        ? "bg-transparent"
                        : i <= reached
                          ? "bg-[var(--color-brand)]"
                          : "bg-[var(--color-border)]"
                    )}
                  />
                  <span
                    className={cn(
                      "relative grid size-6 shrink-0 place-items-center rounded-full border transition-colors duration-200",
                      done
                        ? "border-[var(--color-brand)] bg-[var(--color-brand)] text-white"
                        : "border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-fg-dim)]"
                    )}
                    title={stage.detail}
                  >
                    {done ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : (
                      <span className="size-1.5 rounded-full bg-current" />
                    )}
                    {current && (
                      <span className="absolute inset-0 rounded-full ring-2 ring-[var(--color-brand-glow)] ring-offset-2 ring-offset-[var(--color-surface)]" />
                    )}
                  </span>
                  {/* right half-rail */}
                  <span
                    className={cn(
                      "h-px flex-1",
                      last
                        ? "bg-transparent"
                        : i < reached
                          ? "bg-[var(--color-brand)]"
                          : "bg-[var(--color-border)]"
                    )}
                  />
                </div>
                <span
                  className={cn(
                    "mt-2 px-1 text-center text-[11px] font-medium leading-tight",
                    done ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]"
                  )}
                >
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* A second, coarser read of the same number, for anyone scanning. */}
      <div
        className="lifecycle-rail mt-4 h-1 rounded-full"
        style={{ ["--progress" as string]: `${pct}%` }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={reached + 1}
        aria-label="Payment lifecycle progress"
      />
    </div>
  );
}
