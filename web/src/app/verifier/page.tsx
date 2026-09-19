"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowDown,
  BadgeCheck,
  Binary,
  ChevronRight,
  Link2,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type EvidenceProof, type SessionEvidence } from "@/lib/api";
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
        const allowed = e.decision === "ALLOWED";
        const active = selected === e.sequence_id;
        return (
          <button
            key={e.sequence_id}
            onClick={() => onSelect(e.sequence_id)}
            className={`w-full rounded-md border p-2.5 text-left transition-colors ${
              active
                ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="tnum grid size-5 shrink-0 place-items-center rounded bg-[var(--color-bg)] font-mono text-[10px] text-[var(--color-fg-dim)]">
                {e.sequence_id}
              </span>
              <Badge variant={allowed ? "allowed" : "denied"}>
                {allowed ? "ALLOWED" : e.decision.replace(/^ERR_/, "")}
              </Badge>
              <span className="tnum ml-auto font-mono text-[11px] text-[var(--color-fg)]">
                {formatUsdc(e.cumulative_amount)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 pl-7">
              <Link2 className="size-3 shrink-0 text-[var(--color-fg-dim)]" />
              <HashChip value={e.prev_hash} />
              <ChevronRight className="size-3 shrink-0 text-[var(--color-fg-dim)]" />
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
  const chainDisagrees =
    valid && chainRoot !== undefined && chainRoot !== recomputed;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      {/* ---- input + chain ---- */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Inclusion proof generator</CardTitle>
              <CardDescription>Prove one decision against the on-chain root</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                session_pubkey
              </label>
              <div className="flex gap-2">
                <Input
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                  placeholder="Base58 session address"
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" onClick={() => loadEvidence(session)} aria-label="Load evidence">
                  <Search />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                sequence_id
              </label>
              <div className="flex gap-2">
                <Input
                  value={sequenceId}
                  onChange={(e) => setSequenceId(e.target.value)}
                  inputMode="numeric"
                  className="font-mono text-xs"
                />
                <Button onClick={() => verify()} disabled={busy || !session.trim()}>
                  {busy ? "Verifying…" : "Verify proof"}
                </Button>
              </div>
            </div>
            {error && (
              <p className="rounded border border-[#7f1d1d] bg-[#ef44441a] px-2.5 py-2 font-mono text-[11px] text-[var(--color-danger)]">
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
              {evidence.chain_valid ? (
                <Badge variant="allowed">
                  <ShieldCheck className="size-3" /> chain intact
                </Badge>
              ) : (
                <Badge variant="danger">
                  <ShieldAlert className="size-3" /> chain broken
                </Badge>
              )}
            </CardHeader>
            <CardContent className="max-h-[520px] overflow-y-auto">
              <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                  merkle_root
                </p>
                <code className="break-all font-mono text-[11px] text-[var(--color-cyan)]">
                  {evidence.merkle_root}
                </code>
              </div>
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
      <Card glow={valid}>
        <CardHeader>
          <div>
            <CardTitle>Proof step-through</CardTitle>
            <CardDescription>
              Recomputed in this browser with WebCrypto, not taken from the gateway
            </CardDescription>
          </div>
          {proof &&
            (valid ? (
              <Badge variant="allowed">
                <BadgeCheck className="size-3" /> Cryptographically validated
              </Badge>
            ) : (
              <Badge variant="danger">
                <ShieldAlert className="size-3" /> Does not verify
              </Badge>
            ))}
        </CardHeader>

        {!proof ? (
          <CardContent className="grid-bg flex min-h-[420px] flex-col items-center justify-center gap-2 text-center">
            <Binary className="size-8 text-[var(--color-fg-dim)]" />
            <p className="text-xs text-[var(--color-fg-dim)]">
              Enter a session and sequence id, or pick an entry from the log.
            </p>
          </CardContent>
        ) : (
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">Decision</p>
                <div className="mt-1">
                  <Badge variant={proof.decision === "ALLOWED" ? "allowed" : "denied"}>
                    {proof.decision}
                  </Badge>
                </div>
                <p className="tnum mt-2 font-mono text-sm">{formatUsdc(proof.cumulative_amount)}</p>
                <p className="text-[10px] text-[var(--color-fg-dim)]">
                  seq {proof.sequence_id} · nonce {proof.nonce}
                </p>
              </div>
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">Position</p>
                <p className="tnum mt-1 font-mono text-sm">
                  leaf {proof.leaf_index} of {proof.total_leaves}
                </p>
                <p className="text-[10px] text-[var(--color-fg-dim)]">
                  {proof.proof.length} sibling hop{proof.proof.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                leaf_hash
              </p>
              <code className="break-all font-mono text-[11px] text-[var(--color-fg)]">
                {proof.leaf_hash}
              </code>
            </div>

            {/* sibling path */}
            <div className="space-y-1.5">
              {steps.map((s) => (
                <div
                  key={s.index}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="grid size-5 place-items-center rounded bg-[var(--color-bg)] font-mono text-[10px] text-[var(--color-fg-dim)]">
                      {s.index + 1}
                    </span>
                    <Badge variant="info">sibling {s.side}</Badge>
                    <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-dim)]">
                      sha256({s.side === "left" ? "sibling ‖ running" : "running ‖ sibling"})
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 pl-7">
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-[10px] text-[var(--color-fg-dim)]">running</span>
                      <HashChip value={s.running} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-[10px] text-[var(--color-fg-dim)]">sibling</span>
                      <HashChip value={s.sibling} tone="cyan" />
                    </div>
                    <div className="flex items-center gap-2">
                      <ArrowDown className="size-3 text-[var(--color-fg-dim)]" />
                      <HashChip value={s.result} tone="accent" />
                    </div>
                  </div>
                </div>
              ))}
              {steps.length === 0 && (
                <p className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 text-[11px] text-[var(--color-fg-dim)}">
                  Single-leaf tree: the leaf is already the root, so the proof is empty.
                </p>
              )}
            </div>

            {/* comparison */}
            <div
              className={`rounded-md border p-3 ${
                valid
                  ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                  : "border-[#7f1d1d] bg-[#ef44441a]"
              }`}
            >
              <div className="grid gap-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    recomputed in browser
                  </p>
                  <code className="break-all font-mono text-[11px]">{recomputed}</code>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    root reported by gateway
                  </p>
                  <code className="break-all font-mono text-[11px]">{proof.merkle_root}</code>
                </div>
                {/* The third value is the only one neither this page nor the
                    gateway controls. It decides the audit. */}
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">
                    root committed on chain
                  </p>
                  {chainRoot !== undefined ? (
                    <code
                      className={`break-all font-mono text-[11px] ${
                        anchored ? "text-[var(--color-accent)]" : "text-[var(--color-danger)]"
                      }`}
                    >
                      {chainRoot}
                    </code>
                  ) : (
                    <span className="text-[11px] text-[var(--color-fg-dim)]">
                      {onChain === null
                        ? "reading the chain…"
                        : "not settled yet — nothing is committed on chain for this session"}
                    </span>
                  )}
                </div>
              </div>
              <p
                className={`mt-2 text-xs font-semibold ${
                  !valid || chainDisagrees
                    ? "text-[var(--color-danger)]"
                    : anchored
                    ? "text-[var(--color-accent)]"
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
                <p className="mt-1 text-[10px] text-[var(--color-fg-dim)]">
                  Check it yourself:{" "}
                  <code className="font-mono">
                    solana account {onChain?.settlement_record} -u devnet
                  </code>
                </p>
              )}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

export default function VerifierPage() {
  return (
    <React.Suspense fallback={<p className="text-xs text-[var(--color-fg-dim)]">Loading…</p>}>
      <VerifierInner />
    </React.Suspense>
  );
}
