"use client";

import * as React from "react";
import { FlaskConical, Info, Play, RotateCcw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type SessionSummary } from "@/lib/api";
import { consumedPercent, formatUsdc, formatUsdcCompact } from "@/lib/format";

/**
 * Mirror of `evaluate_claim` in gateway/src/state.rs.
 *
 * IMPORTANT: this is a *projection*, not a gateway call. The browser holds no
 * agent private key, so it cannot produce a signature the gateway would accept
 * — every real request from here would come back ERR_INVALID_SIGNATURE and
 * teach nothing. Simulating the rules locally shows the enforcement logic
 * honestly, and the UI says so rather than implying a round trip happened.
 *
 * Order matches the Rust exactly; if that changes, this must change with it.
 */
type Verdict =
  | { decision: "ALLOWED"; delta: bigint }
  | { decision: "ERR_SESSION_SETTLED" | "ERR_SESSION_EXPIRED" | "ERR_CLAIM_NOT_MONOTONIC" | "ERR_NONCE_NOT_MONOTONIC" | "ERR_CLAIM_EXCEEDS_DEPOSIT" };

const CLOCK_SKEW_TOLERANCE_SECS = 30;

function evaluateClaim(
  s: SessionSummary,
  cumulative: bigint,
  nonce: bigint,
  nowSecs: number
): Verdict {
  if (s.is_settled) return { decision: "ERR_SESSION_SETTLED" };
  if (nowSecs > s.expires_at + CLOCK_SKEW_TOLERANCE_SECS) {
    return { decision: "ERR_SESSION_EXPIRED" };
  }
  const accepted = BigInt(s.cumulative_accepted);
  if (cumulative <= accepted) return { decision: "ERR_CLAIM_NOT_MONOTONIC" };
  if (s.last_nonce !== null && nonce <= BigInt(s.last_nonce)) {
    return { decision: "ERR_NONCE_NOT_MONOTONIC" };
  }
  if (cumulative > BigInt(s.deposited_total)) return { decision: "ERR_CLAIM_EXCEEDS_DEPOSIT" };
  return { decision: "ALLOWED", delta: cumulative - accepted };
}

const EXPLAIN: Record<string, string> = {
  ALLOWED: "Cumulative increased, nonce increased, and the total stays inside the escrowed deposit.",
  ERR_CLAIM_NOT_MONOTONIC:
    "Cumulative did not increase over the high-water mark. Equal is a replay; lower is a regression.",
  ERR_NONCE_NOT_MONOTONIC:
    "The sequence number did not increase, so this claim is out of order even though the amount rose.",
  ERR_CLAIM_EXCEEDS_DEPOSIT:
    "Cumulative is larger than what was escrowed on chain. The program would refuse this at settlement too.",
  ERR_SESSION_EXPIRED: "The session is past its expiry plus clock-skew tolerance.",
  ERR_SESSION_SETTLED: "The session already settled; nothing further can be claimed.",
};

