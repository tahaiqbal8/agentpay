import { cn } from "@/lib/utils";

/**
 * High-water mark bar.
 *
 * `percent` is presentation-only; the caller computes it in integer space (see
 * lib/format.ts) so a large deposit cannot round into a misleading width.
 */
export function Progress({
  percent,
  className,
  tone = "accent",
}: {
  percent: number;
  className?: string;
  tone?: "accent" | "warn" | "danger";
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const bar =
    tone === "danger"
      ? "bg-[var(--color-danger)]"
      : tone === "warn"
      ? "bg-[var(--color-warn)]"
      : "bg-[var(--color-accent)]";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]", className)}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", bar)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
