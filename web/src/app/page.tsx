"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Ban, CircleCheck, Layers, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { MonoKey } from "@/components/mono";
import { Input } from "@/components/ui/input";
import { api, mock, type RecentDecision, type SessionSummary } from "@/lib/api";
import {
  consumedPercent,
  expiryCountdown,
  explorerAddress,
  formatUsdc,
  formatUsdcCompact,
  timeAgo,
} from "@/lib/format";

function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  tone?: "default" | "accent" | "warn";
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-3">
        <div
          className={
            tone === "accent"
              ? "grid size-8 place-items-center rounded bg-[#10b9811a] text-[var(--color-accent)]"
              : tone === "warn"
              ? "grid size-8 place-items-center rounded bg-[#f59e0b1a] text-[var(--color-warn)]"
              : "grid size-8 place-items-center rounded bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]"
          }
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">{label}</p>
          <p className="tnum truncate text-lg font-semibold leading-tight">{value}</p>
          {sub && <p className="truncate text-[10px] text-[var(--color-fg-dim)]">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live allowance bar: what the agent has spent against what it may spend. */
function HighWaterMark({ s }: { s: SessionSummary }) {
  const pct = consumedPercent(s.cumulative_accepted, s.deposited_total);
  const tone = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "accent";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="tnum font-mono text-xs text-[var(--color-fg)]">
          {formatUsdcCompact(s.cumulative_accepted)}
        </span>
        <span className="tnum font-mono text-[10px] text-[var(--color-fg-dim)]">
          / {formatUsdcCompact(s.deposited_total)}
        </span>
      </div>
      <Progress percent={pct} tone={tone} />
      <div className="flex justify-between text-[10px] text-[var(--color-fg-dim)]">
        <span>{pct.toFixed(1)}% consumed</span>
        <span className="tnum">{formatUsdcCompact(s.remaining)} left</span>
      </div>
    </div>
  );
}

function ExpiryCell({ expiresAt, settled }: { expiresAt: number; settled: boolean }) {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);

  if (settled) return <span className="text-[10px] text-[var(--color-fg-dim)]">—</span>;
  const { label, expired, urgent } = expiryCountdown(expiresAt);
  return (
    <span
      className={
        expired
          ? "tnum font-mono text-[11px] text-[var(--color-danger)]"
          : urgent
          ? "tnum font-mono text-[11px] text-[var(--color-warn)]"
          : "tnum font-mono text-[11px] text-[var(--color-fg-muted)]"
      }
    >
      {label}
    </span>
  );
}

