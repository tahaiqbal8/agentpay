import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Status badges.
 *
 * # Colour is never the only signal
 *
 * Every semantic variant carries a glyph as well as a hue. Roughly one man in
 * twelve cannot reliably separate the green and amber this console leans on,
 * and an operator surface where "allowed" and "refused" differ only by colour
 * is unreadable to them. The glyph is not decoration.
 *
 * # What each colour means, and the one that is easy to get wrong
 *
 * | Colour | Means |
 * | --- | --- |
 * | teal   | healthy, active, allowed, connected |
 * | cyan   | informational, on-chain, verification |
 * | purple | agent, policy, autonomy, planning |
 * | amber  | warning, expired, approval required, **policy refusal** |
 * | red    | invalid signature, security failure, genuine fault |
 *
 * **A policy refusal is amber, not red.** `ERR_POLICY_RESOURCE_NOT_ALLOWED` is
 * the system doing exactly its job. Colouring it like an outage teaches
 * operators that red means "ignore this", and then red means nothing on the
 * day it should mean everything.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider whitespace-nowrap",
  {
    variants: {
      variant: {
        /** Healthy, active, allowed, connected. */
        allowed:
          "border-[var(--color-accent-dim)] bg-[#10b9811a] text-[var(--color-accent)]",
        /** Warning, expired, approval required, policy refusal. */
        denied:
          "border-[var(--color-warn-dim)] bg-[#f59e0b1a] text-[var(--color-warn)]",
        /** Informational, on-chain, verification, claims. */
        info: "border-[var(--color-cyan-dim)] bg-[#22d3ee1a] text-[var(--color-cyan)]",
        /** Agent, policy, autonomy, planning. */
        agent:
          "border-[var(--color-agent-dim)] bg-[#a78bfa1a] text-[var(--color-agent)]",
        /** Reserved: invalid signature, security failure, genuine fault. */
        danger:
          "border-[var(--color-danger-dim)] bg-[#ef44441a] text-[var(--color-danger)]",
        /** No semantics — a count, a mode, a label. */
        neutral:
          "border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

/** The glyph for each semantic variant. Absent for `neutral`, which carries no
 *  status and would only be made noisier by one. */
const GLYPH: Record<string, string | null> = {
  allowed: "✓",
  denied: "!",
  info: "◆",
  agent: "◈",
  danger: "×",
  neutral: null,
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Suppresses the glyph where the surrounding text already carries it. */
  bare?: boolean;
}

export function Badge({ className, variant, bare, children, ...props }: BadgeProps) {
  const glyph = bare ? null : GLYPH[variant ?? "neutral"];
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props}>
      {glyph && (
        // Hidden from assistive technology: a screen reader announces the
        // badge's text, and "check mark allowed" is worse than "allowed".
        <span aria-hidden="true" className="leading-none opacity-80">
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}

/**
 * Picks the badge variant for a gateway reason code.
 *
 * Centralised so the red/amber distinction is made once. Anything that is not
 * a signature or infrastructure failure is a *decision*, and decisions are
 * amber — the system working, not the system broken.
 */
export function variantForReason(
  reason: string | null | undefined
): NonNullable<BadgeProps["variant"]> {
  if (!reason) return "neutral";
  if (reason === "ALLOWED") return "allowed";

  // The only genuine faults: a forged claim, or the gateway unable to reach
  // something it depends on.
  const faults = [
    "ERR_INVALID_SIGNATURE",
    "ERR_MALFORMED_CLAIM",
    "ERR_STORE_UNAVAILABLE",
    "ERR_CHAIN_UNAVAILABLE",
    "ERR_CONTROL_PLANE_UNAVAILABLE",
    "ERR_UPSTREAM_UNAVAILABLE",
  ];
  if (faults.includes(reason)) return "danger";

  return "denied";
}
