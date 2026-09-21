import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tables.
 *
 * Every page hand-rolled its own until now, so column rhythm and row height
 * drifted between them. These are thin wrappers over real table elements —
 * not divs pretending — so a screen reader announces rows and columns, and
 * keyboard users can navigate them.
 *
 * Wrapped in an overflow container by default: a wide table scrolls inside
 * itself rather than pushing the page sideways, which is what makes this
 * usable on a laptop without shrinking the type.
 */
export function TableWrap({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // tabIndex makes a scrollable region reachable by keyboard, which the
      // browser does not do on its own for an overflow container.
      tabIndex={0}
      role="region"
      className={cn("w-full overflow-x-auto", className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-left", className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("border-b border-[var(--color-border)]", className)}
      {...props}
    />
  );
}

export function TH({
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "t-label px-3 py-2 font-medium",
        // Numbers compared down a column belong on the right, where their
        // digits line up.
        numeric && "text-right",
        className
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-[var(--color-border)]", className)} {...props} />;
}

export function TR({
  className,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        interactive && "interactive cursor-pointer hover:bg-[var(--color-surface-2)]",
        className
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn("px-3 py-2.5 align-middle text-xs", numeric && "tnum text-right", className)}
      {...props}
    />
  );
}

/** A row of skeletons, shown while the first fetch is in flight. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <TBody>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-3 py-2.5">
              <div className="skeleton h-3" style={{ width: c === 0 ? "70%" : "45%" }} />
            </td>
          ))}
        </tr>
      ))}
    </TBody>
  );
}
