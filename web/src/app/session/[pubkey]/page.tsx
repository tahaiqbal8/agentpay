"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Ban, CheckCircle2, ExternalLink, Landmark } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, variantForReason } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { MonoKey } from "@/components/mono";
import { api, type SessionEvidence, type SessionSummary } from "@/lib/api";
import { DECISION_LABEL, DECISION_WHY } from "@/lib/constants";
import { sessionStatus } from "@/lib/session-status";
import {
  consumedPercent,
  expiryCountdown,
  explorerAddress,
  formatUsdc,
  formatUsdcCompact,
  truncateHash,
} from "@/lib/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="t-label">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/**
 * The claim ladder.
 *
 * Reads top to bottom as the session actually unfolded, with denials inline
 * rather than filtered out — the gaps between allowed steps are the enforcement
 * layer doing its job, and hiding them would misrepresent the session.
 */
function Ladder({ ev, deposit }: { ev: SessionEvidence; deposit: string }) {
  return (
    <div className="space-y-1">
      {ev.entries.map((e) => {
        const allowed = e.decision === "ALLOWED";
        const tone = variantForReason(e.decision);
        const pct = consumedPercent(e.cumulative_amount, deposit);
        return (
          <div
            key={e.sequence_id}
            className={`rounded-md border p-2.5 ${
              allowed
                ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                : tone === "danger"
                ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
                : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="tnum grid size-5 shrink-0 place-items-center rounded bg-[var(--color-bg)] font-mono text-[10px] text-[var(--color-fg-dim)]">
                {e.sequence_id}
              </span>
              <span title={DECISION_WHY[e.decision] ?? e.decision}>
                <Badge variant={tone}>
                  {DECISION_LABEL[e.decision] ?? e.decision.replace(/^ERR_/, "")}
                </Badge>
              </span>
              <span className="tnum ml-auto font-mono text-xs text-[var(--color-fg)]">
                {formatUsdc(e.cumulative_amount)}
              </span>
              <span className="tnum font-mono text-[10px] text-[var(--color-fg-dim)]">
                n{e.nonce}
              </span>
            </div>
            {/* Only allowed claims moved the bar; denials show where it stayed. */}
            <div className="mt-2 pl-7">
              <Progress
                percent={allowed ? pct : 0}
                tone={allowed ? "accent" : "warn"}
                label={
                  allowed
                    ? `High-water mark after this claim: ${pct.toFixed(1)}% of the deposit`
                    : "Refused — the mark did not move"
                }
              />
            </div>
            <div className="mt-1 flex items-center gap-1.5 pl-7">
              <code
                className="font-mono text-[10px] text-[var(--color-fg-dim)]"
                title={e.entry_hash}
              >
                {truncateHash(e.entry_hash, 8, 8)}
              </code>
              <Link
                href={`/verifier?session=${ev.session}`}
                className="text-[10px] text-[var(--color-cyan)] hover:underline"
              >
                prove
              </Link>
            </div>
          </div>
        );
      })}
      {ev.entries.length === 0 && (
        <p className="py-10 text-center text-xs text-[var(--color-fg-muted)]">
          No claims have been made against this session yet.
        </p>
      )}
    </div>
  );
}

export default function SessionDetailPage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = params?.pubkey ?? "";

  const [session, setSession] = React.useState<SessionSummary | null>(null);
  const [evidence, setEvidence] = React.useState<SessionEvidence | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const poll = async () => {
      const [list, ev] = await Promise.all([api.sessions(), api.evidence(pubkey)]);
      if (cancelled) return;
      if (list.ok) {
        const found = list.data.sessions.find((s) => s.session === pubkey) ?? null;
        setSession(found);
        setNotFound(!found);
      }
      if (ev.ok) setEvidence(ev.data);
      setLoaded(true);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pubkey]);

  const st = session ? sessionStatus(session) : null;
  const allowed = evidence?.entries.filter((e) => e.decision === "ALLOWED").length ?? 0;
  const denied = (evidence?.entries.length ?? 0) - allowed;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/">
            <ArrowLeft /> Monitor
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="t-page">Session</h1>
          {st && <Badge variant={st.tone}>{st.label}</Badge>}
        </div>
        <MonoKey
          value={pubkey}
          head={10}
          tail={10}
          href={pubkey ? explorerAddress(pubkey) : undefined}
        />
      </header>

      {loaded && notFound && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-[var(--color-fg-muted)]">
              The gateway is not tracking this session.
            </p>
            <p className="t-support mx-auto mt-1 max-w-sm">
              It may exist on chain without ever having been registered. Nothing here is missing —
              this gateway simply never saw it.
            </p>
          </CardContent>
        </Card>
      )}

      {session && st && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="min-w-0 space-y-4">
            <Card accent={st.wouldAccept ? "accent" : "warn"}>
              <CardHeader>
                <div>
                  <CardTitle>Allowance</CardTitle>
                  <CardDescription>
                    {st.wouldAccept
                      ? "Accepting claims right now"
                      : `A claim now would return ${st.reasonIfRefused}`}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum font-mono text-xl text-[var(--color-fg)]">
                      {formatUsdc(session.cumulative_accepted)}
                    </span>
                    <span className="tnum font-mono text-xs text-[var(--color-fg-dim)]">
                      / {formatUsdc(session.deposited_total)}
                    </span>
                  </div>
                  <Progress
                    className="mt-2"
                    percent={consumedPercent(session.cumulative_accepted, session.deposited_total)}
                    tone="accent"
                    label="Share of the escrowed deposit consumed"
                  />
                  <p className="t-support mt-2">
                    {formatUsdcCompact(session.remaining)} USDC still available
                  </p>
                </div>

                <Row label="Agent">
                  <MonoKey value={session.agent} href={explorerAddress(session.agent)} />
                </Row>
                <Row label="Provider">
                  <MonoKey value={session.provider} href={explorerAddress(session.provider)} />
                </Row>
                <Row label="Mint">
                  <MonoKey value={session.mint} href={explorerAddress(session.mint)} />
                </Row>
                <Row label="Last nonce">
                  <span className="tnum font-mono text-xs">{session.last_nonce ?? "—"}</span>
                </Row>
                <Row label="Expiry">
                  <span className="tnum font-mono text-xs">
                    {st.status === "settled" ? "—" : expiryCountdown(session.expires_at).label}
                  </span>
                </Row>
                <Row label="Opened">
                  <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                    {new Date(session.created_at).toLocaleString()}
                  </span>
                </Row>

                <div className="mt-3 flex gap-2">
                  <Button asChild variant="outline" size="sm" className="flex-1">
                    <a href={explorerAddress(session.session)} target="_blank" rel="noreferrer">
                      On chain <ExternalLink />
                    </a>
                  </Button>
                  {/* Only offer settlement when the program would actually
                      accept it: settle_session refuses once expiry plus skew
                      has passed, so an expired session cannot settle at all. */}
                  {st.status === "active" || st.status === "expiring" ? (
                    <Button asChild size="sm" className="flex-1">
                      <Link href="/settle">
                        <Landmark /> Settle
                      </Link>
                    </Button>
                  ) : null}
                </div>

                {st.status === "expired" && (
                  <div className="mt-3 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-2.5">
                    <p className="text-[11px] leading-relaxed text-[var(--color-warn)]">
                      <strong className="font-semibold">Past settlement.</strong>{" "}
                      <span className="text-[var(--color-fg-muted)]">
                        <code className="font-mono">settle_session</code> refuses once expiry plus
                        clock-skew tolerance has passed, so the provider can no longer collect. The
                        escrow is now recoverable by <em>anyone</em> through{" "}
                        <code className="font-mono">refund_session</code>, and it can only ever go
                        to the agent&apos;s own token account. The gateway does not expose a refund
                        endpoint, so call it on chain directly.
                      </span>
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Allowed"
                value={String(allowed)}
                support="claims that moved the mark"
                icon={CheckCircle2}
                tone="accent"
              />
              <Stat
                label="Refused"
                value={String(denied)}
                support="recorded, not discarded"
                icon={Ban}
                tone={denied > 0 ? "warn" : "neutral"}
              />
            </div>
          </div>

          <Card className="min-w-0">
            <CardHeader>
              <div>
                <CardTitle>Claim ladder</CardTitle>
                <CardDescription>Every decision in order, denials included</CardDescription>
              </div>
              {/* No icon beside the glyph the badge already carries. */}
              {evidence &&
                (evidence.chain_valid ? (
                  <Badge variant="allowed">chain intact</Badge>
                ) : (
                  <Badge variant="danger">chain broken</Badge>
                ))}
            </CardHeader>
            <CardContent className="max-h-[680px] overflow-y-auto">
              {evidence && evidence.entry_count > 0 && (
                <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                  <p className="t-label">merkle_root</p>
                  <code className="mt-1 block break-all font-mono text-[11px] text-[var(--color-cyan)]">
                    {evidence.merkle_root}
                  </code>
                  <p className="t-support mt-1">
                    {st.status === "settled"
                      ? "Committed on chain by the settlement transaction."
                      : "Will be committed on chain when this session settles."}
                  </p>
                </div>
              )}
              {evidence ? (
                <Ladder ev={evidence} deposit={session.deposited_total} />
              ) : (
                <p className="py-10 text-center text-xs text-[var(--color-fg-muted)]">
                  Loading evidence…
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
