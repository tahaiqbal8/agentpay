"use client";

import * as React from "react";
import {
  ArrowRight,
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
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type SessionSummary } from "@/lib/api";
import { sessionStatus } from "@/lib/session-status";
import {
  consumedPercent,
  explorerAddress,
  explorerTx,
  formatUsdc,
  formatUsdcCompact,
  truncateHash,
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="t-label">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
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
  const [busy, setBusy] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<SettleResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await api.sessions();
    if (!res.ok) return;
    setSessions(res.data.sessions.filter(settleable));
    setUnverified(res.data.sessions.filter((s) => !s.chain_verified && !s.is_settled));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page">Settlement</h1>
          <p className="t-body mt-1 max-w-2xl">
            Pay a provider the highest claim its agent signed, and commit the evidence root that
            justifies it — one transaction, once per session.
          </p>
        </div>
        <Badge variant="info">Solana devnet</Badge>
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>Settleable sessions</CardTitle>
              <CardDescription>Unsettled and still inside their expiry window</CardDescription>
            </div>
            <Badge variant="neutral">{sessions.length}</Badge>
          </CardHeader>
          <CardContent className="max-h-[560px] space-y-1.5 overflow-y-auto p-2">
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
                  className={`interactive w-full rounded-md border p-2.5 text-left ${
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
                    <span className="tnum font-mono text-xs text-[var(--color-fg)]">
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

            {sessions.length === 0 && (
              <p className="py-10 text-center text-xs text-[var(--color-fg-muted)]">
                No sessions can be settled right now.
              </p>
            )}

            {unverified.length > 0 && (
              <div className="mt-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-2.5">
                <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--color-warn)]">
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
                    settleable session, see{" "}
                    <code className="font-mono text-[var(--color-cyan)]">
                      npm run evidence-devnet
                    </code>
                    .
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card glow={!!result} accent={result ? "accent" : undefined}>
            <CardHeader>
              <div>
                <CardTitle>Settlement breakdown</CardTitle>
                <CardDescription>
                  One transaction settles the whole session — the deferred scheme
                </CardDescription>
              </div>
              <Landmark aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
            </CardHeader>
            <CardContent>
              {!selected && !result && (
                <div className="py-12 text-center">
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    Select a session to see its breakdown.
                  </p>
                  <p className="t-support mx-auto mt-1 max-w-xs">
                    Nothing is submitted until you choose one and confirm.
                  </p>
                </div>
              )}

              {selected && !result && (
                <>
                  <Row label="Session">
                    <MonoKey value={selected.session} href={explorerAddress(selected.session)} />
                  </Row>
                  <Row label="Vault balance (deposit)">
                    <span className="tnum font-mono text-xs">
                      {formatUsdc(selected.deposited_total)}
                    </span>
                  </Row>
                  <Row label="Cumulative claims">
                    <span className="tnum font-mono text-xs text-[var(--color-accent)]">
                      {formatUsdc(selected.cumulative_accepted)}
                    </span>
                  </Row>
                  <Row label="Refundable to agent">
                    <span className="tnum font-mono text-xs text-[var(--color-agent)]">
                      {formatUsdc(refundable)}
                    </span>
                  </Row>
                  <Row label="Evidence entries">
                    <span className="tnum font-mono text-xs">{selected.evidence_count}</span>
                  </Row>

                  {/* Where the money goes, in the order the program moves it.
                      An operator about to sign an irreversible transfer should
                      not have to reconstruct this from four rows of numbers. */}
                  <div className="mt-3 flex items-stretch gap-2">
                    <div className="flex-1 rounded-md border border-[var(--color-accent-dim)] bg-[#10b9810d] p-2.5">
                      <p className="t-label">To provider, now</p>
                      <p className="tnum mt-1 font-mono text-sm text-[var(--color-accent)]">
                        {formatUsdc(selected.cumulative_accepted)}
                      </p>
                    </div>
                    <ArrowRight
                      aria-hidden="true"
                      className="my-auto size-3.5 shrink-0 text-[var(--color-fg-dim)]"
                    />
                    <div className="flex-1 rounded-md border border-[var(--color-agent-dim)] bg-[#a78bfa0d] p-2.5">
                      <p className="t-label">Left in vault</p>
                      <p className="tnum mt-1 font-mono text-sm text-[var(--color-agent)]">
                        {formatUsdc(refundable)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                    <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-[var(--color-fg-muted)]">
                      <TriangleAlert
                        aria-hidden="true"
                        className="mt-px size-3 shrink-0 text-[var(--color-warn)]"
                      />
                      The Merkle root is computed from the evidence log at submission time and
                      committed on-chain. Settlement is irreversible and can happen only once per
                      session.
                    </p>
                  </div>

                  {err && (
                    <p className="mt-3 rounded border border-[var(--color-danger-dim)] bg-[#ef44441a] px-2.5 py-2 font-mono text-[11px] text-[var(--color-danger)]">
                      {err}
                    </p>
                  )}

                  <Button className="mt-3 w-full" onClick={settle} disabled={busy}>
                    {busy ? (
                      <>
                        <Loader2 className="animate-spin" /> Submitting to devnet…
                      </>
                    ) : (
                      <>Settle on-chain</>
                    )}
                  </Button>
                </>
              )}

              {result && (
                <>
                  <Row label="Status">
                    <Badge variant="allowed">Confirmed</Badge>
                  </Row>
                  <Row label="Settled amount">
                    <span className="tnum font-mono text-xs text-[var(--color-accent)]">
                      {formatUsdc(result.cumulative_amount)}
                    </span>
                  </Row>
                  <Row label="Evidence entries committed">
                    <span className="tnum font-mono text-xs">{result.evidence_entries}</span>
                  </Row>
                  <Row label="Settlement record">
                    <MonoKey
                      value={result.settlement_record}
                      href={explorerAddress(result.settlement_record)}
                    />
                  </Row>

                  <div className="mt-3 space-y-2">
                    <div className="rounded-md border border-[var(--color-accent-dim)] bg-[#10b9811a] p-2.5">
                      <p className="t-label">merkle_root committed on-chain</p>
                      <code className="mt-1 block break-all font-mono text-[11px] text-[var(--color-accent)]">
                        {result.merkle_root}
                      </code>
                    </div>
                    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                      <p className="t-label">transaction signature</p>
                      <code className="mt-1 block break-all font-mono text-[11px] text-[var(--color-fg-muted)]">
                        {result.signature}
                      </code>
                    </div>
                    <Button asChild variant="outline" className="w-full">
                      <a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">
                        View on Solana Explorer <ExternalLink />
                      </a>
                    </Button>
                    <p className="t-support text-center">
                      Verify any decision against root {truncateHash(result.merkle_root, 8, 8)} in
                      the Verifier.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* What the instruction actually does, in the order it does it.
              Every line here is what `settle_session` executes — the transfer
              of the delta, the SettlementRecord write, the is_settled flag,
              and the remainder that only `refund_session` can move. */}
          <Card>
            <CardHeader>
              <CardTitle>What this transaction does</CardTitle>
              <ShieldCheck aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
            </CardHeader>
            <CardContent className="space-y-3 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
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
                hash, the Merkle root and the amount, and marks the session settled. That record is
                what makes a decision provable to someone who was never given the log.
              </p>
              <p className="border-t border-[var(--color-border)] pt-2.5">
                <span className="font-semibold text-[var(--color-fg)]">The remainder stays put.</span>{" "}
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
