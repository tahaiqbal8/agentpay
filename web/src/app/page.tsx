"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Ban,
  Bot,
  CircleCheck,
  FlaskConical,
  Layers,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PaymentLifecycle } from "@/components/lifecycle";
import { SecurityControls, type ControlState } from "@/components/security-controls";
import { Badge, variantForReason } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/segmented";
import { Stat } from "@/components/ui/stat";
import {
  Table,
  TableSkeleton,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { SearchInput } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import {
  api,
  mock,
  type Agent,
  type Health,
  type RecentDecision,
  type SessionSummary,
} from "@/lib/api";
import { protocolLabel } from "@/lib/constants";
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

/**
 * The consumption bar.
 *
 * The single most important cell on this page: it answers "how much of what
 * the human escrowed has this agent actually spent" without the reader doing
 * arithmetic.
 *
 * `consumedPercent` does its comparison in BigInt and returns a number only
 * for the bar's width. No amount is ever parsed as a float — above 2^53 a
 * JavaScript number rounds, and these are balances.
 */
function HighWaterMark({ s }: { s: SessionSummary }) {
  const pct = consumedPercent(s.cumulative_accepted, s.deposited_total);
  const tone = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "accent";
  const untouched = s.cumulative_accepted === "0";

  // Two lines, not three. The third used to repeat the bar in words ("0.1%
  // consumed") next to a number the first line already implies, and it was
  // the single biggest contributor to a 64px row. What survives is what an
  // operator actually acts on: what has been claimed, out of what, and how
  // much is still spendable. The percentage moves into the bar's accessible
  // label, where it is still announced and still on hover.
  return (
    <div className="min-w-[9rem] space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`t-mono text-[13px] ${
            untouched ? "text-[var(--color-fg-dim)]" : "text-[var(--color-fg)]"
          }`}
        >
          {formatUsdcCompact(s.cumulative_accepted)}
          <span className="text-[var(--color-fg-dim)]">
            {" / "}
            {formatUsdcCompact(s.deposited_total)}
          </span>
        </span>
        <span className="t-support tnum whitespace-nowrap">
          {untouched ? "untouched" : `${formatUsdcCompact(s.remaining)} left`}
        </span>
      </div>
      <Progress
        percent={pct}
        tone={tone}
        label={`${pct.toFixed(1)}% of the escrowed allowance consumed`}
      />
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
  numeric,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  numeric?: boolean;
}) {
  return (
    <TH numeric={numeric} aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : "none"}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors ${
          active ? "text-[var(--color-fg)]" : "hover:text-[var(--color-fg-muted)]"
        }`}
      >
        {label}
        {active &&
          (dir === "desc" ? (
            <ArrowDown aria-hidden="true" className="size-3" />
          ) : (
            <ArrowUp aria-hidden="true" className="size-3" />
          ))}
      </button>
    </TH>
  );
}

