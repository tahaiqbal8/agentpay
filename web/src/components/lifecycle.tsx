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

/**
 * `detail` is rendered, not hovered.
 *
 * These nine sentences were previously passed only as `title=""`, which meant
 * the one genuinely explanatory element on the landing page reached the screen
 * as nine bare nouns — Human, Agent, Policy, Escrow… — and the explanation was
 * available only to a reader who already cared enough to hover each dot. A
 * first-time visitor learned the SEQUENCE and never the MEANING.
 *
 * They are also deliberately plain. The earlier wording leaned on "cumulative
 * claim", "hashed into a chain" and "root anchored", which are precise and
 * correct but assume the vocabulary this strip exists to teach. The precise
 * terms still appear — on the Verifier, on session detail, and in the docs,
 * where a reader has arrived on purpose.
 */
export const LIFECYCLE_STAGES = [
  { key: "human", label: "Human", detail: "A person sets the spending rules" },
  { key: "agent", label: "Agent", detail: "Software is authorized to spend" },
  { key: "policy", label: "Policy", detail: "How much, on what, until when" },
  { key: "escrow", label: "Escrow", detail: "Funds locked on Solana" },
  { key: "claim", label: "Claim", detail: "Every request is signed" },
  { key: "enforcement", label: "Enforcement", detail: "Allowed or refused before money moves" },
  { key: "evidence", label: "Evidence", detail: "Each decision is recorded" },
  { key: "settlement", label: "Settlement", detail: "Money moves to the provider" },
  { key: "verified", label: "Verified", detail: "Anyone can check the record" },
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]["key"];

const total = LIFECYCLE_STAGES.length;

/** Staggered entrance. Capped so the last stage is not still arriving half a
 *  second after the first — the strip should read as one object. */
function delayFor(i: number): React.CSSProperties {
  return { animationDelay: `${Math.min(i * 45, 400)}ms` };
}

function Dot({ done, current }: { done: boolean; current: boolean }) {
  return (
    <span
      className={cn(
        "relative grid size-6 shrink-0 place-items-center rounded-full border transition-colors duration-300",
        done
          ? "border-[var(--color-brand)] bg-[var(--color-brand)] text-white"
          : "border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-fg-dim)]"
      )}
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
  );
}

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
  const pct = reached < 0 ? 0 : ((reached + 1) / total) * 100;

  return (
    <div className={cn("surface-card rounded-xl p-4 sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="t-section">How a payment works</h2>
        <p className="t-support">
          {caption ??
            (reached < 0
              ? "No session has started yet"
              : `${reached + 1} of ${total} stages complete`)}
        </p>
      </div>

      {/* ---- horizontal, xl and up ------------------------------------------
          Nine columns of label + sentence need roughly 100px each before the
          sentences start breaking into four lines, so the rail is reserved for
          viewports that genuinely have the room. Below that it is not squeezed
          — it becomes the vertical stepper underneath, which is a better shape
          for the same information rather than a worse copy of this one. */}
      <ol className="hidden items-start gap-0 xl:flex" aria-label="Payment lifecycle">
        {LIFECYCLE_STAGES.map((stage, i) => {
          const done = i <= reached;
          const current = i === reached;
          return (
            <li
              key={stage.key}
              style={delayFor(i)}
              className="stage-in flex min-w-0 flex-1 flex-col items-center"
            >
              <div className="flex w-full items-center">
                <span
                  className={cn(
                    "stage-link flex h-px flex-1",
                    i === 0 && "invisible"
                  )}
                >
                  <span
                    className={cn(
                      "h-px w-full",
                      i <= reached
                        ? "scale-x-100 bg-[var(--color-brand)]"
                        : "scale-x-100 bg-[var(--color-border)]"
                    )}
                  />
                </span>
                <Dot done={done} current={current} />
                <span
                  className={cn(
                    "stage-link flex h-px flex-1",
                    i === total - 1 && "invisible"
                  )}
                >
                  <span
                    className={cn(
                      "h-px w-full",
                      i < reached
                        ? "bg-[var(--color-brand)]"
                        : "bg-[var(--color-border)]"
                    )}
                  />
                </span>
              </div>
              <span
                className={cn(
                  "mt-2 px-1 text-center text-[11px] font-semibold leading-tight",
                  done ? "text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]"
                )}
              >
                {stage.label}
              </span>
              <span className="mt-1 px-1.5 text-center text-[10.5px] leading-snug text-[var(--color-fg-dim)]">
                {stage.detail}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ---- vertical, below xl ---------------------------------------------
          The old strip was a single `min-w-[46rem]` row inside an overflow-x
          container. On a 375px viewport that hid five of the nine stages
          behind a horizontal scroll nobody discovers — including Settlement
          and Verified, which are the two the whole product is arguing toward.
          A vertical stepper shows all nine, keeps the sequence unambiguous,
          and gives each sentence a full line to be read on. */}
      <ol className="flex flex-col xl:hidden" aria-label="Payment lifecycle">
        {LIFECYCLE_STAGES.map((stage, i) => {
          const done = i <= reached;
          const current = i === reached;
          const last = i === total - 1;
          return (
            <li key={stage.key} style={delayFor(i)} className="stage-in flex gap-3">
              {/* rail column: dot, then the connector down to the next dot */}
              <div className="flex flex-col items-center self-stretch">
                <Dot done={done} current={current} />
                {!last && (
                  <span className="stage-link-v flex w-px flex-1">
                    <span
                      className={cn(
                        "w-px flex-1",
                        i < reached
                          ? "bg-[var(--color-brand)]"
                          : "bg-[var(--color-border)]"
                      )}
                    />
                  </span>
                )}
              </div>
              {/* content column */}
              <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-4")}>
                <p
                  className={cn(
                    "text-[13px] font-semibold leading-6",
                    done ? "text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]"
                  )}
                >
                  {stage.label}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-[var(--color-fg-dim)]">
                  {stage.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

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
