"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * An empty list is a state, not an absence.
 *
 * "No data" tells a reader nothing and reads like a fault. Every empty state
 * here says what is missing, why that is fine, and what to do next — so the
 * first screen a new operator sees is an instruction rather than a blank.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ElementType;
  title: string;
  body: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className
      )}
    >
      {Icon && (
        <span className="grid size-11 place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
          <Icon className="size-5 text-[var(--color-fg-dim)]" />
        </span>
      )}
      <div className="max-w-sm space-y-1">
        <p className="text-[15px] font-semibold text-[var(--color-fg)]">{title}</p>
        <p className="t-body text-balance">{body}</p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/**
 * A shape where the content will be.
 *
 * Sized to the thing it replaces, so the page does not jump when real data
 * lands — a spinner says "wait", a skeleton says "a table is coming, and it is
 * about this big".
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function SkeletonRows({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 p-4", className)} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-4", className)} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="surface-card rounded-xl p-5">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-3 h-2.5 w-32" />
        </div>
      ))}
    </div>
  );
}
