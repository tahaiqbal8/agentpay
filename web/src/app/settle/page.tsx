"use client";

import * as React from "react";
import { ExternalLink, Landmark, Loader2, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type SessionSummary } from "@/lib/api";
import { sessionStatus } from "@/lib/session-status";
import { explorerAddress, explorerTx, formatUsdc, truncateHash } from "@/lib/format";

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
 *  - a session that was never reconciled against the chain has NO escrow
 *    account behind it, so there is nothing to settle from.
 *
 * Listing either kind here would offer an action the program can only reject.
 */
function settleable(s: SessionSummary): boolean {
  if (!s.chain_verified) return false;
  const st = sessionStatus(s).status;
  return st === "active" || st === "expiring";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">{label}</span>
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
  const [result, setResult] = React.useState<SettleResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    api.sessions().then((res) => {
      if (!res.ok) return;
      setSessions(res.data.sessions.filter(settleable));
      setUnverified(
        res.data.sessions.filter(
          (s) => !s.chain_verified && !s.is_settled
        )
      );
    });
  }, []);

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
    api.sessions().then((r) => {
      if (r.ok) setSessions(r.data.sessions.filter(settleable));
    });
    setSelected(null);
  };

  // Settlement pays the highest claim; the remainder is refundable to the agent.
  const refundable = selected
    ? (BigInt(selected.deposited_total) - BigInt(selected.cumulative_accepted)).toString()
    : "0";

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Settleable sessions</CardTitle>
            <CardDescription>
              Unsettled and still inside their expiry window
            </CardDescription>
          </div>
          <Badge variant="neutral">{sessions.length}</Badge>
        </CardHeader>
        <CardContent className="max-h-[560px] space-y-1.5 overflow-y-auto p-2">
          {sessions.map((s) => (
            <button
              key={s.session}
              onClick={() => {
                setSelected(s);
                setResult(null);
                setErr(null);
              }}
              className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                selected?.session === s.session
                  ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <MonoKey value={s.session} head={6} tail={6} />
                <span className="tnum font-mono text-xs text-[var(--color-fg)]">
                  {formatUsdc(s.cumulative_accepted)}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-fg-dim)]">
                {s.evidence_count} evidence entries · deposit {formatUsdc(s.deposited_total)}
              </p>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="py-10 text-center text-xs text-[var(--color-fg-dim)]">
              No sessions can be settled right now.
            </p>
          )}

          {unverified.length > 0 && (
            <div className="mt-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b1a] p-2.5">
              <p className="text-[11px] font-semibold text-[var(--color-warn)]">
                {unverified.length} session{unverified.length === 1 ? "" : "s"} not shown —
                no on-chain escrow
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-fg-muted)]">
                These were opened while{" "}
                <code className="font-mono">AGENTPAY_TRUST_OPEN_REQUESTS=1</code> was set, so
                the gateway never checked that a vault exists. There is nothing on chain to
                settle from, and <code className="font-mono">settle_session</code> would fail.
                They are useful for demonstrating enforcement, not settlement.
              </p>
              <p className="mt-1.5 text-[10px] text-[var(--color-fg-dim)]">
                For a settleable session, open one on chain — see{" "}
                <code className="font-mono">npm run evidence-devnet</code>.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card glow={!!result}>
          <CardHeader>
            <div>
              <CardTitle>Settlement breakdown</CardTitle>
              <CardDescription>
                One transaction settles the whole session — the deferred scheme
              </CardDescription>
            </div>
            <Landmark className="size-4 text-[var(--color-fg-dim)]" />
          </CardHeader>
          <CardContent>
            {!selected && !result && (
              <p className="py-10 text-center text-xs text-[var(--color-fg-dim)]">
                Select a session to see its breakdown.
              </p>
            )}

            {selected && !result && (
              <>
                <Row label="Session">
                  <MonoKey value={selected.session} href={explorerAddress(selected.session)} />
                </Row>
                <Row label="Vault balance (deposit)">
                  <span className="tnum font-mono text-xs">{formatUsdc(selected.deposited_total)}</span>
                </Row>
                <Row label="Cumulative claims">
                  <span className="tnum font-mono text-xs text-[var(--color-accent)]">
                    {formatUsdc(selected.cumulative_accepted)}
                  </span>
                </Row>
                <Row label="Refundable to agent">
                  <span className="tnum font-mono text-xs">{formatUsdc(refundable)}</span>
                </Row>
                <Row label="Evidence entries">
                  <span className="tnum font-mono text-xs">{selected.evidence_count}</span>
                </Row>

                <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                  <p className="flex items-start gap-1.5 text-[10px] text-[var(--color-fg-dim)]">
                    <TriangleAlert className="mt-px size-3 shrink-0 text-[var(--color-warn)]" />
                    The Merkle root is computed from the evidence log at submission time and
                    committed on-chain. Settlement is irreversible and can happen only once per
                    session.
                  </p>
                </div>

                {err && (
                  <p className="mt-3 rounded border border-[#7f1d1d] bg-[#ef44441a] px-2.5 py-2 font-mono text-[11px] text-[var(--color-danger)]">
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
                    <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                      merkle_root committed on-chain
                    </p>
                    <code className="break-all font-mono text-[11px] text-[var(--color-accent)]">
                      {result.merkle_root}
                    </code>
                  </div>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                      transaction signature
                    </p>
                    <code className="break-all font-mono text-[11px] text-[var(--color-fg-muted)]">
                      {result.signature}
                    </code>
                  </div>
                  <Button asChild variant="outline" className="w-full">
                    <a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">
                      View on Solana Explorer <ExternalLink />
                    </a>
                  </Button>
                  <p className="text-center text-[10px] text-[var(--color-fg-dim)]">
                    Verify any decision against root {truncateHash(result.merkle_root, 8, 8)} in the
                    Verifier.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
