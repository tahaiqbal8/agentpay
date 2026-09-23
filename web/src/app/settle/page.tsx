"use client";

import * as React from "react";
import {
  Check,
  Coins,
  ExternalLink,
  Landmark,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonRows } from "@/components/empty-state";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type Health, type SessionSummary } from "@/lib/api";
import { protocolLabel } from "@/lib/constants";
import { sessionStatus } from "@/lib/session-status";
import {
  consumedPercent,
  explorerAddress,
  explorerTx,
  formatUsdc,
  formatUsdcCompact,
  truncateKey,
} from "@/lib/format";

interface SettleResult {
  signature: string;
  merkle_root: string;
  evidence_entries: number;
  cumulative_amount: string;
  settlement_record: string;
  provider_token_account: string;
}

/**
 * Three things must hold before settlement is even possible.
 *
 * `!is_settled` alone is not enough:
 *  - `settle_session` refuses once expiry plus skew has passed, and
 *  - a session the gateway has not confirmed against the chain may have no
 *    escrow account behind it, so there may be nothing to settle from.
 *
 * Listing either kind here would offer an action the program can only reject.
 */
function settleable(s: SessionSummary): boolean {
  if (!s.chain_verified) return false;
  const st = sessionStatus(s).status;
  return st === "active" || st === "expiring";
}

/**
 * Unverified sessions worth re-checking against the chain.
 *
 * `chain_verified` is a snapshot from the moment the session was opened. If
 * reconciliation was off then, the flag is false because nobody looked — NOT
 * because the escrow is missing. Treating those as unbacked hides genuinely
 * settleable sessions, so anything still inside its window gets offered for a
 * fresh look. Expired ones are excluded: verifying them changes nothing,
 * since `settle_session` refuses past expiry either way.
 */
function recheckable(s: SessionSummary): boolean {
  if (s.chain_verified || s.is_settled) return false;
  const st = sessionStatus(s).status;
  return st === "active" || st === "expiring";
}

/** One of the three big numbers in the hero card. */
function Figure({
  label,
  value,
  tone = "fg",
}: {
  label: string;
  value: string;
  tone?: "fg" | "accent" | "agent";
}) {
  const colour = {
    fg: "text-[var(--color-fg)]",
    accent: "text-[var(--color-accent)]",
    agent: "text-[var(--color-agent)]",
  }[tone];
  return (
    <div>
      <p className="t-label">{label}</p>
      <p className={`tnum mt-1.5 text-[22px] font-semibold leading-none ${colour}`}>{value}</p>
    </div>
  );
}

function KeyRow({
  label,
  value,
  href,
  note,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-border)] py-2.5 last:border-0">
      <span className="t-label">{label}</span>
      {value ? (
        <span className="min-w-0 text-right">
          <MonoKey value={value} href={href} head={6} tail={6} />
          {note && <span className="t-support mt-0.5 block">{note}</span>}
        </span>
      ) : (
        <span className="t-support">Not available</span>
      )}
    </div>
  );
}

