import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Buttons.
 *
 * Four levels, and the hierarchy is the point: if every button looks equally
 * important, none of them is. At most one `default` per view — the thing the
 * operator came to do.
 *
 * `danger` is for actions that remove access or stop work (suspend an agent,
 * revoke a credential), not for anything that merely says no.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-40 " +
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** The primary action. One per view. */
        default:
          "bg-[var(--color-accent)] text-[#04170f] hover:bg-[#0ea371] active:bg-[#0b8a60] shadow-[var(--shadow-card)]",
        /** A real action, not the main one. */
        outline:
          "border border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-fg)] " +
          "hover:border-[var(--color-fg-dim)] hover:bg-[#1b1b21]",
        /** Tertiary: navigation, dismissal, an icon in a row. */
        ghost:
          "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]",
        /** Removes access or stops work. Deliberately uncommon. */
        danger:
          "border border-[var(--color-danger-dim)] bg-[#ef44441a] text-[var(--color-danger)] " +
          "hover:bg-[#ef444426]",
      },
      size: {
        default: "h-8 px-3 text-xs",
        sm: "h-7 px-2.5 text-[11px]",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        // Defaults to `button`, not `submit`. A button inside a form that
        // submits it by accident is a bug that only shows up once somebody
        // presses Enter in a field.
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
export { buttonVariants };
