"use client";
import * as React from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "error" | "info";
interface Toast { id: number; kind: ToastKind; title: string; body?: string }

const ToastCtx = React.createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const push = React.useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "animate-in-row pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-[var(--color-surface)] p-3 shadow-xl",
              t.kind === "success" && "border-[var(--color-accent-dim)]",
              t.kind === "error" && "border-[var(--color-danger-dim)]",
              t.kind === "info" && "border-[var(--color-border-bright)]"
            )}
          >
            {t.kind === "success" && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" />}
            {t.kind === "error" && <XCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />}
            {t.kind === "info" && <Info className="mt-0.5 size-4 shrink-0 text-[var(--color-cyan)]" />}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[var(--color-fg)]">{t.title}</p>
              {t.body && <p className="mt-0.5 break-all font-mono text-[11px] text-[var(--color-fg-dim)]">{t.body}</p>}
            </div>
            <button
              onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
              className="text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
