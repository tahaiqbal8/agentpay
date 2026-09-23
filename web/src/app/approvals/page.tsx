"use client";

import * as React from "react";
import { Check, ChevronDown, Loader2, TriangleAlert, UserCheck, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonRows } from "@/components/empty-state";
import { MonoKey } from "@/components/mono";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/toast";
import { api, type Agent, type Approval } from "@/lib/api";
import { formatUsdc } from "@/lib/format";

/**
 * The human half of human-controlled mode.
 *
 * Design point worth keeping: an agent whose spend needs approval is REFUSED,
 * not held. It retries once a decision lands. A queued HTTP request would
 * occupy a connection until somebody happened to look at this page, which could
 * be hours.
 *
 * The other one: an approval is single-use and bound to a resource and a price.
 * One click authorises one purchase, not a standing permission — otherwise a
 * moment's inattention becomes an unbounded budget.
 *
 * Layout rule: a pending request is the ONLY thing that matters on this page,
 * so it is a full-width card with the four facts a person needs to decide, and
 * everything already decided is a compact line underneath. The queue used to
 * be a scrolling list where pending and settled items looked alike.
 */

const FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All" },
];

function stateBadge(state: Approval["state"]) {
  switch (state) {
    case "approved":
      return <Badge variant="allowed">Approved</Badge>;
    case "consumed":
      return <Badge variant="neutral">Spent</Badge>;
    case "rejected":
      // Amber, not red: a person said no. That is the system working.
      return <Badge variant="denied">Rejected</Badge>;
    default:
      return <Badge variant="denied">Awaiting a decision</Badge>;
  }
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** One request, as a decision rather than a row. */
function PendingApproval({
  approval,
  agent,
  busy,
  onDecide,
}: {
  approval: Approval;
  agent: Agent | undefined;
  busy: boolean;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#f59e0b1a]">
          <UserCheck className="size-4 text-[var(--color-warn)]" />
        </span>
        <span className="text-[15px] font-semibold text-[var(--color-fg)]">
          Spend needs your decision
        </span>
        <span className="t-support ml-auto">{ago(approval.created_at)}</span>
      </div>

      {/* The four facts, each one large enough to read without leaning in. */}
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="t-label">Agent</dt>
          <dd className="mt-1 text-[15px] font-medium text-[var(--color-fg)]">
            {agent?.label ?? approval.agent_id}
          </dd>
          {agent && (
            <dd className="mt-1">
              <MonoKey value={agent.agent_pubkey} head={6} tail={6} />
            </dd>
          )}
        </div>
        <div>
          <dt className="t-label">Requested resource</dt>
          <dd className="t-mono mt-1 text-[13px] text-[var(--color-fg)]">{approval.resource}</dd>
          {approval.calls > 1 && (
            <dd className="t-support mt-1">{approval.calls} calls</dd>
          )}
        </div>
        <div>
          <dt className="t-label">Price</dt>
          <dd className="tnum mt-1 text-[20px] font-semibold leading-none text-[var(--color-fg)]">
            {formatUsdc(approval.price)}
          </dd>
          {agent?.policy && (
            <dd className="t-support mt-1.5">
              {formatUsdc(agent.spent)} of {formatUsdc(agent.policy.max_total)} envelope used
            </dd>
          )}
        </div>
      </dl>

      {/* `reason` comes from the gateway. When it does not send one, say why
          this is being asked from what we DO know, rather than inventing a
          quote and attributing it to the policy engine. */}
      <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <p className="t-label">Reason</p>
        <p className="t-body mt-1">
          {approval.reason ??
            (agent?.mode === "human"
              ? "This agent runs in human mode, so every spend needs a person."
              : "This spend is at or above the agent's approval threshold.")}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => onDecide(true)} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Approve
        </Button>
        <Button variant="danger" onClick={() => onDecide(false)} disabled={busy}>
          <X className="size-3.5" />
          Reject
        </Button>
        <p className="t-support sm:ml-2">
          Approving authorizes <strong className="text-[var(--color-fg)]">this purchase only</strong>
          . The approval is single-use and bound to this resource at this price.
        </p>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const toast = useToast();
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [agents, setAgents] = React.useState<Record<string, Agent>>({});
  const [filter, setFilter] = React.useState("pending");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [how, setHow] = React.useState(false);

  const load = React.useCallback(async () => {
    const [ap, ag] = await Promise.all([api.approvals(), api.agents()]);
    setLoaded(true);
    if (!ap.ok) {
      setUnavailable(ap.error.reason_code === "ERR_CONTROL_PLANE_UNAVAILABLE");
      return;
    }
    setUnavailable(false);
    setApprovals(ap.data.approvals);
    if (ag.ok) {
      setAgents(Object.fromEntries(ag.data.agents.map((a) => [a.agent_id, a])));
    }
  }, []);

  React.useEffect(() => {
    void load();
    // A person watching this page should see a request arrive without a manual
    // refresh; an agent is blocked until they act.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const decide = async (id: string, approved: boolean) => {
    setBusy(id);
    const res = await api.decideApproval(id, approved);
    setBusy(null);
    if (!res.ok) {
      toast({ kind: "error", title: "Decision not recorded", body: res.error.reason_code });
      return;
    }
    toast({
      kind: approved ? "success" : "error",
      title: approved ? "Spend approved" : "Spend rejected",
      body: approved ? "The agent may retry once." : "The agent stays refused.",
    });
    setApprovals(res.data.approvals);
  };

  const pending = approvals.filter((a) => a.state === "pending");
  const decided = approvals.filter((a) => a.state !== "pending");
  const shownDecided = filter === "pending" ? [] : decided;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-page brand-gradient-text">Human approvals</h1>
          <p className="t-body mt-1.5 max-w-2xl">
            Explicit human control for spending outside autonomous policy. Each decision authorises
            exactly one purchase.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pending.length > 0 ? (
            <Badge variant="denied">{pending.length} waiting on you</Badge>
          ) : (
            loaded && !unavailable && <Badge variant="allowed">Nothing waiting</Badge>
          )}
        </div>
      </header>

      {unavailable && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-4">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]"
          />
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
            <span className="font-semibold text-[var(--color-warn)]">
              The control plane is unavailable.
            </span>{" "}
            Approvals need a database, and this gateway is running without one.
          </p>
        </div>
      )}

      {!loaded && !unavailable && (
        <Card>
          <SkeletonRows rows={2} />
        </Card>
      )}

      {/* ---- what needs you, full width and first ---- */}
      {pending.length > 0 && (
        <section aria-label="Pending approvals" className="space-y-3">
          {pending.map((a) => (
            <PendingApproval
              key={a.approval_id}
              approval={a}
              agent={agents[a.agent_id]}
              busy={busy === a.approval_id}
              onDecide={(ok) => decide(a.approval_id, ok)}
            />
          ))}
        </section>
      )}

      {loaded && !unavailable && pending.length === 0 && (
        <Card>
          <EmptyState
            icon={UserCheck}
            title="Nothing is waiting on you"
            body={
              decided.length > 0
                ? "Every spend so far was inside an agent's envelope, or has already been decided. A request appears here the moment an agent asks for something above its threshold."
                : "No spend has ever needed a decision. A request appears here the moment an agent asks for something above its threshold."
            }
          />
        </Card>
      )}

      {/* ---- what has already been decided ---- */}
      {loaded && !unavailable && decided.length > 0 && (
        <Card className="min-w-0">
          <CardHeader className="flex-wrap gap-2">
            <div>
              <CardTitle>Decision history</CardTitle>
              <CardDescription>Who decided what, and when</CardDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Segmented options={FILTERS} value={filter} onChange={setFilter} />
              <Badge variant="neutral">{decided.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="max-h-[520px] space-y-1.5 overflow-y-auto p-2">
            {filter === "pending" && (
              <p className="t-support px-2 py-6 text-center">
                Showing pending only. Switch to <strong>All</strong> to see {decided.length}{" "}
                decided request{decided.length === 1 ? "" : "s"}.
              </p>
            )}
            {shownDecided.map((a) => {
              const agent = agents[a.agent_id];
              return (
                <div
                  key={a.approval_id}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-fg)]">
                      {agent?.label ?? a.agent_id}
                    </span>
                    {stateBadge(a.state)}
                    <code className="t-mono text-[var(--color-fg-muted)]">{a.resource}</code>
                    <span className="tnum ml-auto text-[13px] text-[var(--color-fg)]">
                      {formatUsdc(a.price)}
                    </span>
                  </div>
                  {/* The trail. A decided approval that cannot name its decider
                      is a workflow, not an audit record — so say who, and say
                      plainly when the record predates per-operator credentials
                      rather than leaving a blank to be misread. */}
                  {a.decided_at ? (
                    <p className="t-support mt-1">
                      {a.state === "rejected" ? "Rejected" : "Approved"} by{" "}
                      <span className="font-medium text-[var(--color-fg)]">
                        {a.decided_by_label ?? "an unrecorded operator"}
                      </span>
                      {!a.decided_by_label && " — decided before per-operator credentials existed"}
                      {" · "}
                      {ago(a.decided_at)}
                    </p>
                  ) : (
                    <p className="t-support mt-1">{ago(a.created_at)}</p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ---- the explanation, folded ---- */}
      <Card>
        <button
          onClick={() => setHow((v) => !v)}
          aria-expanded={how}
          className="flex w-full items-center gap-2 p-4 text-left"
        >
          <UserCheck aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
          <span className="t-section">What a click does, and what it does not</span>
          <ChevronDown
            className={`ml-auto size-4 text-[var(--color-fg-dim)] transition-transform ${
              how ? "rotate-180" : ""
            }`}
          />
        </button>
        {how && (
          <CardContent className="space-y-3 border-t border-[var(--color-border)] pt-4 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
            <p>
              An agent in <span className="font-mono text-[var(--color-fg)]">human</span> mode needs
              a decision for every spend. An agent in{" "}
              <span className="font-mono text-[var(--color-fg)]">autonomous</span> mode needs one
              only at or above its approval threshold.
            </p>
            <p>
              <span className="font-semibold text-[var(--color-fg)]">Approve</span> is single-use
              and bound to this resource at this price: it authorises one purchase, then it is
              spent. A standing permission would turn a moment&apos;s inattention into an unbounded
              budget.
            </p>
            <p>
              While a spend waits, the agent is{" "}
              <span className="font-mono text-[var(--color-warn)]">ERR_APPROVAL_REQUIRED</span> —
              refused, not held. It retries after you decide. Holding the request open would occupy
              a connection until somebody happened to look at this page.
            </p>
            <p>
              A retry does not queue a second copy: one pending proposal exists per agent, resource
              and price.
            </p>
            <p>
              <span className="font-semibold text-[var(--color-fg)]">Who decided is recorded.</span>{" "}
              Each decision stores the operator id and their name <em>as it was at that moment</em>{" "}
              — a snapshot, not a lookup, so renaming or removing an operator later cannot rewrite
              who approved what. A decision made with the shared admin token is recorded as exactly
              that.
            </p>
            <p className="border-t border-[var(--color-border)] pt-3">
              <span className="font-semibold text-[var(--color-fg)]">
                What approving cannot do:
              </span>{" "}
              exceed the agent&apos;s envelope or its on-chain escrow. A spend the policy would
              refuse never reaches you as a request — you are only ever asked about purchases that
              are already permitted.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
