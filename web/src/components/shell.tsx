"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ShieldCheck,
  Landmark,
  FlaskConical,
  Bot,
  Store,
  UserCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type Health } from "@/lib/api";
import { protocolLabel } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";

/**
 * Grouped by what an operator is trying to DO, not by what the page contains.
 *
 * Operate → run it. Control → bound it. Verify → prove it. The last group is
 * the product's actual claim, so it sits last and on its own: a reader who
 * scans the sidebar once should come away knowing this system is something
 * you check, not just something you watch.
 *
 * Sessions are not a separate destination. The session list IS Overview, and
 * a session opens at /session/[pubkey] from there; giving it a nav entry as
 * well would mean two routes rendering the same table.
 */
const NAV_GROUPS = [
  {
    label: "Operate",
    items: [
      { href: "/", label: "Overview", icon: Activity, hint: "Sessions & live claims" },
      { href: "/agents", label: "Agents", icon: Bot, hint: "Identity & authorization" },
    ],
  },
  {
    label: "Control",
    items: [
      { href: "/approvals", label: "Approvals", icon: UserCheck, hint: "Human-decided spends" },
      { href: "/registry", label: "Registry", icon: Store, hint: "Providers & catalogue" },
    ],
  },
  {
    label: "Verify",
    items: [
      { href: "/verifier", label: "Verifier", icon: ShieldCheck, hint: "Merkle proofs" },
      { href: "/settle", label: "Settlement", icon: Landmark, hint: "On-chain settle" },
      { href: "/playground", label: "Playground", icon: FlaskConical, hint: "Claim simulator" },
    ],
  },
];

const NAV = NAV_GROUPS.flatMap((g) => g.items);

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
  const protocol = protocolLabel(health?.program_id);

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

  /* Takes the collapsed flag rather than closing over it: the mobile drawer is
     always full-width, so it must render labels even while the DESKTOP rail is
     collapsed. Sharing one boolean made the drawer show bare icons in a 256px
     panel. */
  const renderNav = (collapsed: boolean) => (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="t-label px-3 pb-1.5 pt-1">{group.label}</p>
          )}
          {group.items.map((item) => {
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
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                  active
                    ? "bg-[var(--color-brand-glow)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
                )}
              >
                {/* The active marker is a rail, not a dot: it survives the
                    collapsed rail where a trailing dot would be clipped. */}
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-[var(--color-brand)]" />
                )}
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    active
                      ? "text-[var(--color-brand)]"
                      : "text-[var(--color-fg-dim)] group-hover:text-[var(--color-fg-muted)]"
                  )}
                />
                {!collapsed && (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium leading-tight">{item.label}</span>
                    <span className="truncate text-[11px] leading-tight text-[var(--color-fg-dim)]">
                      {item.hint}
                    </span>
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  /* Which chain, and which protocol. Read from /health, never hardcoded — a
     console that claims "Devnet · V2" while pointed somewhere else is worse
     than one that says nothing. */
  const footer = (
    <div className="mt-auto flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-3">
      {!collapsed && (
        <>
          <div className="flex items-center gap-2">
            <span className="relative size-1.5 rounded-full bg-[var(--color-accent)]">
              {live && <span className="live-dot absolute inset-0" />}
            </span>
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">
              {health ? "Devnet" : "Devnet · connecting"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded border border-[var(--color-brand-dim)] bg-[var(--color-brand-glow)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-fg)]">
              {protocol}
            </span>
            {health && (
              <span
                className="t-mono truncate text-[var(--color-fg-dim)]"
                title={health.program_id}
              >
                {health.program_id.slice(0, 6)}…{health.program_id.slice(-4)}
              </span>
            )}
          </div>
        </>
      )}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 pt-1 text-xs text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      {/* Desktop sidebar */}
      {/* `sticky h-screen`, not `min-h-screen`: the rail stretched to the
          height of the whole DOCUMENT, so its footer — the Devnet and protocol
          badges — sat below the fold of any page long enough to scroll, which
          is every page. Pinned to the viewport it is always readable, and the
          nav scrolls inside itself when the group list outgrows a short
          window. */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60"
        )}
      >
        <div className="flex h-16 items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-strong)] text-[13px] font-bold text-white shadow-[0_2px_12px_-2px_var(--color-brand)]">
            A
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold leading-tight tracking-tight">
                AgentPay
              </p>
              <p className="truncate text-[11px] leading-tight text-[var(--color-fg-dim)]">
                Autonomous Payment Infrastructure
              </p>
            </div>
          )}
        </div>
        {renderNav(collapsed)}
        {footer}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex h-16 items-center justify-between border-b border-[var(--color-border)] px-4">
              <div className="flex items-center gap-2.5">
                <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-strong)] text-[13px] font-bold text-white">
                  A
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold leading-tight">AgentPay</p>
                  <p className="text-[11px] leading-tight text-[var(--color-fg-dim)]">
                    Autonomous Payment Infrastructure
                  </p>
                </div>
              </div>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="size-4 text-[var(--color-fg-dim)]" />
              </button>
            </div>
            {renderNav(false)}
            <div className="mt-auto flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
              <span className="size-1.5 rounded-full bg-[var(--color-accent)]" />
              <span className="text-[11px] text-[var(--color-fg-muted)]">Devnet</span>
              <span className="ml-auto rounded border border-[var(--color-brand-dim)] bg-[var(--color-brand-glow)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-fg)]">
                {protocol}
              </span>
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[var(--color-border)] px-4 md:px-6">
          <button
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5 text-[var(--color-fg-muted)]" />
          </button>
          {/* Deliberately not an `h1`. Every page carries its own heading, and
              a second one here would make each document claim two top-level
              titles — a screen reader would announce the chrome as the page.
              This is a location label, so it is styled like one. */}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {NAV.find((n) => n.href === pathname)?.label ??
                (pathname?.startsWith("/session/") ? "Session" : "AgentPay")}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {health && (
              <span
                className="hidden font-mono text-[11px] text-[var(--color-fg-dim)] lg:inline"
                title={health.program_id}
              >
                {health.program_id.slice(0, 8)}…{health.program_id.slice(-6)}
              </span>
            )}
            <GatewayStatus health={health} live={live} />
          </div>
        </header>

        {live === false && (
          <div className="border-b border-[var(--color-danger-dim)] bg-[#ef44441a] px-4 py-2 text-xs text-[var(--color-danger)]">
            <strong className="font-semibold">Gateway unreachable.</strong> Everything below is
            seeded placeholder data, not on-chain state. Start the gateway on
            <code className="mx-1 font-mono">:8080</code> to see live sessions.
          </div>
        )}

        {/* Generous, and capped. Full-bleed dashboards stop being readable
            past about 1400px — the eye loses the row it is on. */}
        <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
