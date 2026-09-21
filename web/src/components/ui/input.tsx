import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] " +
  "px-2.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-dim)] " +
  "transition-colors hover:border-[var(--color-border-bright)] " +
  "focus:border-[var(--color-cyan-dim)] disabled:opacity-40";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(BASE, "mt-1 h-8", className)} {...props} />
  )
);
Input.displayName = "Input";

/**
 * Filter field.
 *
 * Separate from `Input` because it carries an icon and no label — a control
 * that narrows what is already on screen, rather than a field that collects a
 * value. Typing in it changes a view; typing in an `Input` changes data.
 */
export const SearchInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <Search
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-fg-dim)]"
    />
    <input
      ref={ref}
      type="search"
      className={cn(BASE, "h-8 pl-8")}
      {...props}
    />
  </div>
));
SearchInput.displayName = "SearchInput";

/**
 * A dropdown, styled to match `Input`.
 *
 * Kept as a real `<select>` rather than a scripted listbox: the native control
 * is keyboard-accessible, announces itself correctly, and works on a phone
 * without any of that being re-implemented.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(BASE, "mt-1 h-8 font-mono", className)}
    {...props}
  />
));
Select.displayName = "Select";

/** A field with its label and optional hint, laid out consistently. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <label htmlFor={htmlFor} className="t-label">
        {label}
      </label>
      {children}
      {hint && <p className="t-support mt-1">{hint}</p>}
    </div>
  );
}
