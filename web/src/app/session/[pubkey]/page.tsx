"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Landmark,
  Search,
  X,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, variantForReason } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonRows } from "@/components/empty-state";
import { PaymentLifecycle } from "@/components/lifecycle";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { MonoKey } from "@/components/mono";
import {
  api,
  type Agent,
  type Health,
  type SessionEvidence,
  type SessionSummary,
} from "@/lib/api";
import { DECISION_LABEL, DECISION_WHY, protocolLabel } from "@/lib/constants";
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
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-border)] py-2.5 last:border-0">
      <span className="t-label">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** One of the three headline amounts. */
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

/**
 * The claim ladder, as events rather than rows.
 *
 * Reads top to bottom as the session actually unfolded, with refusals inline
 * rather than filtered out — the gaps between allowed steps are the enforcement
 * layer doing its job, and hiding them would misrepresent the session.
 *
 * A refusal carries three consequences that a bare error code does not convey,
 * and all three are protocol facts rather than fields: the gateway admits a
 * claim BEFORE forwarding, so a refused claim never reached the provider and
 * moved no money, and it is still written to the hash chain. That is the whole
 * argument of the product, so it is spelled out.
 *
 * What is NOT shown is the resource. `EvidenceEntry` has no such field — the
 * hash preimage is session, cumulative, nonce and decision — so naming an
 * endpoint here would be an invention.
 */
