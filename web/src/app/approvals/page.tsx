"use client";

import * as React from "react";
import { Check, Loader2, TriangleAlert, UserCheck, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
 */

const FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All" },
];

function stateBadge(state: Approval["state"]) {
  switch (state) {
    case "approved":
      return <Badge variant="allowed">approved</Badge>;
    case "consumed":
      return <Badge variant="neutral">spent</Badge>;
    case "rejected":
      // Amber, not red: a person said no. That is the system working.
      return <Badge variant="denied">rejected</Badge>;
    default:
      return <Badge variant="denied">awaiting a decision</Badge>;
  }
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ApprovalsPage() {
  const toast = useToast();
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [agents, setAgents] = React.useState<Record<string, Agent>>({});
  const [filter, setFilter] = React.useState("pending");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

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

  const shown = approvals.filter((a) => (filter === "pending" ? a.state === "pending" : true));
  const pendingCount = approvals.filter((a) => a.state === "pending").length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page">Approvals</h1>
          <p className="t-body mt-1 max-w-2xl">
            Spends an agent may not make on its own. Each decision authorises exactly one purchase.
          </p>
        </div>
        {pendingCount > 0 ? (
          <Badge variant="denied">
            {pendingCount} waiting on you
          </Badge>
        ) : (
          loaded && !unavailable && <Badge variant="allowed">nothing waiting</Badge>
        )}
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="min-w-0" accent={pendingCount > 0 ? "warn" : undefined}>
          <CardHeader className="flex-wrap gap-2">
            <div>
              <CardTitle>Queue</CardTitle>
              <CardDescription>Spends waiting on a person</CardDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Segmented options={FILTERS} value={filter} onChange={setFilter} />
              <Badge variant={pendingCount > 0 ? "denied" : "neutral"}>{pendingCount}</Badge>
            </div>
          </CardHeader>
          <CardContent className="max-h-[640px] space-y-1.5 overflow-y-auto p-2">
            {unavailable && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-3">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]"
                />
                <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                  <span className="font-semibold text-[var(--color-warn)]">
                    The control plane is unavailable.
                  </span>{" "}
                  Approvals need a database, and this gateway is running without one.
                </p>
              </div>
            )}

            {loaded && !unavailable && shown.length === 0 && (
              <div className="py-12 text-center">
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {filter === "pending"
                    ? "Nothing is waiting on you."
                    : "No spend has ever needed a decision."}
                </p>
                <p className="t-support mx-auto mt-1 max-w-xs">
                  {filter === "pending"
                    ? "A request appears here the moment an agent asks for something above its threshold."
                    : "Every purchase so far was inside an agent's envelope."}
                </p>
              </div>
            )}

            {shown.map((a) => {
              const agent = agents[a.agent_id];
              const pending = a.state === "pending";
              return (
                <div
                  key={a.approval_id}
                  className={`rounded-md border p-2.5 ${
                    pending
                      ? "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-[var(--color-fg)]">
                      {agent?.label ?? a.agent_id}
                    </span>
                    {stateBadge(a.state)}
                    <code className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                      {a.resource}
                    </code>
                    <span className="tnum ml-auto font-mono text-xs text-[var(--color-fg)]">
                      {formatUsdc(a.price)}
                    </span>
                  </div>

                  <p className="t-support mt-1">
                    {ago(a.created_at)}
                    {a.calls > 1 && ` · ${a.calls} calls`}
                    {agent?.policy &&
                      ` · ${formatUsdc(agent.spent)} of ${formatUsdc(agent.policy.max_total)} used`}
                    {a.reason && ` · ${a.reason}`}
                  </p>

                  {/* The trail. A decided approval that cannot name its decider
                      is a workflow, not an audit record — so say who, and say
                      plainly when the record predates per-operator credentials
                      rather than leaving a blank to be misread. */}
                  {a.decided_at && (
                    <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                      {a.state === "rejected" ? "Rejected" : "Approved"} by{" "}
                      <span className="font-medium text-[var(--color-fg)]">
                        {a.decided_by_label ?? "an unrecorded operator"}
                      </span>
                      {!a.decided_by_label && " — decided before per-operator credentials existed"}
                    </p>
                  )}

                  {agent && (
                    <div className="mt-1">
                      <MonoKey value={agent.agent_pubkey} head={6} tail={6} />
                    </div>
                  )}

                  {pending && (
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => decide(a.approval_id, true)}
                        disabled={busy === a.approval_id}
                      >
                        {busy === a.approval_id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Check className="size-3" />
                        )}
                        Approve once
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => decide(a.approval_id, false)}
                        disabled={busy === a.approval_id}
                      >
                        <X className="size-3" />
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>How this works</CardTitle>
              <CardDescription>What a click does, and what it does not</CardDescription>
            </div>
            <UserCheck aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
          </CardHeader>
          <CardContent className="space-y-3 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
            <p>
              An agent in <span className="font-mono text-[var(--color-fg)]">human</span> mode needs
              a decision for every spend. An agent in{" "}
              <span className="font-mono text-[var(--color-fg)]">autonomous</span> mode needs one
              only at or above its approval threshold.
            </p>
            <p>
              <span className="font-semibold text-[var(--color-fg)]">Approve once</span> means
              exactly that. The approval is single-use and bound to this resource at this price: it
              authorises one purchase, then it is spent. A standing permission would turn a
              moment&apos;s inattention into an unbounded budget.
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
            <p className="border-t border-[var(--color-border)] pt-2.5">
              <span className="font-semibold text-[var(--color-fg)]">
                What approving cannot do:
              </span>{" "}
              exceed the agent&apos;s envelope or its on-chain escrow. A spend the policy would
              refuse never reaches you as a request — you are only ever asked about purchases that
              are already permitted.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
