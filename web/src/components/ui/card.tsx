import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Cards.
 *
 * One surface treatment for the whole console, so depth reads as hierarchy
 * rather than as however a given component happened to be styled.
 *
 * `accent` tints the left edge to carry a card's semantic colour without
 * flooding the surface — an operator scanning a column of cards can tell an
 * agent card from an on-chain one peripherally, while the content stays on a
 * neutral ground where it is legible.
 */
export function Card({
  className,
  glow,
  accent,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  glow?: boolean;
  accent?: "accent" | "cyan" | "agent" | "warn" | "danger";
}) {
  const edge = accent
    ? {
        accent: "border-l-2 border-l-[var(--color-accent)]",
        cyan: "border-l-2 border-l-[var(--color-cyan)]",
        agent: "border-l-2 border-l-[var(--color-agent)]",
        warn: "border-l-2 border-l-[var(--color-warn)]",
        danger: "border-l-2 border-l-[var(--color-danger)]",
      }[accent]
    : null;

  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]",
        "shadow-[var(--shadow-card)]",
        glow && "glow-accent",
        edge,
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3",
        className
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("t-section", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("t-support", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}