function Ladder({ ev, deposit }: { ev: SessionEvidence; deposit: string }) {
  return (
    <div className="space-y-2">
      {ev.entries.map((e) => {
        const allowed = e.decision === "ALLOWED";
        const tone = variantForReason(e.decision);
        const pct = consumedPercent(e.cumulative_amount, deposit);
        return (
          <div
            key={e.sequence_id}
            className={`rounded-lg border p-3 ${
              allowed
                ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                : tone === "danger"
                  ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
                  : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="tnum grid size-6 shrink-0 place-items-center rounded bg-[var(--color-bg)] font-mono text-[11px] text-[var(--color-fg-dim)]">
                {e.sequence_id}
              </span>
              <span className="text-[13px] font-semibold text-[var(--color-fg)]">
                {allowed ? "Claim accepted" : "Request blocked"}
              </span>
              <span className="tnum ml-auto text-[13px] text-[var(--color-fg)]">
                {formatUsdc(e.cumulative_amount)}
              </span>
              <span className="tnum text-[11px] text-[var(--color-fg-dim)]">n{e.nonce}</span>
            </div>

            {/* The human sentence first, the wire code underneath it. */}
            {!allowed && (
              <div className="mt-2 pl-8">
                <p className="t-body">
                  {DECISION_WHY[e.decision] ?? "The gateway refused this claim."}
                </p>
                <code className="t-mono mt-1 block text-[var(--color-warn)]">{e.decision}</code>

                <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-3">
                  <li className="flex items-center gap-1.5">
                    <X className="size-3 shrink-0 text-[var(--color-fg-dim)]" strokeWidth={3} />
                    <span className="text-[12px] text-[var(--color-fg-muted)]">
                      Provider contacted: <strong className="text-[var(--color-fg)]">No</strong>
                    </span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <X className="size-3 shrink-0 text-[var(--color-fg-dim)]" strokeWidth={3} />
                    <span className="text-[12px] text-[var(--color-fg-muted)]">
                      Funds moved: <strong className="text-[var(--color-fg)]">No</strong>
                    </span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check
                      className="size-3 shrink-0 text-[var(--color-accent)]"
                      strokeWidth={3}
                    />
                    <span className="text-[12px] text-[var(--color-fg-muted)]">
                      Evidence: <strong className="text-[var(--color-fg)]">Recorded</strong>
                    </span>
                  </li>
                </ul>
              </div>
            )}

            {allowed && (
              <div className="mt-2 pl-8">
                <span title={DECISION_WHY[e.decision] ?? e.decision}>
                  <Badge variant={tone}>{DECISION_LABEL[e.decision] ?? e.decision}</Badge>
                </span>
              </div>
            )}

            {/* Only allowed claims moved the bar; refusals show where it stayed. */}
            <div className="mt-2.5 pl-8">
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

            <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
              <code className="t-mono text-[var(--color-fg-dim)]" title={e.entry_hash}>
                {truncateHash(e.entry_hash, 8, 8)}
              </code>
              <Link
                href={`/verifier?session=${ev.session}`}
                className="flex items-center gap-1 text-[12px] text-[var(--color-cyan)] hover:underline"
              >
                <Search className="size-3" />
                Prove this decision
              </Link>
            </div>
          </div>
        );
      })}
      {ev.entries.length === 0 && (
        <EmptyState
          icon={Ban}
          title="No claims yet"
          body="Nothing has been bought against this session. Every decision — accepted or refused — will appear here in order."
        />
      )}
    </div>
  );
}

export default function SessionDetailPage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = params?.pubkey ?? "";

  const [session, setSession] = React.useState<SessionSummary | null>(null);
  const [evidence, setEvidence] = React.useState<SessionEvidence | null>(null);
  const [agents, setAgents] = React.useState<Agent[] | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [chainRoot, setChainRoot] = React.useState<string | null | undefined>(undefined);
  const [loaded, setLoaded] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);
  const [tech, setTech] = React.useState(false);

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

  // Slow-moving context: who this agent is, and which protocol the gateway runs.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [a, h] = await Promise.all([api.agents(), api.health()]);
      if (cancelled) return;
      setAgents(a.ok ? a.data.agents : null);
      setHealth(h.ok ? h.data : null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* The committed root, read from the chain. This page used to say it had not
     looked; now it does, so the last lifecycle stage can be earned rather than
     assumed. */
  React.useEffect(() => {
    if (!session?.is_settled || !pubkey) {
      setChainRoot(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await api.onChainSettlement(pubkey);
      if (cancelled) return;
      setChainRoot(r.ok && r.data.settled ? (r.data.merkle_root ?? null) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.is_settled, pubkey]);

  const st = session ? sessionStatus(session) : null;
  const allowed = evidence?.entries.filter((e) => e.decision === "ALLOWED").length ?? 0;
  const denied = (evidence?.entries.length ?? 0) - allowed;

  /** The agent record behind this session's pubkey, when the console has one. */
  const agent = React.useMemo(
    () => agents?.find((a) => a.agent_pubkey === session?.agent) ?? null,
    [agents, session?.agent]
  );

  const remaining = session
    ? (BigInt(session.deposited_total) - BigInt(session.cumulative_accepted)).toString()
    : "0";

  /* This session's own progress through the lifecycle. Each stage is a
     question answered by data on this page; the last one is answered by the
     chain, not by `is_settled`. */
  const lifecycleReached = React.useMemo(() => {
    if (!session) return -1;
    const answered = [
      agent !== null, // Human — somebody registered this agent
      agent !== null && !!agent.agent_pubkey, // Agent — a key is bound
      agent?.policy != null, // Policy — an envelope exists
      session.chain_verified, // Escrow — a vault was confirmed
      BigInt(session.cumulative_accepted) > 0n, // Claim
      (evidence?.entries.length ?? 0) > 0, // Enforcement
      evidence?.chain_valid === true, // Evidence
      session.is_settled, // Settlement
      chainRoot != null && chainRoot === evidence?.merkle_root, // Verified
    ];
    let last = -1;
    for (let i = 0; i < answered.length; i++) {
      if (!answered[i]) break;
      last = i;
    }
    return last;
  }, [session, agent, evidence, chainRoot]);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/">
            <ArrowLeft /> Overview
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="t-page brand-gradient-text">Session</h1>
          {st && <Badge variant={st.tone}>{st.label}</Badge>}
          {evidence &&
            (evidence.chain_valid ? (
              <Badge variant="allowed">Chain intact</Badge>
            ) : (
              <Badge variant="danger">Chain broken</Badge>
            ))}
        </div>

        {/* Identity, as four named facts rather than one long key. */}
        {session && (
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <dt className="t-label">Session</dt>
              <dd className="mt-1">
                <MonoKey value={pubkey} head={6} tail={6} href={explorerAddress(pubkey)} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="t-label">Agent</dt>
              <dd className="mt-1">
                {agent ? (
                  <span className="text-[13px] text-[var(--color-fg)]">{agent.label}</span>
                ) : (
                  <MonoKey
                    value={session.agent}
                    head={6}
                    tail={6}
                    href={explorerAddress(session.agent)}
                  />
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="t-label">Provider</dt>
              <dd className="mt-1">
                <MonoKey
                  value={session.provider}
                  head={6}
                  tail={6}
                  href={explorerAddress(session.provider)}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="t-label">Opened</dt>
              <dd className="t-support mt-1">
                {new Date(session.created_at).toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
      </header>

      {!loaded && (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      )}

      {loaded && notFound && (
        <Card>
          <EmptyState
            icon={Search}
            title="The gateway is not tracking this session"
            body="It may exist on chain without ever having been registered. Nothing here is missing — this gateway simply never saw it."
            action={
              <Button asChild variant="outline">
                <Link href="/">Back to Overview</Link>
              </Button>
            }
          />
        </Card>
      )}

      {session && st && (
        <>
          {/* ---- the money, three numbers ---- */}
          <div className="surface-hero rounded-xl p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="t-section">Escrow</h2>
              <span className="t-support ml-auto">
                {st.wouldAccept
                  ? "Accepting claims right now"
                  : `A claim now would return ${st.reasonIfRefused}`}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <Figure label="Deposited" value={formatUsdc(session.deposited_total)} />
              <Figure
                label={session.is_settled ? "Settled" : "Claimed"}
                value={formatUsdc(session.cumulative_accepted)}
                tone="accent"
              />
              <Figure label="Remaining" value={formatUsdc(remaining)} tone="agent" />
            </div>

            <Progress
              className="mt-4"
              percent={consumedPercent(session.cumulative_accepted, session.deposited_total)}
              tone="accent"
              label="Share of the escrowed deposit consumed"
            />
            <p className="t-support mt-2">
              {formatUsdcCompact(session.remaining)} USDC still available to this agent
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={explorerAddress(session.session)} target="_blank" rel="noreferrer">
                  On chain <ExternalLink />
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/verifier?session=${pubkey}`}>
                  <Search className="size-3" /> Verify a decision
                </Link>
              </Button>
              {/* Only offer settlement when the program would actually accept
                  it: settle_session refuses once expiry plus skew has passed. */}
              {st.status === "active" || st.status === "expiring" ? (
                <Button asChild size="sm">
                  <Link href="/settle">
                    <Landmark /> Settle
                  </Link>
                </Button>
              ) : null}
            </div>

            {st.status === "expired" && (
              <div className="mt-4 rounded-lg border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-3">
                <p className="text-[13px] leading-relaxed text-[var(--color-warn)]">
                  <strong className="font-semibold">Past settlement.</strong>{" "}
                  <span className="text-[var(--color-fg-muted)]">
                    <code className="font-mono">settle_session</code> refuses once expiry plus
                    clock-skew tolerance has passed, so the provider can no longer collect. The
                    escrow is now recoverable by <em>anyone</em> through{" "}
                    <code className="font-mono">refund_session</code>, and it can only ever go to
                    the agent&apos;s own token account. The gateway does not expose a refund
                    endpoint, so call it on chain directly.
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* ---- how far this session got ---- */}
          <PaymentLifecycle
            reached={lifecycleReached}
            caption={
              lifecycleReached < 0
                ? "Nothing recorded for this session yet"
                : `${lifecycleReached + 1} of 9 stages complete`
            }
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            {/* ---- what happened, in order ---- */}
            <Card className="min-w-0">
              <CardHeader>
                <div>
                  <CardTitle>Claim activity</CardTitle>
                  <CardDescription>Every decision in order, refusals included</CardDescription>
                </div>
                <Badge variant="neutral">{evidence?.entry_count ?? 0}</Badge>
              </CardHeader>
              <CardContent className="max-h-[720px] overflow-y-auto">
                {evidence ? (
                  <Ladder ev={evidence} deposit={session.deposited_total} />
                ) : (
                  <SkeletonRows rows={3} />
                )}
              </CardContent>
            </Card>

            <div className="min-w-0 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label="Accepted"
                  value={String(allowed)}
                  support="claims that moved the mark"
                  icon={CheckCircle2}
                  tone="accent"
                />
                <Stat
                  label="Blocked"
                  value={String(denied)}
                  support="recorded, not discarded"
                  icon={Ban}
                  tone={denied > 0 ? "warn" : "neutral"}
                />
              </div>

              {/* ---- the root ---- */}
              {evidence && evidence.entry_count > 0 && (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Evidence root</CardTitle>
                      <CardDescription>
                        {session.is_settled ? "Latest committed root" : "Not committed yet"}
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <code className="block break-all font-mono text-[11px] text-[var(--color-cyan)]">
                      {evidence.merkle_root}
                    </code>
                    <p className="t-support mt-2">
                      {!session.is_settled ? (
                        "Will be committed on chain when this session settles."
                      ) : chainRoot === undefined ? (
                        "Reading the committed root from the chain…"
                      ) : chainRoot === evidence.merkle_root ? (
                        <>
                          <span className="font-medium text-[var(--color-accent)]">
                            Matches the root committed on chain.
                          </span>{" "}
                          It is the latest, not a final one — settlement is repeatable, so a later
                          one can commit a root over more entries.
                        </>
                      ) : chainRoot === null ? (
                        "The gateway records this session as settled, but the chain returned no committed root for it."
                      ) : (
                        <span className="font-medium text-[var(--color-danger)]">
                          The chain committed a different root.
                        </span>
                      )}
                    </p>
                    <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                      <Link href={`/verifier?session=${pubkey}`}>
                        Recompute it in your browser
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              )}

              {/* ---- raw fields, folded ---- */}
              <Card>
                <button
                  onClick={() => setTech((v) => !v)}
                  aria-expanded={tech}
                  className="flex w-full items-center gap-2 p-4 text-left"
                >
                  <span className="t-section">Technical details</span>
                  <ChevronDown
                    className={`ml-auto size-4 text-[var(--color-fg-dim)] transition-transform ${
                      tech ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {tech && (
                  <CardContent className="border-t border-[var(--color-border)] pt-3">
                    <Row label="Session PDA">
                      <MonoKey value={session.session} href={explorerAddress(session.session)} />
                    </Row>
                    <Row label="Agent pubkey">
                      <MonoKey value={session.agent} href={explorerAddress(session.agent)} />
                    </Row>
                    <Row label="Provider">
                      <MonoKey value={session.provider} href={explorerAddress(session.provider)} />
                    </Row>
                    <Row label="Mint">
                      <MonoKey value={session.mint} href={explorerAddress(session.mint)} />
                    </Row>
                    <Row label="Last nonce">
                      <span className="tnum text-[13px]">{session.last_nonce ?? "—"}</span>
                    </Row>
                    <Row label="Expiry">
                      <span className="tnum text-[13px]">
                        {st.status === "settled" ? "—" : expiryCountdown(session.expires_at).label}
                      </span>
                    </Row>
                    <Row label="Escrow verified on chain">
                      <span className="text-[13px]">{session.chain_verified ? "Yes" : "No"}</span>
                    </Row>
                    {/* The gateway's PRIMARY program — not a claim about which
                        program owns this particular session, which no endpoint
                        on this console reports. Labelled so. */}
                    <Row label="Gateway protocol">
                      <span className="text-[13px]">
                        {health ? protocolLabel(health.program_id) : "—"}
                      </span>
                    </Row>
                  </CardContent>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