/** Only routes that exist. `npm run demo` is a shell script, not a button. */
const QUICK_ACTIONS = [
  { href: "/agents", label: "New agent", hint: "Identity & envelope", icon: Bot },
  { href: "/registry", label: "Registry", hint: "Providers & prices", icon: Store },
  { href: "/verifier", label: "Verify a decision", hint: "Merkle proof", icon: ShieldCheck },
  { href: "/playground", label: "Simulate a claim", hint: "Without spending", icon: FlaskConical },
];

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

  /* ---- what the lifecycle strip and the controls panel are allowed to claim
   *
   * Both draw ticks, so both need a source. These three reads are what turns
   * "Human ✓ Agent ✓ Policy ✓" from a diagram into a status: agents prove the
   * control plane has been used, health proves which protocol and whether a
   * settlement authority exists, and the on-chain root proves the last stage
   * actually happened rather than merely being marked settled locally.
   *
   * They poll far more slowly than the session feed because none of them
   * changes per claim. */
  const [agents, setAgents] = React.useState<Agent[] | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [anchoredRoot, setAnchoredRoot] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const [a, h] = await Promise.all([api.agents(), api.health()]);
      if (cancelled) return;
      setAgents(a.ok ? a.data.agents : null);
      setHealth(h.ok ? h.data : null);
    };
    poll();
    const t = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // The newest settled session, read from the chain. Without this the strip
  // would light "Verified" from a local flag, which is exactly the fabrication
  // this console exists to avoid.
  const newestSettled = React.useMemo(
    () =>
      [...sessions]
        .filter((s) => s.is_settled)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null,
    [sessions]
  );

  React.useEffect(() => {
    if (!newestSettled) {
      setAnchoredRoot(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await api.onChainSettlement(newestSettled.session);
      if (cancelled) return;
      setAnchoredRoot(r.ok && r.data.settled ? (r.data.merkle_root ?? null) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [newestSettled?.session]);

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

  // A refusal and a fault are not the same event, and one KPI covering both
  // taught the reader that refusals are breakage. A policy refusal is the
  // product working; a bad signature or an unreachable dependency is not.
  // `variantForReason` already draws that line for the badges — reuse it here
  // rather than inventing a second definition that can drift.
  const faults = decisions.filter(
    (d) => !d.allowed && variantForReason(d.decision) === "danger"
  ).length;
  const policyRefusals = denials - faults;

  // Escrow that is live, spendable, AND confirmed to exist on chain.
  //
  // `deposited_total` is what the opener asserted. Without reconciliation
  // nothing checked it against a vault, so counting unverified rows would
  // render an asserted number as a held balance.
  const escrowedLive = withStatus
    .filter((x) => x.st.wouldAccept && x.s.chain_verified)
    .reduce((acc, x) => acc + BigInt(x.s.deposited_total), 0n);
  const unconfirmed = withStatus.filter((x) => x.st.wouldAccept && !x.s.chain_verified).length;
  const stranded = withStatus.filter((x) => isStrandedEscrow(x.s));
  const strandedTotal = stranded.reduce((acc, x) => acc + BigInt(x.s.remaining), 0n);
  const committed = sessions.reduce((acc, s) => acc + BigInt(s.cumulative_accepted), 0n);

  const showingFiltered = filter !== "" || statusFilter !== "all";

  /* ---- the lifecycle strip -------------------------------------------------
   *
   * Every stage is a question answered by data already on this page. The
   * stages are cumulative, so `reached` is the last one whose answer is yes —
   * a later stage cannot be true while an earlier one is false, because the
   * protocol cannot reach it.
   *
   * `null` agents (the control plane needs a token this browser may not have)
   * leaves the first three stages unlit rather than assumed. */
  const lifecycleReached = React.useMemo(() => {
    const anyAgent = (agents?.length ?? 0) > 0;
    const anyBound = agents?.some((a) => !!a.agent_pubkey) ?? false;
    const anyPolicy = agents?.some((a) => a.policy !== null) ?? false;
    const anyEscrow = sessions.some((s) => s.chain_verified);
    const anyClaim = sessions.some((s) => BigInt(s.cumulative_accepted) > 0n);
    const anyDecision = decisions.length > 0;
    const anyEvidence = sessions.some((s) => s.evidence_count > 0);
    const anySettled = sessions.some((s) => s.is_settled);
    const anchored = anchoredRoot !== null;

    const answered = [
      anyAgent,
      anyBound,
      anyPolicy,
      anyEscrow,
      anyClaim,
      anyDecision,
      anyEvidence,
      anySettled,
      anchored,
    ];
    let last = -1;
    for (let i = 0; i < answered.length; i++) {
      if (!answered[i]) break;
      last = i;
    }
    return last;
  }, [agents, sessions, decisions, anchoredRoot]);

  /* ---- the controls panel --------------------------------------------------
   *
   * `unknown` wherever the gateway's public surface cannot confirm the answer.
   * Two of these genuinely cannot be read without an operator token, and
   * saying so is more useful than a tick that means "probably". */
  const controls = React.useMemo(() => {
    const agentsKnown = agents !== null;
    const authorized = agents?.filter((a) => a.policy !== null).length ?? 0;
    const verifiedEscrows = sessions.filter((s) => s.chain_verified).length;
    const evidenceEntries = sessions.reduce((n, s) => n + s.evidence_count, 0);

    return [
      {
        label: "Human authorization",
        state: (agentsKnown
          ? authorized > 0
            ? "on"
            : "off"
          : "unknown") as ControlState,
        evidence: agentsKnown
          ? `${authorized} of ${agents!.length} agents carry a spending policy`
          : "Needs an operator token to read the control plane",
      },
      {
        label: "Escrow bound on chain",
        state: (verifiedEscrows > 0 ? "on" : sessions.length ? "off" : "unknown") as ControlState,
        evidence: sessions.length
          ? `${verifiedEscrows} of ${sessions.length} sessions verified against a vault`
          : "No sessions opened yet",
      },
      {
        label: "Signed claims verified",
        state: (decisions.length > 0 ? "on" : "unknown") as ControlState,
        evidence: decisions.length
          ? `${decisions.length} Ed25519 claims decided, ${denials} refused`
          : "No claims submitted yet",
      },
      {
        label: "Evidence chain",
        state: (evidenceEntries > 0 ? "on" : "unknown") as ControlState,
        evidence: evidenceEntries
          ? `${evidenceEntries} decisions hash-chained across ${sessions.length} sessions`
          : "No decisions recorded yet",
      },
      {
        label: "Settlement authority",
        state: (health
          ? health.settlement_authority
            ? "on"
            : "off"
          : "unknown") as ControlState,
        evidence: health?.settlement_authority
          ? `${protocolLabel(health.program_id)} — AgentPay settles without a provider key`
          : health
            ? "Gateway reports no settlement authority"
            : "Gateway not reachable",
      },
    ];
  }, [agents, sessions, decisions, denials, health]);

  return (
    <div className="space-y-5">
      {/* ---- header -------------------------------------------------------
          No name: the browser has no authenticated operator identity, and a
          greeting with a made-up name would be fabricated data on a page whose
          entire claim is that its numbers are real. */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-page brand-gradient-text">Agent payments, enforced and provable</h1>
          {/* What the old line said was "this is a dashboard". It described
              the console, not the product, so a reader who arrived here cold
              learned nothing about what AgentPay does in the ten seconds they
              were willing to give it. These two sentences carry the three
              facts that make this different from a payments dashboard:
              agents spend from a funded escrow, each purchase is admitted or
              refused against a policy, and the record of those decisions ends
              up on Solana where anyone can check it. */}
          <p className="t-body mt-1.5 max-w-3xl">
            Automated clients spend inside an escrow a human funded and bounded. AgentPay admits or refuses
            every purchase against that policy, hash-chains each decision, and anchors the evidence
            root on Solana — so what an agent spent can be proved without trusting this gateway.
          </p>
        </div>
        {/* Wraps, and must. `shrink-0` here held three badges on one line and
            pushed the document 98px past a 375px viewport — the whole page
            scrolled sideways because of a status row. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {live !== null && (
            <Badge variant={live ? "allowed" : "denied"}>
              {live ? "All systems operational" : "Gateway unreachable"}
            </Badge>
          )}
          <Badge variant="info">Solana devnet</Badge>
          {/* Named from /health, so it cannot keep saying V2 while the gateway
              is pointed at the old program. */}
          {health && <Badge variant="agent">{protocolLabel(health.program_id)}</Badge>}
        </div>
      </header>

      {/* ---- level 0: what this system DOES ------------------------------
          Above the metrics on purpose. A reader who has never heard of
          AgentPay needs the shape of the thing before any number about it
          means anything, and this is the only element on the page that
          explains rather than reports. Every stage is lit from data. */}
      <PaymentLifecycle reached={lifecycleReached} />

      {/* ---- level 1: what is happening now ---- */}
      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Active sessions"
          value={String(counts.active)}
          // Zero is a real answer, not a broken one. Say which.
          support={
            counts.active > 0
              ? `${counts.expired} expired · ${counts.settled} settled`
              : counts.all > 0
              ? `none live right now · ${counts.settled} settled, ${counts.expired} expired`
              : "no sessions have been opened yet"
          }
          icon={Layers}
          tone={counts.active > 0 ? "accent" : "neutral"}
        />
        {/* Purple: escrow under a human's policy is the agent-control surface,
            not a plain balance. */}
        <Stat
          label="Escrowed"
          value={formatUsdcCompact(escrowedLive)}
          support={
            unconfirmed > 0
              ? `confirmed on chain · ${unconfirmed} unconfirmed excluded`
              : escrowedLive > 0n
              ? "confirmed on chain, still accepting"
              : "nothing is currently accepting claims"
          }
          icon={Wallet}
          tone={unconfirmed > 0 ? "warn" : "agent"}
        />
        <Stat
          label="Claimed cumulative"
          value={formatUsdcCompact(committed)}
          support="across all sessions"
          icon={CircleCheck}
          tone="cyan"
        />
        {/* Not "denial rate". A refusal is an enforcement decision — a
            policy cap, or a protocol invariant like a replayed claim — and a
            metric named like a failure rate trains an operator to read the
            product working as the product breaking. Faults are counted
            separately because those really are breakage. Left as "Refused"
            rather than "Refused by policy" because a replay is refused by the
            protocol, not by anybody's policy. */}
        <Stat
          label="Refused"
          value={`${denialRate}%`}
          support={
            decisions.length === 0
              ? "no decisions recorded yet"
              : faults > 0
              ? `${policyRefusals} refused of last ${decisions.length} · ${faults} fault${
                  faults === 1 ? "" : "s"
                }`
              : `${policyRefusals} of last ${decisions.length} — enforcement, not errors`
          }
          icon={Ban}
          tone={faults > 0 ? "danger" : denials > 0 ? "warn" : "neutral"}
        />
      </section>

      {/* ---- level 2: what needs attention --------------------------------
          Amber, not red: escrow sitting past expiry is a thing to do, not a
          fault. No refund button — the gateway exposes no refund endpoint, and
          a dead control would be worse than none. */}
      {stranded.length > 0 && (
        <Card accent="warn" className="p-3">
          <div className="flex flex-wrap items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--color-warn)]">
                {stranded.length} expired session{stranded.length === 1 ? "" : "s"} still holding{" "}
                {formatUsdcCompact(strandedTotal)} USDC
              </p>
              <p className="t-support mt-1 max-w-3xl">
                After expiry <code className="font-mono">refund_session</code> is permissionless —
                anyone can return these funds to the agent. Until someone calls it, the escrow just
                sits there. This console does not trigger refunds.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setStatusFilter("expired");
                setFilter("");
              }}
            >
              View expired sessions
              <ArrowRight aria-hidden="true" className="size-3" />
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* ---- level 3: sessions, the dominant surface ----
            `min-w-0`: a grid item sizes to its content by default, so the
            table's minimum width would widen the whole page instead of
            scrolling inside `TableWrap`. */}
        <Card className="min-w-0">
          <CardHeader className="flex-wrap gap-3">
            <div>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>High-water mark against escrowed allowance</CardDescription>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="t-label">Total</span>
              <span className="tnum text-sm font-semibold text-[var(--color-fg)]">
                {counts.all}
              </span>
            </div>
          </CardHeader>

          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "active", label: "Active", count: counts.active },
                { value: "expired", label: "Expired", count: counts.expired },
                { value: "settled", label: "Settled", count: counts.settled },
              ]}
            />
            <SearchInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by agent pubkey, session…"
              aria-label="Filter sessions by agent pubkey or session address"
              className="ml-auto w-full sm:w-64"
            />
          </div>

          <CardContent className="p-0">
            <TableWrap aria-label="Sessions">
              {/* Below this width the columns start crushing each other and
                  the bar becomes unreadable. Scrolling the table inside its
                  own card is better than shrinking the numbers. */}
              <Table className="min-w-[46rem]">
                <THead>
                  <TR>
                    <SortHeader
                      label="Session"
                      active={sortKey === "created"}
                      dir={sortDir}
                      onClick={() => toggleSort("created")}
                    />
                    <TH>Agent</TH>
                    <SortHeader
                      label="High-water mark"
                      active={sortKey === "consumed"}
                      dir={sortDir}
                      onClick={() => toggleSort("consumed")}
                    />
                    <TH>Expiry</TH>
                    <TH>Status</TH>
                    <SortHeader
                      label="Evidence"
                      numeric
                      active={sortKey === "evidence"}
                      dir={sortDir}
                      onClick={() => toggleSort("evidence")}
                    />
                    <TH numeric>Actions</TH>
                  </TR>
                </THead>

                {!loaded ? (
                  <TableSkeleton rows={6} cols={7} />
                ) : (
                  <TBody>
                    {rows.map(({ s, st }) => {
                      const { label, expired, urgent } = expiryCountdown(s.expires_at);
                      return (
                        <TR key={s.session} interactive>
                          <TD className="whitespace-nowrap">
                            <Link
                              href={`/session/${s.session}`}
                              className="t-mono text-[var(--color-fg-muted)] hover:text-[var(--color-cyan)] hover:underline"
                              title={s.session}
                            >
                              {s.session.slice(0, 6)}…{s.session.slice(-6)}
                            </Link>
                          </TD>
                          <TD>
                            <MonoKey value={s.agent} head={4} tail={4} />
                          </TD>
                          <TD>
                            <HighWaterMark s={s} />
                          </TD>
                          <TD>
                            <span
                              className={
                                st.status === "settled"
                                  ? "t-support"
                                  : expired
                                  ? "t-mono text-[var(--color-fg-dim)]"
                                  : urgent
                                  ? "t-mono text-[var(--color-warn)]"
                                  : "t-mono text-[var(--color-fg-muted)]"
                              }
                            >
                              {st.status === "settled" ? "—" : label}
                            </span>
                          </TD>
                          <TD>
                            <span
                              title={
                                st.reasonIfRefused
                                  ? `A claim now would return ${st.reasonIfRefused}`
                                  : "Accepting claims"
                              }
                            >
                              <Badge variant={st.tone}>{st.label}</Badge>
                            </span>
                          </TD>
                          <TD numeric>
                            {s.evidence_count > 0 ? (
                              <Link
                                href={`/verifier?session=${s.session}`}
                                className="tnum inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                                title={`${s.evidence_count} recorded decisions — open in the verifier`}
                              >
                                {s.evidence_count}
                                <ShieldCheck aria-hidden="true" className="size-3" />
                              </Link>
                            ) : (
                              <span className="t-support">none</span>
                            )}
                          </TD>
                          <TD numeric>
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/session/${s.session}`}>View</Link>
                            </Button>
                          </TD>
                        </TR>
                      );
                    })}

                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-14 text-center">
                          <p className="text-xs text-[var(--color-fg-muted)]">
                            {showingFiltered
                              ? "No sessions match this filter."
                              : "No sessions tracked yet."}
                          </p>
                          <p className="t-support mx-auto mt-1 max-w-sm">
                            {showingFiltered ? (
                              "Clear the filter to see every session the gateway knows about."
                            ) : (
                              <>
                                A session appears once an escrow is opened on chain and registered
                                with the gateway. Run{" "}
                                <code className="font-mono text-[var(--color-cyan)]">
                                  npm run sdk-demo
                                </code>{" "}
                                to create one.
                              </>
                            )}
                          </p>
                          {showingFiltered && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3"
                              onClick={() => {
                                setFilter("");
                                setStatusFilter("all");
                              }}
                            >
                              Clear filter
                            </Button>
                          )}
                        </td>
                      </tr>
                    )}
                  </TBody>
                )}
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        {/* ---- level 3/4: what happened, and where to investigate ---- */}
        <div className="space-y-4">
          {/* The five things that make this a security product rather than a
              payments dashboard. First in the column because it answers "why
              should I believe any of this" before the numbers arrive. */}
          <SecurityControls controls={controls} />

          {/* Escrow summary. No single "escrow wallet" exists — every session
              has its own vault PDA — so this summarises rather than pretending
              to be one address, and links to the filter instead of a refund
              control the gateway does not expose. */}
          <Card accent={stranded.length > 0 ? "warn" : "agent"}>
            <CardHeader>
              <div>
                <CardTitle>Escrow</CardTitle>
                <CardDescription>One vault per session, held by the program</CardDescription>
              </div>
              <Wallet aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
            </CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="t-label">Live, confirmed</span>
                <span className="tnum font-mono text-sm text-[var(--color-agent)]">
                  {formatUsdcCompact(escrowedLive)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="t-label">Claimed</span>
                <span className="tnum font-mono text-sm text-[var(--color-cyan)]">
                  {formatUsdcCompact(committed)}
                </span>
              </div>
              {stranded.length > 0 && (
                <div className="flex items-baseline justify-between gap-2 border-t border-[var(--color-border)] pt-2.5">
                  <span className="t-label">Past expiry</span>
                  <span className="tnum font-mono text-sm text-[var(--color-warn)]">
                    {formatUsdcCompact(strandedTotal)}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-wrap gap-2">
              <div>
                <CardTitle>Recent decisions</CardTitle>
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
                  <span
                    title="Live — polling the gateway"
                    className="relative inline-flex size-2 rounded-full bg-[var(--color-accent)]"
                  >
                    <span className="live-dot absolute inset-0" />
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="max-h-[520px] space-y-1.5 overflow-y-auto p-2">
              {feed.map((d) => {
                // Anything older than an hour is history, not live traffic.
                const stale = Date.now() - Date.parse(d.created_at) > 3_600_000;
                // Amber for a decision, red only for a forged claim or a
                // failed dependency. See `variantForReason`.
                const tone = variantForReason(d.allowed ? "ALLOWED" : d.decision);
                const edge =
                  tone === "allowed"
                    ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    : tone === "danger"
                    ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
                    : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]";
                return (
                  <div
                    key={`${d.session}-${d.sequence_id}-${d.entry_hash}`}
                    className={`animate-in-row rounded-md border p-2.5 ${edge} ${
                      stale ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span title={DECISION_WHY[d.decision] ?? d.decision}>
                        <Badge variant={tone}>
                          {DECISION_LABEL[d.decision] ?? d.decision.replace(/^ERR_/, "")}
                        </Badge>
                      </span>
                      <time
                        dateTime={d.created_at}
                        className="t-support"
                        title={new Date(d.created_at).toLocaleString()}
                      >
                        {timeAgo(d.created_at)}
                      </time>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between gap-2">
                      <span className="tnum font-mono text-sm text-[var(--color-fg)]">
                        {formatUsdc(d.cumulative_amount)}
                      </span>
                      <span className="t-mono text-[var(--color-fg-dim)]">
                        seq {d.sequence_id} · nonce {d.nonce}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <Link
                        href={`/session/${d.session}`}
                        className="t-mono text-[var(--color-fg-dim)] hover:text-[var(--color-cyan)]"
                        title={d.session}
                      >
                        {d.session.slice(0, 4)}…{d.session.slice(-4)}
                      </Link>
                      <Link
                        href={`/verifier?session=${d.session}`}
                        className="t-mono text-[var(--color-fg-dim)] hover:text-[var(--color-cyan)]"
                        title={`${d.entry_hash} — open in the verifier`}
                      >
                        {d.entry_hash.slice(0, 10)}…
                      </Link>
                    </div>
                  </div>
                );
              })}

              {!loaded &&
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-[4.5rem] rounded-md" />
                ))}

              {feed.length === 0 && loaded && (
                <div className="py-12 text-center">
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {feedFilter === "denied"
                      ? "Nothing has been refused yet."
                      : "No decisions recorded yet."}
                  </p>
                  <p className="t-support mx-auto mt-1 max-w-[16rem]">
                    {feedFilter === "denied"
                      ? "Every claim the gateway has seen was within its agent's envelope."
                      : "Decisions appear here as agents present signed claims."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quick actions</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 p-2">
              {QUICK_ACTIONS.map(({ href, label, hint, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="interactive flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 hover:border-[var(--color-border-bright)]"
                >
                  <Icon aria-hidden="true" className="mt-0.5 size-3.5 text-[var(--color-fg-dim)]" />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--color-fg)]">
                      {label}
                    </span>
                    <span className="t-support block truncate">{hint}</span>
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