export default function PlaygroundPage() {
  const toast = useToast();
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [selected, setSelected] = React.useState<SessionSummary | null>(null);
  const [cumulative, setCumulative] = React.useState<bigint>(0n);
  const [nonce, setNonce] = React.useState<bigint>(1n);
  const [log, setLog] = React.useState<
    Array<{ id: number; cumulative: bigint; nonce: bigint; verdict: Verdict }>
  >([]);

  React.useEffect(() => {
    api.sessions().then((res) => {
      if (!res.ok) return;
      const open = res.data.sessions.filter((s) => !s.is_settled);
      setSessions(open);
      if (open.length && !selected) pick(open[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (s: SessionSummary) => {
    setSelected(s);
    const accepted = BigInt(s.cumulative_accepted);
    const deposit = BigInt(s.deposited_total);
    // Start just above the mark: the interesting boundary.
    setCumulative(accepted + (deposit - accepted) / 4n);
    setNonce(s.last_nonce !== null ? BigInt(s.last_nonce) + 1n : 1n);
    setLog([]);
  };

  const verdict = React.useMemo(
    () => (selected ? evaluateClaim(selected, cumulative, nonce, Math.floor(Date.now() / 1000)) : null),
    [selected, cumulative, nonce]
  );

  const submit = () => {
    if (!selected || !verdict) return;
    setLog((l) => [{ id: Date.now(), cumulative, nonce, verdict }, ...l].slice(0, 12));
    toast({
      kind: verdict.decision === "ALLOWED" ? "success" : "info",
      title: `Projected: ${verdict.decision}`,
      body: EXPLAIN[verdict.decision],
    });
  };

  const deposit = selected ? BigInt(selected.deposited_total) : 0n;
  const accepted = selected ? BigInt(selected.cumulative_accepted) : 0n;
  const maxSlider = deposit > 0n ? (deposit * 3n) / 2n : 1_000_000n;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Session under test</CardTitle>
              <CardDescription>Real state, pulled from the gateway</CardDescription>
            </div>
            <FlaskConical className="size-4 text-[var(--color-fg-dim)]" />
          </CardHeader>
          <CardContent className="max-h-[240px] space-y-1.5 overflow-y-auto p-2">
            {sessions.map((s) => (
              <button
                key={s.session}
                onClick={() => pick(s)}
                className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                  selected?.session === s.session
                    ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <MonoKey value={s.session} head={6} tail={4} />
                  <span className="tnum font-mono text-[11px]">
                    {formatUsdcCompact(s.cumulative_accepted)} / {formatUsdcCompact(s.deposited_total)}
                  </span>
                </div>
              </button>
            ))}
            {sessions.length === 0 && (
              <p className="py-8 text-center text-xs text-[var(--color-fg-dim)]">
                No unsettled sessions available.
              </p>
            )}
          </CardContent>
        </Card>

        {selected && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Claim controls</CardTitle>
                <CardDescription>Drag past the limits to trigger each denial</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => pick(selected)}>
                <RotateCcw /> Reset
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    cumulative_amount
                  </label>
                  <span className="tnum font-mono text-sm">{formatUsdc(cumulative)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={maxSlider.toString()}
                  step="1000"
                  value={cumulative.toString()}
                  onChange={(e) => setCumulative(BigInt(e.target.value))}
                  className="w-full accent-[var(--color-accent)]"
                  aria-label="Cumulative amount"
                />
                <div className="mt-1 flex justify-between text-[10px] text-[var(--color-fg-dim)]">
                  <span>0</span>
                  <span className="text-[var(--color-accent)]">
                    mark {formatUsdcCompact(accepted)}
                  </span>
                  <span className="text-[var(--color-warn)]">
                    deposit {formatUsdcCompact(deposit)}
                  </span>
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    nonce
                  </label>
                  <span className="tnum font-mono text-sm">{nonce.toString()}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={String((selected.last_nonce ? Number(selected.last_nonce) : 0) + 12)}
                  value={nonce.toString()}
                  onChange={(e) => setNonce(BigInt(e.target.value))}
                  className="w-full accent-[var(--color-cyan)]"
                  aria-label="Nonce"
                />
                <div className="mt-1 flex justify-between text-[10px] text-[var(--color-fg-dim)]">
                  <span>0</span>
                  <span className="text-[var(--color-cyan)]">
                    last accepted {selected.last_nonce ?? "none"}
                  </span>
                </div>
              </div>

              <Button className="w-full" onClick={submit}>
                <Play /> Evaluate claim
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card glow={verdict?.decision === "ALLOWED"}>
          <CardHeader>
            <div>
              <CardTitle>Projected gateway response</CardTitle>
              <CardDescription>Rules mirrored from gateway/src/state.rs</CardDescription>
            </div>
            {verdict && (
              <Badge variant={verdict.decision === "ALLOWED" ? "allowed" : "denied"}>
                {verdict.decision}
              </Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
              <Info className="mt-px size-3 shrink-0 text-[var(--color-cyan)]" />
              <p className="text-[10px] leading-relaxed text-[var(--color-fg-dim)]">
                <strong className="text-[var(--color-fg-muted)]">Simulated locally.</strong> This is
                not a gateway round trip. The browser holds no agent private key, so it cannot
                produce a claim signature the gateway would accept — a real request from here would
                always return <code className="font-mono">ERR_INVALID_SIGNATURE</code>. The session
                state above is real; the verdict is this page applying the same rules.
              </p>
            </div>

            {selected && verdict && (
              <>
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                      high-water mark after this claim
                    </span>
                    <span className="tnum font-mono text-xs">
                      {verdict.decision === "ALLOWED"
                        ? formatUsdc(cumulative)
                        : formatUsdc(accepted)}
                    </span>
                  </div>
                  <Progress
                    percent={consumedPercent(
                      (verdict.decision === "ALLOWED" ? cumulative : accepted).toString(),
                      deposit.toString()
                    )}
                    tone={
                      verdict.decision === "ERR_CLAIM_EXCEEDS_DEPOSIT"
                        ? "danger"
                        : verdict.decision === "ALLOWED"
                        ? "accent"
                        : "warn"
                    }
                  />
                  {verdict.decision === "ALLOWED" && (
                    <p className="mt-2 text-[11px] text-[var(--color-accent)]">
                      delta {formatUsdc(verdict.delta)} authorised for this request
                    </p>
                  )}
                  {verdict.decision !== "ALLOWED" && (
                    <p className="mt-2 text-[11px] text-[var(--color-warn)]">
                      Mark unchanged — a refused claim never advances it.
                    </p>
                  )}
                </div>

                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    why
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                    {EXPLAIN[verdict.decision]}
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Simulation log</CardTitle>
            <CardDescription>{log.length} evaluated</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[300px] space-y-1.5 overflow-y-auto p-2">
            {log.map((e) => (
              <div
                key={e.id}
                className="animate-in-row flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
              >
                <Badge variant={e.verdict.decision === "ALLOWED" ? "allowed" : "denied"}>
                  {e.verdict.decision.replace(/^ERR_/, "")}
                </Badge>
                <span className="tnum ml-auto font-mono text-[11px]">
                  {formatUsdc(e.cumulative)}
                </span>
                <span className="tnum font-mono text-[10px] text-[var(--color-fg-dim)]">
                  n{e.nonce.toString()}
                </span>
              </div>
            ))}
            {log.length === 0 && (
              <p className="py-8 text-center text-xs text-[var(--color-fg-dim)]">
                Evaluate a claim to populate the log.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
