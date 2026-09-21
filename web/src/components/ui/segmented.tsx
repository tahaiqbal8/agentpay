"use client";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Compact filter control; denser than tabs and reads as one unit. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]"
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "tnum rounded px-1 text-[11px]",
                  active
                    ? "bg-[var(--color-bg)] text-[var(--color-fg-muted)]"
                    : "text-[var(--color-fg-dim)]"
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
