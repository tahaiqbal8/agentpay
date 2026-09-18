"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ExternalLink,
  Landmark,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
        {label}
      </span>
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
        const pct = consumedPercent(e.cumulative_amount, deposit);
        return (
          <div
            key={e.sequence_id}
            className={`rounded-md border p-2.5 ${
              allowed
                ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="tnum grid size-5 shrink-0 place-items-center rounded bg-[var(--color-bg)] font-mono text-[10px] text-[var(--color-fg-dim)]">
                {e.sequence_id}
              </span>
              <span title={DECISION_WHY[e.decision] ?? e.decision}>
                <Badge variant={allowed ? "allowed" : "denied"}>
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
              <Progress percent={allowed ? pct : 0} tone={allowed ? "accent" : "warn"} />
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
        <p className="py-10 text-center text-xs text-[var(--color-fg-dim)]">
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeft /> Monitor
          </Link>
        </Button>
        <code className="font-mono text-xs text-[var(--color-fg-muted)]">{pubkey}</code>
        {st && <Badge variant={st.tone}>{st.label}</Badge>}
      </div>

      {loaded && notFound && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-[var(--color-fg-muted)]">
              The gateway is not tracking this session.
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-dim)]">
              It may exist on chain without ever having been registered.
            </p>
          </CardContent>
        </Card>
      )}

      {session && st && (
        <div className="grid gap-4 xl:grid-cols-[1fr_1.3fr]">
          <div className="space-y-4">
            <Card>
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
                  <div className="flex items-baseline justify-between">
                    <span className="tnum font-mono text-xl">
                      {formatUsdc(session.cumulative_accepted)}
                    </span>
                    <span className="tnum font-mono text-xs text-[var(--color-fg-dim)]">
                      / {formatUsdc(session.deposited_total)}
                    </span>
                  </div>
                  <Progress
                    className="mt-2"
                    percent={consumedPercent(
                      session.cumulative_accepted,
                      session.deposited_total
                    )}
                    tone="accent"
                  />
                  <p className="mt-2 text-[10px] text-[var(--color-fg-dim)]">
                    {formatUsdcCompact(session.remaining)} USDC still available
                  </p>
                </div>

                <Field label="Agent">
                  <MonoKey value={session.agent} href={explorerAddress(session.agent)} />
                </Field>
                <Field label="Provider">
                  <MonoKey value={session.provider} href={explorerAddress(session.provider)} />
                </Field>
                <Field label="Mint">
                  <MonoKey value={session.mint} href={explorerAddress(session.mint)} />
                </Field>
                <Field label="Last nonce">
                  <span className="tnum font-mono text-xs">{session.last_nonce ?? "—"}</span>
                </Field>
                <Field label="Expiry">
                  <span className="tnum font-mono text-xs">
                    {st.status === "settled" ? "—" : expiryCountdown(session.expires_at).label}
                  </span>
                </Field>
                <Field label="Opened">
                  <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                    {new Date(session.created_at).toLocaleString()}
                  </span>
                </Field>

                <div className="mt-3 flex gap-2">
                  <Button asChild variant="outline" size="sm" className="flex-1">
                    <a
                      href={explorerAddress(session.session)}
                      target="_blank"
                      rel="noreferrer"
                    >
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
                  <div className="mt-3 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b1a] p-2.5">
                    <p className="text-[11px] text-[var(--color-warn)]">
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

            <Card>
              <CardHeader>
                <CardTitle>Decisions</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-[var(--color-accent-dim)] bg-[#10b9811a] p-3">
                  <CheckCircle2 className="size-4 text-[var(--color-accent)]" />
                  <p className="tnum mt-1 text-xl font-semibold text-[var(--color-accent)]">
                    {allowed}
                  </p>
                  <p className="text-[10px] text-[var(--color-fg-dim)]">allowed</p>
                </div>
                <div className="rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b1a] p-3">
                  <Ban className="size-4 text-[var(--color-warn)]" />
                  <p className="tnum mt-1 text-xl font-semibold text-[var(--color-warn)]">
                    {denied}
                  </p>
                  <p className="text-[10px] text-[var(--color-fg-dim)]">refused</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Claim ladder</CardTitle>
                <CardDescription>
                  Every decision in order, denials included
                </CardDescription>
              </div>
              {evidence &&
                (evidence.chain_valid ? (
                  <Badge variant="allowed">
                    <ShieldCheck className="size-3" /> chain intact
                  </Badge>
                ) : (
                  <Badge variant="danger">
                    <ShieldAlert className="size-3" /> chain broken
                  </Badge>
                ))}
            </CardHeader>
            <CardContent className="max-h-[680px] overflow-y-auto">
              {evidence && evidence.entry_count > 0 && (
                <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    merkle_root
                  </p>
                  <code className="break-all font-mono text-[11px] text-[var(--color-cyan)]">
                    {evidence.merkle_root}
                  </code>
                  <p className="mt-1 text-[10px] text-[var(--color-fg-dim)]">
                    {st.status === "settled"
                      ? "Committed on chain by the settlement transaction."
                      : "Will be committed on chain when this session settles."}
                  </p>
                </div>
              )}
              {evidence ? (
                <Ladder ev={evidence} deposit={session.deposited_total} />
              ) : (
                <p className="py-10 text-center text-xs text-[var(--color-fg-dim)]">
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
