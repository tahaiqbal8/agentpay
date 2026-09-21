"use client";

import * as React from "react";
import { Bot, Loader2, Plus, ShieldOff, ShieldCheck, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/toast";
import { api, type Agent, type AgentMode } from "@/lib/api";
import { formatUsdc } from "@/lib/format";

/**
 * Agent identity and authorization — stages 1 to 4 of the flow.
 *
 * The distinction this page has to keep visible: an agent's ESCROW is the hard,
 * chain-enforced ceiling, and the envelope set here can only narrow it. A
 * reader who confuses the two would think suspending an agent claws back its
 * deposit, or that raising `max_total` gives it more money. Neither is true.
 */

function AgentCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const [maxTotal, setMaxTotal] = React.useState(agent.policy?.max_total ?? "1000000");
  const [maxPerCall, setMaxPerCall] = React.useState(agent.policy?.max_per_call ?? "25000");
  const [threshold, setThreshold] = React.useState(agent.policy?.approval_threshold ?? "");
  const [resources, setResources] = React.useState(
    (agent.policy?.allowed_resources ?? []).join(", ")
  );
  const [maxCalls, setMaxCalls] = React.useState(
    agent.policy?.max_calls != null ? String(agent.policy.max_calls) : ""
  );
  const [mode, setMode] = React.useState<AgentMode>(agent.mode);

  const suspended = agent.status === "suspended";
  // Ids are namespaced per agent: several of these cards are open at once, and
  // duplicate ids would point every label at the first card's input.
  const id = (name: string) => `${agent.agent_id}-${name}`;

  // Percentage of the ENVELOPE consumed, not of the escrow. BigInt throughout:
  // no float touches an amount, here or anywhere else.
  const pct = React.useMemo(() => {
    if (!agent.policy) return null;
    try {
      const total = BigInt(agent.policy.max_total);
      if (total === 0n) return null;
      return Number((BigInt(agent.spent) * 100n) / total);
    } catch {
      return null;
    }
  }, [agent]);

  const authorize = async () => {
    setBusy(true);
    const list = resources
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const res = await api.authorizeAgent(agent.agent_id, {
      max_total: maxTotal.trim(),
      max_per_call: maxPerCall.trim(),
      approval_threshold: threshold.trim() === "" ? null : threshold.trim(),
      allowed_resources: list.length > 0 ? list : null,
      max_calls: maxCalls.trim() === "" ? null : Number(maxCalls),
      mode,
    });
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: "Authorization refused", body: res.error.reason_code });
      return;
    }
    toast({ kind: "success", title: "Agent authorized", body: agent.label });
    setOpen(false);
    onChanged();
  };

  const toggleStatus = async () => {
    setBusy(true);
    const res = await api.setAgentStatus(agent.agent_id, suspended ? "active" : "suspended");
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: "Status change refused", body: res.error.reason_code });
      return;
    }
    toast({
      kind: suspended ? "success" : "error",
      title: suspended ? "Agent reinstated" : "Agent suspended",
      body: suspended ? "It can spend again." : "It cannot spend, whatever its escrow holds.",
    });
    onChanged();
  };

  return (
    <div
      className={`rounded-md border p-3 ${
        suspended
          ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
          : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className={`grid size-6 shrink-0 place-items-center rounded-md ${
            suspended ? "bg-[#ef44441a]" : "bg-[#a78bfa1a]"
          }`}
        >
          <Bot
            className={`size-3.5 ${
              suspended ? "text-[var(--color-danger)]" : "text-[var(--color-agent)]"
            }`}
          />
        </span>
        <span className="text-sm font-medium text-[var(--color-fg)]">{agent.label}</span>
        <Badge variant={suspended ? "danger" : "allowed"}>{agent.status}</Badge>
        {/* Purple is the agent/policy colour throughout the console: the mode
            is what the human decided about autonomy, not a status. */}
        <Badge variant="agent">{agent.mode}</Badge>
        <span className="ml-auto">
          <MonoKey value={agent.agent_pubkey} head={6} tail={6} />
        </span>
      </div>

      {agent.policy ? (
        <div className="mt-2.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="tnum font-mono text-[var(--color-fg)]">
              {formatUsdc(agent.spent)} / {formatUsdc(agent.policy.max_total)}
            </span>
            <span className="t-support">
              {agent.calls} call{agent.calls === 1 ? "" : "s"}
              {agent.policy.max_calls != null && ` of ${agent.policy.max_calls}`}
              {agent.remaining != null && ` · ${formatUsdc(agent.remaining)} left`}
            </span>
          </div>
          {pct != null && (
            <div className="mt-1.5">
              <Progress
                percent={Math.min(pct, 100)}
                tone={pct >= 90 ? "warn" : "agent"}
                label={`${pct}% of this agent's envelope has been spent`}
              />
            </div>
          )}
          <p className="t-support mt-1.5 leading-relaxed">
            Max {formatUsdc(agent.policy.max_per_call)} per call
            {agent.policy.approval_threshold != null &&
              ` · a human decides at ${formatUsdc(agent.policy.approval_threshold)}`}
            {agent.policy.allowed_resources?.length
              ? ` · ${agent.policy.allowed_resources.join(", ")}`
              : " · any resource"}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-warn)]">
          Not authorized. Only this agent&apos;s on-chain escrow bounds it — there is no
          per-resource or per-call limit until one is set.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
          aria-expanded={open}
        >
          {agent.policy ? "Edit authorization" : "Authorize"}
        </Button>
        <Button
          size="sm"
          variant={suspended ? "outline" : "danger"}
          onClick={toggleStatus}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : suspended ? (
            <ShieldCheck className="size-3" />
          ) : (
            <ShieldOff className="size-3" />
          )}
          {suspended ? "Reinstate" : "Suspend"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <p className="t-support leading-relaxed">
            All amounts are micro-USDC. This envelope can only narrow what the escrow already
            permits — it never grants more.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label="max_total" hint="Ceiling across everything" htmlFor={id("max-total")}>
              <Input
                id={id("max-total")}
                value={maxTotal}
                onChange={(e) => setMaxTotal(e.target.value)}
              />
            </Field>
            <Field label="max_per_call" hint="Ceiling on one purchase" htmlFor={id("max-per-call")}>
              <Input
                id={id("max-per-call")}
                value={maxPerCall}
                onChange={(e) => setMaxPerCall(e.target.value)}
              />
            </Field>
            <Field label="approval_threshold" hint="Blank = never ask" htmlFor={id("threshold")}>
              <Input
                id={id("threshold")}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
            <Field label="max_calls" hint="Blank = unlimited" htmlFor={id("max-calls")}>
              <Input
                id={id("max-calls")}
                value={maxCalls}
                onChange={(e) => setMaxCalls(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="allowed_resources"
            hint="Comma separated. Blank = any resource."
            htmlFor={id("resources")}
          >
            <Input
              id={id("resources")}
              value={resources}
              onChange={(e) => setResources(e.target.value)}
              placeholder="/weather, /quote"
            />
          </Field>
          <Field
            label="mode"
            hint="Human mode asks a person for every spend."
            htmlFor={id("mode")}
          >
            <Select
              id={id("mode")}
              value={mode}
              onChange={(e) => setMode(e.target.value as AgentMode)}
            >
              <option value="human">human — a person approves each spend</option>
              <option value="autonomous">autonomous — acts alone inside the envelope</option>
            </Select>
          </Field>
          <Button size="sm" onClick={authorize} disabled={busy} className="w-full">
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Save authorization
          </Button>
        </div>
      )}
    </div>
  );
}