export default function MonitorPage() {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [decisions, setDecisions] = React.useState<RecentDecision[]>([]);
  const [live, setLive] = React.useState<boolean | null>(null);
  const [filter, setFilter] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const [s, d] = await Promise.all([api.sessions(), api.recentDecisions()]);
      if (cancelled) return;
      if (s.ok && d.ok) {
        setSessions(s.data.sessions);
        setDecisions(d.data.decisions);
        setLive(true);
      } else {
        // Fixtures, clearly flagged everywhere they surface.
        setSessions(mock.sessions());
        setDecisions(mock.decisions());
        setLive(false);
      }
      setLoaded(true);
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.session.toLowerCase().includes(q) ||
        s.agent.toLowerCase().includes(q) ||
        s.provider.toLowerCase().includes(q)
    );
  }, [sessions, filter]);

  const active = sessions.filter((s) => !s.is_settled);
  const denials = decisions.filter((d) => !d.allowed).length;
  const escrowed = sessions
    .filter((s) => !s.is_settled)
    .reduce((acc, s) => acc + BigInt(s.deposited_total), 0n);
  const committed = sessions.reduce((acc, s) => acc + BigInt(s.cumulative_accepted), 0n);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Active sessions"
          value={String(active.length)}
          sub={`${sessions.length} total tracked`}
          icon={Layers}
          tone="accent"
        />
        <Stat
          label="Escrowed (active)"
          value={formatUsdcCompact(escrowed)}
          sub="USDC held in vaults"
          icon={Wallet}
        />
        <Stat
          label="Claimed cumulative"
          value={formatUsdcCompact(committed)}
          sub="across all sessions"
          icon={CircleCheck}
          tone="accent"
        />
        <Stat
          label="Denials in feed"
          value={String(denials)}
          sub={`of last ${decisions.length} decisions`}
          icon={Ban}
          tone={denials > 0 ? "warn" : "default"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        {/* ---- sessions table ---- */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Active sessions</CardTitle>
              <CardDescription>High-water mark against escrowed allowance</CardDescription>
            </div>
            <Input
              placeholder="Filter by pubkey…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 max-w-[200px] font-mono text-xs"
            />
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                  <tr>
                    <th className="px-4 py-2 font-medium">Session</th>
                    <th className="px-4 py-2 font-medium">Agent</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="w-[200px] px-4 py-2 font-medium">High-water mark</th>
                    <th className="px-4 py-2 font-medium">Expiry</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {filtered.slice(0, 40).map((s) => (
                    <tr key={s.session} className="hover:bg-[var(--color-surface-2)]">
                      <td className="px-4 py-2.5">
                        <MonoKey value={s.session} href={explorerAddress(s.session)} />
                      </td>
                      <td className="px-4 py-2.5">
                        <MonoKey value={s.agent} head={4} tail={4} />
                      </td>
                      <td className="px-4 py-2.5">
                        <MonoKey value={s.provider} head={4} tail={4} />
                      </td>
                      <td className="px-4 py-2.5">
                        <HighWaterMark s={s} />
                      </td>
                      <td className="px-4 py-2.5">
                        <ExpiryCell expiresAt={s.expires_at} settled={s.is_settled} />
                      </td>
                      <td className="px-4 py-2.5">
                        {s.is_settled ? (
                          <Badge variant="info">Settled</Badge>
                        ) : (
                          <Badge variant="allowed">Active</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/verifier?session=${s.session}`}
                          className="inline-flex items-center gap-1 text-[10px] text-[var(--color-cyan)] hover:underline"
                        >
                          {s.evidence_count} evidence
                          <ArrowUpRight className="size-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {loaded && filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-[var(--color-fg-dim)]">
                        No sessions match that filter.
                      </td>
                    </tr>
                  )}
                  {!loaded &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={7} className="px-4 py-3">
                          <div className="h-4 w-full animate-pulse rounded bg-[var(--color-surface-2)]" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ---- live claim feed ---- */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Live claim feed</CardTitle>
              <CardDescription>Signed Ed25519 claims, newest first</CardDescription>
            </div>
            {live === true && (
              <span className="relative inline-flex size-2 rounded-full bg-[var(--color-accent)]">
                <span className="live-dot absolute inset-0" />
              </span>
            )}
          </CardHeader>
          <CardContent className="max-h-[560px] space-y-1.5 overflow-y-auto p-2">
            {decisions.map((d) => (
              <div
                key={`${d.session}-${d.sequence_id}-${d.entry_hash}`}
                className="animate-in-row rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={d.allowed ? "allowed" : "denied"}>
                    {d.allowed ? "ALLOWED" : d.decision.replace(/^ERR_/, "")}
                  </Badge>
                  <span className="text-[10px] text-[var(--color-fg-dim)]">{timeAgo(d.created_at)}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="tnum font-mono text-sm text-[var(--color-fg)]">
                    {formatUsdc(d.cumulative_amount)}
                  </span>
                  <span className="tnum font-mono text-[10px] text-[var(--color-fg-dim)]">
                    seq {d.sequence_id} · nonce {d.nonce}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <MonoKey value={d.session} head={4} tail={4} />
                  <span
                    className="font-mono text-[9px] text-[var(--color-fg-dim)]"
                    title={d.entry_hash}
                  >
                    {d.entry_hash.slice(0, 10)}…
                  </span>
                </div>
              </div>
            ))}
            {decisions.length === 0 && loaded && (
              <p className="py-10 text-center text-xs text-[var(--color-fg-dim)]">
                No decisions recorded yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