export default function SettlePage() {
  const toast = useToast();
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  // Kept separately so we can explain WHY they are not offered, rather than
  // silently hiding them and leaving the operator to wonder.
  const [unverified, setUnverified] = React.useState<SessionSummary[]>([]);
  const [selected, setSelected] = React.useState<SessionSummary | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<SettleResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  /** The committed root, read from the chain. `undefined` = not looked up. */
  const [chainRoot, setChainRoot] = React.useState<string | null | undefined>(undefined);
  /** The session a result belongs to, remembered across the `setSelected(null)`
   *  that follows a successful settlement. */
  const settledSession = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const [res, h] = await Promise.all([api.sessions(), api.health()]);
    setLoaded(true);
    if (h.ok) setHealth(h.data);
    if (!res.ok) return;
    setSessions(res.data.sessions.filter(settleable));
    setUnverified(res.data.sessions.filter((s) => !s.chain_verified && !s.is_settled));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /* After a settlement, read the root back FROM THE CHAIN rather than trusting
     the value the settle response returned. The two agreeing is the claim this
     page makes; asserting it from one source would not be a check. */
  React.useEffect(() => {
    if (!result) {
      setChainRoot(undefined);
      return;
    }
    const session = settledSession.current;
    if (!session) return;
    let cancelled = false;
    (async () => {
      const r = await api.onChainSettlement(session);
      if (cancelled) return;
      setChainRoot(r.ok && r.data.settled ? (r.data.merkle_root ?? null) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [result]);

  /**
   * Asks the gateway to look at the chain for each unverified session.
   *
   * The gateway re-verifies the stored record field by field, so a row that was
   * invented under AGENTPAY_TRUST_OPEN_REQUESTS cannot talk its way to
   * verified — it is refused exactly as it would have been at open.
   */
  const recheck = async () => {
    const candidates = unverified.filter(recheckable);
    if (candidates.length === 0) return;
    setChecking(true);
    let confirmed = 0;
    for (const s of candidates) {
      const res = await api.reconcile(s.session);
      if (res.ok) confirmed++;
    }
    await load();
    setChecking(false);
    toast(
      confirmed > 0
        ? {
            kind: "success",
            title: `${confirmed} of ${candidates.length} confirmed on chain`,
            body: "Now settleable.",
          }
        : {
            kind: "error",
            title: "None had an escrow on chain",
            body: `${candidates.length} checked, ${candidates.length} refused.`,
          }
    );
  };

  const settle = async () => {
    if (!selected) return;
    settledSession.current = selected.session;
    setBusy(true);
    setErr(null);
    setResult(null);
    const res = await api.settle(selected.session);
    setBusy(false);
    if (!res.ok) {
      setErr(`${res.error.reason_code} — ${res.error.message}`);
      toast({ kind: "error", title: "Settlement refused", body: res.error.reason_code });
      return;
    }
    setResult(res.data);
    toast({
      kind: "success",
      title: "Settled on devnet",
      body: res.data.signature.slice(0, 32) + "…",
    });
    void load();
    setSelected(null);
  };

  const recheckCount = unverified.filter(recheckable).length;

  // Settlement pays the highest claim; the remainder is refundable to the agent.
  const refundable = selected
    ? (BigInt(selected.deposited_total) - BigInt(selected.cumulative_accepted)).toString()
    : "0";

  // Totals across what is settleable right now. Derived from the same rows the
  // list shows — nothing here is fetched separately, so the summary cannot
  // disagree with the list beneath it.
  const claimsTotal = sessions.reduce((a, s) => a + BigInt(s.cumulative_accepted), 0n);
  const heldTotal = sessions.reduce((a, s) => a + BigInt(s.deposited_total), 0n);
  const remainderTotal = heldTotal - claimsTotal;

  const rootAgrees = !!result && chainRoot !== undefined && chainRoot === result.merkle_root;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-page brand-gradient-text">Settlement</h1>
          <p className="t-body mt-1.5 max-w-2xl">
            Move verified agent spending from escrow to the provider, and commit the evidence root
            that justifies it — in one transaction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">Solana devnet</Badge>
          {health && <Badge variant="agent">{protocolLabel(health.program_id)}</Badge>}
        </div>
      </header>

      <section aria-label="Settleable totals" className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <Stat
          label="Settleable now"
          value={String(sessions.length)}
          support="confirmed on chain, inside expiry"
          icon={Landmark}
          tone={sessions.length > 0 ? "accent" : "neutral"}
        />
        <Stat
          label="Claims to settle"
          value={formatUsdcCompact(claimsTotal)}
          support="would move to providers"
          icon={Coins}
          tone="cyan"
        />
        <Stat
          label="Remainder"
          value={formatUsdcCompact(remainderTotal)}
          support="stays in the vaults, refundable to agents"
          icon={Undo2}
          tone="agent"
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {/* ---- what can be settled ---- */}
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>Settleable sessions</CardTitle>
              <CardDescription>Unsettled and still inside their expiry window</CardDescription>
            </div>
            <Badge variant="neutral">{sessions.length}</Badge>
          </CardHeader>
          <CardContent className="max-h-[560px] space-y-2 overflow-y-auto p-2">
            {!loaded && <SkeletonRows rows={4} className="p-2" />}

            {sessions.map((s) => {
              const active = selected?.session === s.session;
              const pct = consumedPercent(s.cumulative_accepted, s.deposited_total);
              return (
                <button
                  key={s.session}
                  aria-pressed={active}
                  onClick={() => {
                    setSelected(s);
                    setResult(null);
                    setErr(null);
                  }}
                  className={`interactive w-full rounded-lg border p-3 text-left ${
                    active
                      ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    {/* Plain text, not `MonoKey`: that component carries its
                        own copy button, and a button inside this button is
                        invalid HTML — React refuses to hydrate it. The full
                        key stays copyable from the breakdown panel. */}
                    <span className="t-mono text-[var(--color-fg-muted)]" title={s.session}>
                      {truncateKey(s.session, 6, 6)}
                    </span>
                    <span className="tnum text-[13px] text-[var(--color-fg)]">
                      {formatUsdc(s.cumulative_accepted)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Progress
                      percent={pct}
                      tone={active ? "accent" : "cyan"}
                      label={`${pct.toFixed(1)}% of this escrow has been claimed`}
                    />
                  </div>
                  <p className="t-support mt-1.5">
                    {s.evidence_count} evidence entries · deposit {formatUsdc(s.deposited_total)}
                  </p>
                </button>
              );
            })}

            {loaded && sessions.length === 0 && (
              <EmptyState
                icon={Landmark}
                title="No sessions can be settled right now"
                body="A session appears here once its escrow is confirmed on chain, it holds at least one accepted claim, and it is still inside its expiry window."
              />
            )}

            {unverified.length > 0 && (
              <div className="mt-2 rounded-lg border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-3">
                <p className="flex items-start gap-1.5 text-[13px] font-semibold text-[var(--color-warn)]">
                  <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  {unverified.length} session{unverified.length === 1 ? "" : "s"} not shown — escrow
                  never confirmed
                </p>
                <p className="t-support mt-1.5">
                  These were opened while{" "}
                  <code className="font-mono">AGENTPAY_TRUST_OPEN_REQUESTS=1</code> was set, so the
                  gateway never checked whether a vault exists. That is not the same as saying there
                  is none — nobody looked. Until one does,{" "}
                  <code className="font-mono">settle_session</code> could fail, so they are not
                  offered here.
                </p>
                {recheckCount > 0 ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 w-full"
                      onClick={recheck}
                      disabled={checking}
                    >
                      {checking ? (
                        <>
                          <Loader2 className="size-3 animate-spin" /> Reading {recheckCount} account
                          {recheckCount === 1 ? "" : "s"}…
                        </>
                      ) : (
                        <>Check {recheckCount} against the chain</>
                      )}
                    </Button>
                    <p className="t-support mt-1.5">
                      Each stored record is re-verified field by field, so an invented session stays
                      refused. The other {unverified.length - recheckCount} have expired — checking
                      them changes nothing.
                    </p>
                  </>
                ) : (
                  <p className="t-support mt-1.5">
                    All of them have expired, so verifying would change nothing. For a fresh
                    settleable session, run{" "}
                    <code className="font-mono text-[var(--color-cyan)]">npm run demo:v2</code>.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- the money, and the proof ---- */}
        <div className="min-w-0 space-y-4">
          {/* State 1 of 3: nothing chosen. */}
          {!selected && !result && (
            <Card>
              <EmptyState
                icon={Landmark}
                title="No settlement yet"
                body="Choose a session on the left to see exactly what would move, and to whom. Nothing is submitted until you confirm."
              />
            </Card>
          )}

          {/* State 2 of 3: a live session, not yet settled. */}
          {selected && !result && (
            <div className="surface-hero rounded-xl p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">Session active</Badge>
                <span className="t-support ml-auto">Nothing has moved yet</span>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3">
                <Figure label="Deposited" value={formatUsdc(selected.deposited_total)} />
                <Figure
                  label="Would settle"
                  value={formatUsdc(selected.cumulative_accepted)}
                  tone="accent"
                />
                <Figure label="Would remain" value={formatUsdc(refundable)} tone="agent" />
              </div>

              <div className="mt-4">
                <Progress
                  percent={consumedPercent(selected.cumulative_accepted, selected.deposited_total)}
                  tone="accent"
                  label="Share of the escrow this settlement would move"
                />
              </div>

              <dl className="mt-5">
                <KeyRow
                  label="Session"
                  value={selected.session}
                  href={explorerAddress(selected.session)}
                />
                <KeyRow
                  label="Provider"
                  value={selected.provider}
                  href={explorerAddress(selected.provider)}
                  note="Bound in the session PDA seeds — it cannot be redirected"
                />
                <KeyRow
                  label="Settlement authority"
                  value={health?.settlement_authority}
                  href={
                    health?.settlement_authority
                      ? explorerAddress(health.settlement_authority)
                      : undefined
                  }
                  note={
                    health?.settlement_authority
                      ? "AgentPay's own key — never the provider's"
                      : undefined
                  }
                />
                <KeyRow label="Evidence entries" value={String(selected.evidence_count)} />
              </dl>

              <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
                <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]"
                  />
                  <span>
                    The Merkle root is computed from the evidence log at submission time and
                    committed on chain. The transfer is irreversible. Settlement is{" "}
                    <strong className="text-[var(--color-fg)]">repeatable</strong> — a later
                    settlement can commit a higher cumulative amount and a newer root, but it can
                    never lower either.
                  </span>
                </p>
              </div>

              {err && (
                <p className="mt-3 rounded border border-[var(--color-danger-dim)] bg-[#ef44441a] px-3 py-2 font-mono text-[11px] text-[var(--color-danger)]">
                  {err}
                </p>
              )}

              <Button className="mt-4 w-full" onClick={settle} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="animate-spin" /> Submitting to devnet…
                  </>
                ) : (
                  <>Settle on-chain</>
                )}
              </Button>
            </div>
          )}

          {/* State 3 of 3: settled, and checked back against the chain. */}
          {result && (
            <div
              className={`rounded-xl p-5 ${
                rootAgrees ? "surface-verified verify-sweep relative overflow-hidden" : "surface-hero"
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full ${
                    rootAgrees
                      ? "bg-[var(--color-accent)] text-black"
                      : "bg-[var(--color-surface-2)] text-[var(--color-fg-dim)]"
                  }`}
                >
                  {rootAgrees ? <Check className="size-5" strokeWidth={3} /> : <Landmark className="size-4" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[17px] font-semibold leading-tight text-[var(--color-fg)]">
                    {rootAgrees
                      ? "Settlement verified"
                      : chainRoot === undefined
                        ? "Settled — reading the chain…"
                        : "Settled"}
                  </p>
                  <p className="t-support mt-0.5">
                    {rootAgrees
                      ? "The root the gateway reported is the root the program stored."
                      : chainRoot === undefined
                        ? "Confirming the committed root against the program."
                        : "The chain has not returned a matching root for this session."}
                  </p>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3">
                <Figure label="Settled" value={formatUsdc(result.cumulative_amount)} tone="accent" />
                <Figure label="Entries committed" value={String(result.evidence_entries)} />
                <Figure
                  label="Protocol"
                  value={health ? protocolLabel(health.program_id).replace(" Protocol", "") : "—"}
                />
              </div>

              <dl className="mt-5">
                <KeyRow
                  label="Settlement record"
                  value={result.settlement_record}
                  href={explorerAddress(result.settlement_record)}
                />
                <KeyRow
                  label="Provider token account"
                  value={result.provider_token_account}
                  href={explorerAddress(result.provider_token_account)}
                />
                <KeyRow
                  label="Settlement authority"
                  value={health?.settlement_authority}
                  href={
                    health?.settlement_authority
                      ? explorerAddress(health.settlement_authority)
                      : undefined
                  }
                />
                <KeyRow
                  label="Transaction"
                  value={result.signature}
                  href={explorerTx(result.signature)}
                />
              </dl>

              {/* ---- the root -------------------------------------------
                  "Latest committed", never "final": v2 settlement is
                  monotonic and repeatable, so a later settlement commits a
                  root over more evidence. Calling it final would make an
                  exported proof look permanently valid when it is not.

                  Only two legs are asserted here, because only two are
                  checked here. The browser recomputation happens in the
                  Verifier, and this page links to it rather than borrowing
                  its tick. */}
              <div className="mt-4 rounded-lg border border-[var(--color-cyan-dim)] bg-[#22d3ee14] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="t-label">Latest committed root</p>
                  <span className="t-support">not final — settlement is repeatable</span>
                </div>
                <code className="mt-1.5 block break-all font-mono text-[11px] text-[var(--color-cyan)]">
                  {result.merkle_root}
                </code>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2 rounded border border-[var(--color-accent-dim)] bg-[#10b98114] px-2.5 py-2">
                    <Check className="size-3.5 shrink-0 text-[var(--color-accent)]" strokeWidth={3} />
                    <span className="text-[12px] text-[var(--color-fg)]">Reported by gateway</span>
                  </div>
                  <div
                    className={`flex items-center gap-2 rounded border px-2.5 py-2 ${
                      rootAgrees
                        ? "border-[var(--color-accent-dim)] bg-[#10b98114]"
                        : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    }`}
                  >
                    {rootAgrees ? (
                      <Check
                        className="size-3.5 shrink-0 text-[var(--color-accent)]"
                        strokeWidth={3}
                      />
                    ) : (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-fg-dim)]" />
                    )}
                    <span className="text-[12px] text-[var(--color-fg)]">
                      {rootAgrees
                        ? "Committed on chain"
                        : chainRoot === undefined
                          ? "Reading the chain…"
                          : "Not confirmed on chain"}
                    </span>
                  </div>
                </div>
                <p className="t-support mt-2.5">
                  The third check — recomputing this root from the evidence log in your own browser
                  — happens in the Verifier.
                </p>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Button asChild variant="outline">
                  <a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">
                    View on Solana Explorer <ExternalLink />
                  </a>
                </Button>
                <Button asChild>
                  <a href={`/verifier?session=${settledSession.current ?? ""}`}>
                    Recompute in the Verifier
                  </a>
                </Button>
              </div>
            </div>
          )}

          {/* What the instruction actually does, in the order it does it. */}
          <Card>
            <CardHeader>
              <CardTitle>What this transaction does</CardTitle>
              <ShieldCheck aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
            </CardHeader>
            <CardContent className="space-y-3 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
              <p>
                The program re-checks the claim before it moves anything: still inside expiry,
                higher than what was already settled, no more than the deposit, and carrying a
                valid Ed25519 signature from this session&apos;s agent. The gateway&apos;s opinion
                does not enter into it.
              </p>
              <p>
                It then transfers only the{" "}
                <span className="font-semibold text-[var(--color-fg)]">difference</span> between
                this claim and what was settled before. Claims are cumulative, so paying the
                highest one pays for every call beneath it — one transfer, not one per request.
              </p>
              <p>
                It writes a <code className="font-mono">SettlementRecord</code> holding the claim
                hash, the Merkle root and the cumulative amount. That record is what makes a
                decision provable to someone who was never given the log.
              </p>
              <p>
                <span className="font-semibold text-[var(--color-fg)]">
                  Settlement can run more than once.
                </span>{" "}
                Under program v2 it is monotonic: a later settlement may commit a higher cumulative
                total and a newer root, and may never lower either. That is why the root above is
                the latest committed one rather than a final one.
              </p>
              <p className="border-t border-[var(--color-border)] pt-3">
                <span className="font-semibold text-[var(--color-fg)]">
                  The remainder stays put.
                </span>{" "}
                Settling does not return it — it sits in the vault until{" "}
                <code className="font-mono">refund_session</code> runs, which after expiry anyone
                can call, because those funds can only ever move to the agent.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
