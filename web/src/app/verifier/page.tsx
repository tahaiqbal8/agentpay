"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  Binary,
  ChevronRight,
  Link2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, variantForReason } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { api, type EvidenceProof, type SessionEvidence } from "@/lib/api";
import { DECISION_LABEL, DECISION_WHY } from "@/lib/constants";
import { formatUsdc, truncateHash } from "@/lib/format";

/**
 * Independent proof verification, in the browser.
 *
 * The gateway returns `verified_locally`, but that is the gateway marking its
 * own homework. This recomputes the root from the leaf and the sibling path
 * using WebCrypto, so the green badge means *this page* checked it.
 */
async function sha256Hex(hexA: string, hexB: string): Promise<string> {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hexA.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < 32; i++) bytes[32 + i] = parseInt(hexB.slice(i * 2, i * 2 + 2), 16);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Step {
  index: number;
  running: string;
  sibling: string;
  side: "left" | "right";
  result: string;
}

async function recomputeRoot(proof: EvidenceProof): Promise<{ steps: Step[]; root: string }> {
  let running = proof.leaf_hash;
  const steps: Step[] = [];
  for (let i = 0; i < proof.proof.length; i++) {
    const node = proof.proof[i];
    const result =
      node.side === "right"
        ? await sha256Hex(running, node.hash)
        : await sha256Hex(node.hash, running);
    steps.push({ index: i, running, sibling: node.hash, side: node.side, result });
    running = result;
  }
  return { steps, root: running };
}

function HashChip({ value, tone = "dim" }: { value: string; tone?: "dim" | "accent" | "cyan" }) {
  const cls =
    tone === "accent"
      ? "text-[var(--color-accent)]"
      : tone === "cyan"
      ? "text-[var(--color-cyan)]"
      : "text-[var(--color-fg-muted)]";
  return (
    <code className={`font-mono text-[11px] ${cls}`} title={value}>
      {truncateHash(value, 10, 10)}
    </code>
  );
}

/** A full hash, labelled, on its own ground. */
function HashBlock({
  label,
  value,
  tone = "muted",
  className,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "accent" | "cyan" | "danger" | "fg";
  className?: string;
}) {
  const cls = {
    muted: "text-[var(--color-fg-muted)]",
    accent: "text-[var(--color-accent)]",
    cyan: "text-[var(--color-cyan)]",
    danger: "text-[var(--color-danger)]",
    fg: "text-[var(--color-fg)]",
  }[tone];
  return (
    <div
      className={
        className ??
        "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
      }
    >
      <p className="t-label">{label}</p>
      <code className={`mt-1 block break-all font-mono text-[11px] ${cls}`}>{value}</code>
    </div>
  );
}

/**
 * One of the three roots, with the comparison already done for the reader.
 *
 * `state` is judged against the browser-recomputed root, which is the only
 * value on the page this page produced itself — everything else is somebody's
 * report. The full 64 characters stay on screen either way: a marker that
 * replaced the hash would just be a different thing to trust.
 */
function RootRow({
  label,
  value,
  state,
  absentNote,
}: {
  label: string;
  value: string | null;
  state: "reference" | "match" | "differs" | "absent";
  absentNote?: string;
}) {
  const marker = {
    reference: { text: "COMPUTED HERE", cls: "text-[var(--color-fg-muted)]" },
    match: { text: "✓ MATCH", cls: "text-[var(--color-cyan)]" },
    differs: { text: "✕ DIFFERS", cls: "text-[var(--color-danger)]" },
    absent: { text: "NOT ON CHAIN", cls: "text-[var(--color-fg-dim)]" },
  }[state];

  const hashTone =
    state === "differs"
      ? "text-[var(--color-danger)]"
      : state === "match"
      ? "text-[var(--color-cyan)]"
      : "text-[var(--color-fg)]";

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="t-label">{label}</p>
        <span className={`t-label ${marker.cls}`}>{marker.text}</span>
      </div>
      {value !== null ? (
        <code className={`mt-1 block break-all font-mono text-[11px] ${hashTone}`}>{value}</code>
      ) : (
        <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">{absentNote}</span>
      )}
    </div>
  );
}

