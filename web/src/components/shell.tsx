"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ShieldCheck,
  Landmark,
  FlaskConical,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type Health } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

const NAV = [
  { href: "/", label: "Monitor", icon: Activity, hint: "Sessions & live claims" },
  { href: "/verifier", label: "Verifier", icon: ShieldCheck, hint: "Merkle proofs" },
  { href: "/settle", label: "Settlement", icon: Landmark, hint: "On-chain settle" },
  { href: "/playground", label: "Playground", icon: FlaskConical, hint: "Claim simulator" },
];

/**
 * Connection state is shown, never hidden.
 *
 * A dashboard that silently falls back to fixtures teaches operators to trust
 * numbers that are not real. The banner and the header pill both say so.
 */
export function GatewayStatus({
  health,
  live,
}: {
  health: Health | null;
  live: boolean | null;
}) {
  // null = not yet known. Showing "Live" optimistically would assert a
  // connection the page has not actually confirmed.
  if (live === null) {
    return (
      <Badge variant="neutral" className="gap-1.5">
        <span className="size-1.5 animate-pulse rounded-full bg-[var(--color-fg-dim)]" />
        Connecting…
      </Badge>
    );
  }
  if (!live) {
    return (
      <Badge variant="danger" className="gap-1.5">
        <span className="size-1.5 rounded-full bg-[var(--color-danger)]" />
        Gateway offline · seeded data
      </Badge>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Badge variant="allowed" className="gap-1.5">
        <span className="relative size-1.5 rounded-full bg-[var(--color-accent)]">
          <span className="live-dot absolute inset-0" />
        </span>
        Live
      </Badge>
      {health && (
        <Badge variant={health.ephemeral_state ? "denied" : "info"}>
          {health.state_backend === "POSTGRES" ? "Postgres" : "In-memory"}
        </Badge>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [live, setLive] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await api.health();
      if (cancelled) return;
      if (res.ok) {
        setHealth(res.data);
        setLive(true);
      } else {
        setLive(false);
      }
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const nav = (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/" || pathname?.startsWith("/session/")
            : pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            title={collapsed ? item.label : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]"
              )}
            />
            {!collapsed && (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{item.label}</span>
                <span className="truncate text-[10px] text-[var(--color-fg-dim)]">{item.hint}</span>
              </span>
            )}
            {active && !collapsed && (
              <span className="ml-auto size-1.5 rounded-full bg-[var(--color-accent)]" />
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60"
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
          <div className="grid size-6 shrink-0 place-items-center rounded bg-[var(--color-accent)] font-mono text-[11px] font-bold text-black">
            A
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">AgentPay</p>
              <p className="truncate text-[10px] text-[var(--color-fg-dim)]">Enforcement gateway</p>
            </div>
          )}
        </div>
        {nav}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="mt-auto flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-4">
              <span className="text-sm font-semibold">AgentPay</span>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="size-4 text-[var(--color-fg-dim)]" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-4 backdrop-blur">
          <button
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5 text-[var(--color-fg-muted)]" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {NAV.find((n) => n.href === pathname)?.label ??
                (pathname?.startsWith("/session/") ? "Session" : "AgentPay")}
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {health && (
              <span
                className="hidden font-mono text-[10px] text-[var(--color-fg-dim)] lg:inline"
                title={health.program_id}
              >
                {health.program_id.slice(0, 8)}…{health.program_id.slice(-6)}
              </span>
            )}
            <GatewayStatus health={health} live={live} />
          </div>
        </header>

        {live === false && (
          <div className="border-b border-[#7f1d1d] bg-[#ef44441a] px-4 py-2 text-xs text-[var(--color-danger)]">
            <strong className="font-semibold">Gateway unreachable.</strong> Everything below is
            seeded placeholder data, not on-chain state. Start the gateway on
            <code className="mx-1 font-mono">:8080</code> to see live sessions.
          </div>
        )}

        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
