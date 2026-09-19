"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  CircleCheck,
  Layers,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/segmented";
import { MonoKey } from "@/components/mono";
import { Input } from "@/components/ui/input";
import { api, mock, type RecentDecision, type SessionSummary } from "@/lib/api";
import { DECISION_LABEL, DECISION_WHY } from "@/lib/constants";
import { isStrandedEscrow, sessionStatus } from "@/lib/session-status";
import {
  consumedPercent,
  expiryCountdown,
  formatUsdc,
  formatUsdcCompact,
  timeAgo,
} from "@/lib/format";

type StatusFilter = "all" | "active" | "expired" | "settled";
type FeedFilter = "all" | "allowed" | "denied";
type SortKey = "created" | "consumed" | "deposit" | "evidence";

function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon: React.ElementType;
  tone?: "default" | "accent" | "warn" | "danger";
}) {
  const chip =
    tone === "accent"
      ? "bg-[#10b9811a] text-[var(--color-accent)]"
      : tone === "warn"
      ? "bg-[#f59e0b1a] text-[var(--color-warn)]"
      : tone === "danger"
      ? "bg-[#ef44441a] text-[var(--color-danger)]"
      : "bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]";
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-3">
        <div className={`grid size-8 shrink-0 place-items-center rounded ${chip}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">{label}</p>
          <p className="tnum truncate text-lg font-semibold leading-tight">{value}</p>
          {sub && <div className="truncate text-[10px] text-[var(--color-fg-dim)]">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function HighWaterMark({ s }: { s: SessionSummary }) {
  const pct = consumedPercent(s.cumulative_accepted, s.deposited_total);
  const tone = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "accent";
  const untouched = s.cumulative_accepted === "0";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`tnum font-mono text-xs ${
            untouched ? "text-[var(--color-fg-dim)]" : "text-[var(--color-fg)]"
          }`}
        >
          {formatUsdcCompact(s.cumulative_accepted)}
        </span>
        <span className="tnum font-mono text-[10px] text-[var(--color-fg-dim)]">
          / {formatUsdcCompact(s.deposited_total)}
        </span>
      </div>
      <Progress percent={pct} tone={tone} />
      <div className="flex justify-between text-[10px] text-[var(--color-fg-dim)]">
        <span>{untouched ? "no claims yet" : `${pct.toFixed(1)}% consumed`}</span>
        <span className="tnum">{formatUsdcCompact(s.remaining)} left</span>
      </div>
    </div>
  );
}

/** Ticks every second so countdowns and expiry transitions are live. */
function useNowSecs(): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={className}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 font-medium transition-colors ${
          active ? "text-[var(--color-fg)]" : "hover:text-[var(--color-fg-muted)]"
        }`}
      >
        {label}
        {active &&
          (dir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </th>
  );
}

export default function MonitorPage() {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [decisions, setDecisions] = React.useState<RecentDecision[]>([]);
  const [live, setLive] = React.useState<boolean | null>(null);
  const [filter, setFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [feedFilter, setFeedFilter] = React.useState<FeedFilter>("all");
  const [sortKey, setSortKey] = React.useState<SortKey>("created");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [loaded, setLoaded] = React.useState(false);
  const nowSecs = useNowSecs();

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

  const withStatus = React.useMemo(
    () => sessions.map((s) => ({ s, st: sessionStatus(s, nowSecs) })),
    [sessions, nowSecs]
  );

  const counts = React.useMemo(
    () => ({
      all: withStatus.length,
      active: withStatus.filter((x) => x.st.status === "active" || x.st.status === "expiring")
        .length,
      expired: withStatus.filter((x) => x.st.status === "expired").length,
      settled: withStatus.filter((x) => x.st.status === "settled").length,
    }),
    [withStatus]
  );

  const rows = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = withStatus.filter(({ s, st }) => {
      if (statusFilter === "active" && st.status !== "active" && st.status !== "expiring")
        return false;
      if (statusFilter === "expired" && st.status !== "expired") return false;
      if (statusFilter === "settled" && st.status !== "settled") return false;
      if (!q) return true;
      return (
        s.session.toLowerCase().includes(q) ||
        s.agent.toLowerCase().includes(q) ||
        s.provider.toLowerCase().includes(q)
      );
    });

    const dir = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      switch (sortKey) {
        case "consumed":
          return (
            dir *
            (consumedPercent(a.s.cumulative_accepted, a.s.deposited_total) -
              consumedPercent(b.s.cumulative_accepted, b.s.deposited_total))
          );
        case "deposit": {
          const d = BigInt(a.s.deposited_total) - BigInt(b.s.deposited_total);
          return dir * (d > 0n ? 1 : d < 0n ? -1 : 0);
        }
        case "evidence":
          return dir * (a.s.evidence_count - b.s.evidence_count);
        default:
          return dir * (Date.parse(a.s.created_at) - Date.parse(b.s.created_at));
      }
    });
  }, [withStatus, filter, statusFilter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const feed = React.useMemo(
    () =>
      decisions.filter((d) =>
        feedFilter === "allowed" ? d.allowed : feedFilter === "denied" ? !d.allowed : true
      ),
    [decisions, feedFilter]
  );

  const denials = decisions.filter((d) => !d.allowed).length;
  const denialRate = decisions.length ? Math.round((denials / decisions.length) * 100) : 0;

  // Escrow that is live, spendable, AND confirmed to exist on chain.
  //
  // `deposited_total` is what the opener asserted. Without reconciliation
  // nothing checked it against a vault, so counting unverified rows would
  // render an asserted number as a held balance.
  const escrowedLive = withStatus
    .filter((x) => x.st.wouldAccept && x.s.chain_verified)
    .reduce((acc, x) => acc + BigInt(x.s.deposited_total), 0n);
  const unconfirmed = withStatus.filter(
    (x) => x.st.wouldAccept && !x.s.chain_verified
  ).length;
  const stranded = withStatus.filter((x) => isStrandedEscrow(x.s));
  const strandedTotal = stranded.reduce((acc, x) => acc + BigInt(x.s.remaining), 0n);
  const committed = sessions.reduce((acc, s) => acc + BigInt(s.cumulative_accepted), 0n);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Accepting claims"
          value={String(counts.active)}
          sub={`${counts.expired} expired · ${counts.settled} settled`}
          icon={Layers}
          tone={counts.active > 0 ? "accent" : "default"}
        />
        <Stat
          label="Escrowed (live)"
          value={formatUsdcCompact(escrowedLive)}
          sub={
            unconfirmed > 0
              ? `confirmed on chain · ${unconfirmed} unconfirmed excluded`
              : "confirmed on chain, still accepting"
          }
          icon={Wallet}
          tone={unconfirmed > 0 ? "warn" : "default"}
        />
        <Stat
          label="Claimed cumulative"
          value={formatUsdcCompact(committed)}
          sub="across all sessions"
          icon={CircleCheck}
          tone="accent"
        />
        <Stat
          label="Denial rate"
          value={`${denialRate}%`}
          sub={`${denials} of last ${decisions.length} decisions`}
          icon={Ban}
          tone={denials > 0 ? "warn" : "default"}
        />
      </div>

      {/* Expired sessions still holding escrow are actionable, so say so. */}
      {stranded.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b1a] px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]" />
          <p className="text-xs text-[var(--color-warn)]">
            <strong className="font-semibold">
              {stranded.length} expired session{stranded.length === 1 ? "" : "s"} still holding{" "}
              {formatUsdcCompact(strandedTotal)} USDC.
            </strong>{" "}
            <span className="text-[var(--color-fg-muted)]">
              After expiry <code className="font-mono">refund_session</code> is permissionless —
              anyone can return these funds to the agent. Until someone calls it, the escrow just
              sits there.
            </span>
          </p>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        {/* ---- sessions ---- */}
        <Card>
          <CardHeader className="flex-wrap gap-2">
            <div>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>High-water mark against escrowed allowance</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "active", label: "Accepting", count: counts.active },
                  { value: "expired", label: "Expired", count: counts.expired },
                  { value: "settled", label: "Settled", count: counts.settled },
                ]}
              />
              <Input
                placeholder="Filter by pubkey…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 w-[160px] font-mono text-xs"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                  <tr>
                    <SortHeader
                      label="Session"
                      active={sortKey === "created"}
                      dir={sortDir}
                      onClick={() => toggleSort("created")}
                      className="px-4 py-2"
                    />
                    <th className="px-4 py-2 font-medium">Agent</th>
                    <SortHeader
                      label="High-water mark"
                      active={sortKey === "consumed"}
                      dir={sortDir}
                      onClick={() => toggleSort("consumed")}
                      className="w-[190px] px-4 py-2"
                    />
                    <th className="px-4 py-2 font-medium">Expiry</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <SortHeader
                      label="Evidence"
                      active={sortKey === "evidence"}
                      dir={sortDir}
                      onClick={() => toggleSort("evidence")}
                      className="px-4 py-2 text-right"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {rows.map(({ s, st }) => {
                    const { label, expired, urgent } = expiryCountdown(s.expires_at);
                    return (
                      <tr key={s.session} className="group hover:bg-[var(--color-surface-2)]">
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/session/${s.session}`}
                            className="font-mono text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-cyan)] hover:underline"
                            title={s.session}
                          >
                            {s.session.slice(0, 6)}…{s.session.slice(-6)}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <MonoKey value={s.agent} head={4} tail={4} />
                        </td>
                        <td className="px-4 py-2.5">
                          <HighWaterMark s={s} />
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              st.status === "settled"
                                ? "text-[10px] text-[var(--color-fg-dim)]"
                                : expired
                                ? "tnum font-mono text-[11px] text-[var(--color-fg-dim)]"
                                : urgent
                                ? "tnum font-mono text-[11px] text-[var(--color-warn)]"
                                : "tnum font-mono text-[11px] text-[var(--color-fg-muted)]"
                            }
                          >
                            {st.status === "settled" ? "—" : label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            title={
                              st.reasonIfRefused
                                ? `A claim now would return ${st.reasonIfRefused}`
                                : "Accepting claims"
                            }
                          >
                            <Badge variant={st.tone}>{st.label}</Badge>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {s.evidence_count > 0 ? (
                            <Link
                              href={`/verifier?session=${s.session}`}
                              className="tnum inline-flex items-center gap-1 text-[11px] text-[var(--color-cyan)] hover:underline"
                            >
                              {s.evidence_count}
                              <ShieldAlert className="size-3" />
                            </Link>
                          ) : (
                            <span className="text-[10px] text-[var(--color-fg-dim)]">none</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {loaded && rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center">
                        <p className="text-xs text-[var(--color-fg-muted)]">
                          {filter || statusFilter !== "all"
                            ? "No sessions match this filter."
                            : "No sessions tracked yet."}
                        </p>
                        {!filter && statusFilter === "all" && (
                          <p className="mt-1 text-[10px] text-[var(--color-fg-dim)]">
                            Run{" "}
                            <code className="font-mono text-[var(--color-cyan)]">npm run demo</code>{" "}
                            to generate traffic.
                          </p>
                        )}
                      </td>
                    </tr>
                  )}

                  {!loaded &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={6} className="px-4 py-3">
                          <div className="h-4 w-full animate-pulse rounded bg-[var(--color-surface-2)]" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ---- feed ---- */}
        <Card>
          <CardHeader className="flex-wrap gap-2">
            <div>
              <CardTitle>Claim feed</CardTitle>
              <CardDescription>Signed Ed25519 claims, newest first</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Segmented
                value={feedFilter}
                onChange={setFeedFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "allowed", label: "Allowed" },
                  { value: "denied", label: "Denied", count: denials },
                ]}
              />
              {live === true && (
                <span className="relative inline-flex size-2 rounded-full bg-[var(--color-accent)]">
                  <span className="live-dot absolute inset-0" />
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="max-h-[620px] space-y-1.5 overflow-y-auto p-2">
            {feed.map((d) => {
              // Anything older than an hour is history, not live traffic.
              const stale = Date.now() - Date.parse(d.created_at) > 3_600_000;
              return (
                <div
                  key={`${d.session}-${d.sequence_id}-${d.entry_hash}`}
                  className={`animate-in-row rounded-md border p-2.5 ${
                    d.allowed
                      ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                      : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
                  } ${stale ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span title={DECISION_WHY[d.decision] ?? d.decision}>
                      <Badge variant={d.allowed ? "allowed" : "denied"}>
                        {DECISION_LABEL[d.decision] ?? d.decision.replace(/^ERR_/, "")}
                      </Badge>
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-dim)]">
                      {timeAgo(d.created_at)}
                    </span>
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
                    <Link
                      href={`/session/${d.session}`}
                      className="font-mono text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-cyan)]"
                      title={d.session}
                    >
                      {d.session.slice(0, 4)}…{d.session.slice(-4)}
                    </Link>
                    <Link
                      href={`/verifier?session=${d.session}`}
                      className="font-mono text-[9px] text-[var(--color-fg-dim)] hover:text-[var(--color-cyan)]"
                      title={`${d.entry_hash} — click to verify`}
                    >
                      {d.entry_hash.slice(0, 10)}…
                    </Link>
                  </div>
                </div>
              );
            })}

            {feed.length === 0 && loaded && (
              <p className="py-12 text-center text-xs text-[var(--color-fg-dim)]">
                {feedFilter === "denied"
                  ? "No denials recorded — nothing has been refused yet."
                  : "No decisions recorded yet."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