/** Ladder view of the evidence log; each leaf links to its predecessor. */
function ChainLadder({
  evidence,
  selected,
  onSelect,
}: {
  evidence: SessionEvidence;
  selected: number | null;
  onSelect: (seq: number) => void;
}) {
  return (
    <div className="space-y-1">
      {evidence.entries.map((e, i) => {
        const active = selected === e.sequence_id;
        // A refusal is the system working. Only a forged claim or a broken
        // dependency is red here — see `variantForReason`.
        const tone = variantForReason(e.decision);
        return (
          <button
            key={e.sequence_id}
            aria-pressed={active}
            onClick={() => onSelect(e.sequence_id)}
            className={`interactive w-full rounded-md border p-2.5 text-left ${
              active
                ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="tnum grid size-5 shrink-0 place-items-center rounded bg-[var(--color-bg)] font-mono text-[11px] text-[var(--color-fg-dim)]">
                {e.sequence_id}
              </span>
              <span title={DECISION_WHY[e.decision] ?? e.decision}>
                <Badge variant={tone}>
                  {DECISION_LABEL[e.decision] ?? e.decision.replace(/^ERR_/, "")}
                </Badge>
              </span>
              <span className="tnum ml-auto font-mono text-[11px] text-[var(--color-fg)]">
                {formatUsdc(e.cumulative_amount)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 pl-7">
              <Link2 aria-hidden="true" className="size-3 shrink-0 text-[var(--color-fg-dim)]" />
              <HashChip value={e.prev_hash} />
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 text-[var(--color-fg-dim)]"
              />
              <HashChip value={e.entry_hash} tone="cyan" />
            </div>
            {i < evidence.entries.length - 1 && (
              <div className="ml-2.5 mt-1 h-2 w-px bg-[var(--color-border-bright)]" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function VerifierInner() {
  const params = useSearchParams();
  const toast = useToast();

  const [session, setSession] = React.useState(params.get("session") ?? "");
  const [sequenceId, setSequenceId] = React.useState("0");
  const [evidence, setEvidence] = React.useState<SessionEvidence | null>(null);
  const [proof, setProof] = React.useState<EvidenceProof | null>(null);
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [recomputed, setRecomputed] = React.useState<string | null>(null);
  // What the PROGRAM stored, read back off the chain — not what the gateway
  // remembers submitting. `null` while unknown, so an unreachable node reads as
  // "unknown" rather than as a mismatch.
  const [onChain, setOnChain] = React.useState<{
    settled: boolean;
    merkle_root?: string;
    settlement_record: string;
    root_may_advance?: boolean;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadEvidence = React.useCallback(
    async (key: string) => {
      if (!key.trim()) return;
      setBusy(true);
      setError(null);
      setProof(null);
      setSteps([]);
      setRecomputed(null);
      setOnChain(null);
      // Runs alongside the evidence load; the root it returns is the one the
      // program committed, and is what the recomputed root is judged against.
      void api.onChainSettlement(key.trim()).then((r) => {
        if (r.ok) setOnChain(r.data);
      });
      const res = await api.evidence(key.trim());
      setBusy(false);
      if (!res.ok) {
        setEvidence(null);
        setError(`${res.error.reason_code} — ${res.error.message}`);
        return;
      }
      setEvidence(res.data);
      if (res.data.entry_count === 0) {
        setError("This session has no evidence entries yet.");
      }
    },
    []
  );

  React.useEffect(() => {
    const s = params.get("session");
    if (s) {
      setSession(s);
      loadEvidence(s);
    }
  }, [params, loadEvidence]);

  const verify = async (seq?: number) => {
    const target = seq ?? Number(sequenceId);
    if (!session.trim() || Number.isNaN(target)) return;
    setBusy(true);
    setError(null);
    const res = await api.proof(session.trim(), target);
    if (!res.ok) {
      setBusy(false);
      setProof(null);
      setError(`${res.error.reason_code} — ${res.error.message}`);
      toast({ kind: "error", title: "Proof unavailable", body: res.error.reason_code });
      return;
    }
    setProof(res.data);
    setSequenceId(String(target));
    const { steps, root } = await recomputeRoot(res.data);
    setSteps(steps);
    setRecomputed(root);
    setBusy(false);

    const match = root === res.data.merkle_root;
    toast({
      kind: match ? "success" : "error",
      title: match ? "Proof cryptographically validated" : "Proof FAILED verification",
      body: match ? `root ${truncateHash(root, 8, 8)}` : "recomputed root does not match",
    });
  };

  const valid = recomputed !== null && proof !== null && recomputed === proof.merkle_root;

  // Three-way agreement, and the third is the one that matters: the gateway
  // could report anything, but the program's stored root is a public fact.
  const chainRoot = onChain?.settled ? onChain.merkle_root : undefined;
  const anchored = valid && chainRoot !== undefined && chainRoot === recomputed;
  const chainDisagrees = valid && chainRoot !== undefined && chainRoot !== recomputed;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page">Verifier</h1>
          <p className="t-body mt-1 max-w-2xl">
            Prove that one decision is covered by a Merkle root committed on Solana. The hashing
            happens in this browser, so the answer does not depend on trusting the gateway.
          </p>
        </div>
        <Badge variant="info">Solana devnet</Badge>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* ---- input + chain ---- */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Inclusion proof generator</CardTitle>
                <CardDescription>Prove one decision against the on-chain root</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="session_pubkey" htmlFor="session-pubkey">
                <div className="flex gap-2">
                  <Input
                    id="session-pubkey"
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                    placeholder="Base58 session address"
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="mt-1"
                    onClick={() => loadEvidence(session)}
                    aria-label="Load evidence"
                  >
                    <Search />
                  </Button>
                </div>
              </Field>

              <Field label="sequence_id" htmlFor="sequence-id">
                <div className="flex gap-2">
                  <Input
                    id="sequence-id"
                    value={sequenceId}
                    onChange={(e) => setSequenceId(e.target.value)}
                    inputMode="numeric"
                    className="font-mono text-xs"
                  />
                  <Button className="mt-1" onClick={() => verify()} disabled={busy || !session.trim()}>
                    {busy ? "Verifying…" : "Verify proof"}
                  </Button>
                </div>
              </Field>

              {error && (
                <p className="rounded border border-[var(--color-danger-dim)] bg-[#ef44441a] px-2.5 py-2 font-mono text-[11px] text-[var(--color-danger)]">
                  {error}
                </p>
              )}
            </CardContent>
          </Card>

          {evidence && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Evidence log</CardTitle>
                  <CardDescription>
                    {evidence.entry_count} entries · click one to prove it
                  </CardDescription>
                </div>
                {/* The badge carries its own glyph, so no second icon here:
                    two symbols for one fact reads as two facts. */}
                {evidence.chain_valid ? (
                  <Badge variant="allowed">chain intact</Badge>
                ) : (
                  <Badge variant="danger">chain broken</Badge>
                )}
              </CardHeader>
              <CardContent className="max-h-[520px] overflow-y-auto">
                <HashBlock label="merkle_root" value={evidence.merkle_root} tone="cyan" className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5" />
                <ChainLadder
                  evidence={evidence}
                  selected={proof?.sequence_id ?? null}
                  onSelect={(seq) => verify(seq)}
                />
              </CardContent>
            </Card>
          )}
        </div>

        {/* ---- proof step-through ---- */}
        <Card
          className="min-w-0"
          glow={valid}
          accent={proof ? (valid ? (anchored ? "accent" : "cyan") : "danger") : undefined}
        >
          <CardHeader>
            <div>
              <CardTitle>Proof step-through</CardTitle>
              <CardDescription>
                Recomputed in this browser with WebCrypto, not taken from the gateway
              </CardDescription>
            </div>
            {proof &&
              (anchored ? (
                <Badge variant="anchored">Anchored</Badge>
              ) : valid ? (
                <Badge variant="allowed">Cryptographically validated</Badge>
              ) : (
                <Badge variant="danger">Does not verify</Badge>
              ))}
          </CardHeader>

          {!proof ? (
            <CardContent className="grid-bg flex min-h-[420px] flex-col items-center justify-center gap-2 text-center">
              <Binary aria-hidden="true" className="size-8 text-[var(--color-fg-dim)]" />
              <p className="text-xs text-[var(--color-fg-muted)]">
                Enter a session and sequence id, or pick an entry from the log.
              </p>
              <p className="t-support max-w-xs">
                Every hash below is computed here. Nothing on this side of the page is taken on the
                gateway&apos;s word.
              </p>
            </CardContent>
          ) : (
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                  <p className="t-label">Decision</p>
                  <div className="mt-1">
                    <span title={DECISION_WHY[proof.decision] ?? proof.decision}>
                      <Badge variant={variantForReason(proof.decision)}>{proof.decision}</Badge>
                    </span>
                  </div>
                  <p className="tnum mt-2 font-mono text-sm">{formatUsdc(proof.cumulative_amount)}</p>
                  <p className="t-support">
                    seq {proof.sequence_id} · nonce {proof.nonce}
                  </p>
                </div>
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                  <p className="t-label">Position</p>
                  <p className="tnum mt-1 font-mono text-sm">
                    leaf {proof.leaf_index} of {proof.total_leaves}
                  </p>
                  <p className="t-support">
                    {proof.proof.length} sibling hop{proof.proof.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              <HashBlock label="leaf_hash" value={proof.leaf_hash} tone="fg" />

              {/* sibling path */}
              <div className="space-y-1.5">
                {steps.map((s) => (
                  <div
                    key={s.index}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="grid size-5 place-items-center rounded bg-[var(--color-bg)] font-mono text-[11px] text-[var(--color-fg-dim)]">
                        {s.index + 1}
                      </span>
                      <Badge variant="info">sibling {s.side}</Badge>
                      <span className="ml-auto font-mono text-[11px] text-[var(--color-fg-dim)]">
                        sha256({s.side === "left" ? "sibling ‖ running" : "running ‖ sibling"})
                      </span>
                    </div>
                    <div className="mt-2 grid gap-1 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-[11px] text-[var(--color-fg-dim)]">
                          running
                        </span>
                        <HashChip value={s.running} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-[11px] text-[var(--color-fg-dim)]">
                          sibling
                        </span>
                        <HashChip value={s.sibling} tone="cyan" />
                      </div>
                      <div className="flex items-center gap-2">
                        <ArrowDown aria-hidden="true" className="size-3 text-[var(--color-fg-dim)]" />
                        <HashChip value={s.result} tone="accent" />
                      </div>
                    </div>
                  </div>
                ))}
                {steps.length === 0 && (
                  <p className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 text-xs text-[var(--color-fg-muted)]">
                    Single-leaf tree: the leaf is already the root, so the proof is empty.
                  </p>
                )}
              </div>

              {/* ---- the payoff ----------------------------------------
                  Three 64-character hashes stacked in a column asks the
                  reader to diff them by eye. The marker on each row does that
                  comparison for them, and the hashes stay in full underneath
                  because the entire point of this page is that you do not have
                  to take its word for anything. */}
              <div
                className={`rounded-md border p-3 ${
                  !valid || chainDisagrees
                    ? "border-[var(--color-danger-dim)] bg-[#ef44441a]"
                    : anchored
                    ? "border-[var(--color-cyan)] bg-[#22d3ee14]"
                    : "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                }`}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {anchored ? (
                    <Badge variant="anchored">Anchored on Solana</Badge>
                  ) : chainDisagrees ? (
                    <Badge variant="danger">Chain disagrees</Badge>
                  ) : valid ? (
                    <Badge variant="allowed">Proof holds</Badge>
                  ) : (
                    <Badge variant="danger">Does not verify</Badge>
                  )}
                  <span className="t-support">
                    {anchored
                      ? "all three roots are identical"
                      : chainDisagrees
                      ? "the committed root is not the one this log produces"
                      : valid
                      ? "browser and gateway agree — nothing committed yet"
                      : "recomputation does not reproduce the reported root"}
                  </span>
                </div>

                <div className="grid gap-2">
                  {/* The reference: the only value on this page that this page
                      produced itself. Everything else is judged against it. */}
                  <RootRow
                    label="recomputed in browser"
                    value={recomputed}
                    state="reference"
                  />
                  <RootRow
                    label="root reported by gateway"
                    value={proof.merkle_root}
                    state={proof.merkle_root === recomputed ? "match" : "differs"}
                  />
                  {/* The third value is the only one neither this page nor the
                      gateway controls. It decides the audit. */}
                  <RootRow
                    label="root committed on chain"
                    value={chainRoot ?? null}
                    state={
                      chainRoot === undefined
                        ? "absent"
                        : chainRoot === recomputed
                        ? "match"
                        : "differs"
                    }
                    absentNote={
                      onChain === null
                        ? "reading the chain…"
                        : "not settled yet — nothing is committed on chain for this session"
                    }
                  />
                </div>

                <p
                  className={`mt-3 text-xs font-semibold ${
                    !valid || chainDisagrees
                      ? "text-[var(--color-danger)]"
                      : anchored
                      ? "text-[var(--color-cyan)]"
                      : "text-[var(--color-warn)]"
                  }`}
                >
                  {!valid
                    ? "Mismatch — do not trust this proof."
                    : chainDisagrees
                    ? "The chain committed a DIFFERENT root — the gateway's log does not match what it settled."
                    : anchored
                    ? "Anchored — this decision is provably covered by a root committed on Solana."
                    : "Proof holds, but nothing is anchored on chain until this session settles."}
                </p>

                {anchored && (
                  <>
                    {/* Repeatable settlement means the committed root is the
                        LATEST, not a permanently final one. Somebody about to
                        export this proof needs to know it can go stale — and
                        the honest place to say so is next to the proof, not in
                        a document they will not read. */}
                    {onChain?.root_may_advance && (
                      <p className="t-support mt-2 flex flex-wrap items-start gap-1.5 border-t border-[var(--color-cyan-dim)] pt-2">
                        <AlertTriangle
                          aria-hidden="true"
                          className="mt-px size-3 shrink-0 text-[var(--color-warn)]"
                        />
                        <span>
                          This is the <strong className="text-[var(--color-fg)]">latest</strong>{" "}
                          committed root, not a final one. Settlement is repeatable, so a later
                          settlement commits a root over more evidence entries — a proof exported
                          now will not verify against that one. Re-export after the session
                          settles for the last time.
                        </span>
                      </p>
                    )}
                    <p className="t-support mt-2 flex flex-wrap items-center gap-1 border-t border-[var(--color-cyan-dim)] pt-2">
                      <ShieldCheck aria-hidden="true" className="size-3 text-[var(--color-cyan)]" />
                      Do not take this page&apos;s word for it:{" "}
                      <code className="font-mono text-[var(--color-fg-muted)]">
                        solana account {onChain?.settlement_record} -u devnet
                      </code>
                    </p>
                  </>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function VerifierPage() {
  return (
    <React.Suspense fallback={<p className="text-xs text-[var(--color-fg-muted)]">Loading…</p>}>
      <VerifierInner />
    </React.Suspense>
  );
}