export default function AgentsPage() {
  const toast = useToast();
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [pubkey, setPubkey] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await api.agents();
    setLoaded(true);
    if (!res.ok) {
      // The control plane needs a database. Saying so beats an empty list that
      // reads as "no agents exist".
      setUnavailable(res.error.reason_code === "ERR_CONTROL_PLANE_UNAVAILABLE");
      return;
    }
    setUnavailable(false);
    setAgents(res.data.agents);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    const res = await api.createAgent({
      label: label.trim(),
      agent_pubkey: pubkey.trim(),
      owner_pubkey: owner.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: "Agent not created", body: res.error.reason_code });
      return;
    }
    toast({ kind: "success", title: "Agent created", body: res.data.agent_id });
    setLabel("");
    setPubkey("");
    setOwner("");
    void load();
  };

  const suspendedCount = agents.filter((a) => a.status === "suspended").length;
  const unauthorized = agents.filter((a) => !a.policy).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page">Agents</h1>
          <p className="t-body mt-1 max-w-2xl">
            Who may spend, and how much. The escrow on chain is the hard ceiling; everything set
            here narrows it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unauthorized > 0 && (
            <Badge variant="denied">{unauthorized} without an envelope</Badge>
          )}
          {suspendedCount > 0 && <Badge variant="danger">{suspendedCount} suspended</Badge>}
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>Agents</CardTitle>
              <CardDescription>Identity, wallet and permission envelope</CardDescription>
            </div>
            <Badge variant="neutral">{agents.length}</Badge>
          </CardHeader>
          <CardContent className="max-h-[640px] space-y-2 overflow-y-auto p-2">
            {unavailable && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-3">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]"
                />
                <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  <span className="font-semibold text-[var(--color-warn)]">
                    The control plane is unavailable.
                  </span>{" "}
                  Agents, policies and the registry need a database, and this gateway is running
                  without one. Claims are still verified; nothing here can be stored.
                </p>
              </div>
            )}
            {loaded && !unavailable && agents.length === 0 && (
              <div className="py-12 text-center">
                <p className="text-xs text-[var(--color-fg-muted)]">No agents yet.</p>
                <p className="t-support mx-auto mt-1 max-w-xs">
                  Create one to bind a wallet to an identity and set what it may spend.
                </p>
              </div>
            )}
            {agents.map((a) => (
              <AgentCard key={a.agent_id} agent={a} onChanged={load} />
            ))}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card accent="agent">
            <CardHeader>
              <div>
                <CardTitle>New agent</CardTitle>
                <CardDescription>Bind an Ed25519 wallet to an identity</CardDescription>
              </div>
              <Plus aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="label" htmlFor="new-agent-label">
                <Input
                  id="new-agent-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Research bot"
                />
              </Field>
              <Field
                label="agent_pubkey"
                hint="The key the agent signs its claims with."
                htmlFor="new-agent-pubkey"
              >
                <Input
                  id="new-agent-pubkey"
                  value={pubkey}
                  onChange={(e) => setPubkey(e.target.value)}
                  placeholder="Base58 Ed25519 public key"
                />
              </Field>
              <Field
                label="owner_pubkey"
                hint="Optional. The human who owns it."
                htmlFor="new-agent-owner"
              >
                <Input
                  id="new-agent-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="Base58, optional"
                />
              </Field>
              <Button
                onClick={create}
                disabled={busy || !label.trim() || !pubkey.trim() || unavailable}
                className="w-full"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                Create agent
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What creating an agent does not do</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs leading-relaxed text-[var(--color-fg-muted)]">
              <p>
                It does not create a wallet, hold a private key, or move any money. The
                agent&apos;s spending power comes entirely from an on-chain escrow opened against
                this key. The envelope set here can only narrow that — never widen it.
              </p>
              <p>
                Suspending an agent stops it at this gateway immediately. It does not claw back the
                escrow, and it does not recall a settlement already in flight.
              </p>
              <p className="border-t border-[var(--color-border)] pt-2.5">
                An agent with no envelope is not unrestricted — its escrow still bounds it
                absolutely — but nothing narrower applies: no per-call ceiling, no resource
                allowlist, no approval step.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
