"use client";

import * as React from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  Plus,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonCards } from "@/components/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { useToast } from "@/components/toast";
import { api, type Agent, type AgentMode } from "@/lib/api";
import { formatUsdc, formatUsdcCompact } from "@/lib/format";

/**
 * Agent identity and authorization — stages 1 to 3 of the lifecycle.
 *
 * The distinction this page has to keep visible: an agent's ESCROW is the hard,
 * chain-enforced ceiling, and the envelope set here can only narrow it. A
 * reader who confuses the two would think suspending an agent claws back its
 * deposit, or that raising `max_total` gives it more money. Neither is true.
 *
 * Layout rule: identity first, permissions second, raw fields last and folded
 * away. The old card led with a base58 key and a form; that is a database row
 * with buttons, and it made a control surface look like an admin panel.
 */

/** The three states an agent can actually be in. There is no fourth. */
type AuthState = "authorized" | "unauthorized" | "paused";

function authState(agent: Agent): AuthState {
  if (agent.status === "suspended") return "paused";
  return agent.policy ? "authorized" : "unauthorized";
}

const AUTH_BADGE: Record<AuthState, { variant: "allowed" | "denied" | "danger"; label: string }> = {
  authorized: { variant: "allowed", label: "Authorized" },
  unauthorized: { variant: "denied", label: "Not authorized" },
  paused: { variant: "danger", label: "Paused" },
};

function AgentCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [details, setDetails] = React.useState(false);

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

  const state = authState(agent);
  const suspended = state === "paused";
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

  const badge = AUTH_BADGE[state];

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        suspended
          ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
          : "surface-card hover:border-[var(--color-border-bright)]"
      }`}
    >
      {/* ---- identity ---- */}
      <div className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden="true"
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${
            suspended ? "bg-[#ef44441a]" : "bg-[var(--color-agent-glow)]"
          }`}
        >
          <Bot
            className={`size-4.5 ${
              suspended ? "text-[var(--color-danger)]" : "text-[var(--color-agent)]"
            }`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold leading-tight text-[var(--color-fg)]">
              {agent.label}
            </span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {/* Purple is the agent/policy colour throughout the console: the
                mode is what the human decided about autonomy, not a status. */}
            <Badge variant="agent">{agent.mode}</Badge>
          </div>
          <p className="t-support mt-1">
            {agent.calls} call{agent.calls === 1 ? "" : "s"} ·{" "}
            {formatUsdc(agent.spent)} spent
          </p>
        </div>
      </div>

      {/* ---- permissions, as facts rather than fields ---- */}
      {agent.policy ? (
        <div className="mt-4 space-y-3">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="t-label">Spending</span>
              <span className="tnum text-[13px] text-[var(--color-fg)]">
                {formatUsdc(agent.spent)}{" "}
                <span className="text-[var(--color-fg-dim)]">
                  / {formatUsdc(agent.policy.max_total)}
                </span>
              </span>
            </div>
            {pct != null && (
              <div className="mt-2">
                <Progress
                  percent={Math.min(pct, 100)}
                  tone={pct >= 90 ? "warn" : "agent"}
                  label={`${pct}% of this agent's envelope has been spent`}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="t-label">Per call</p>
              <p className="tnum mt-1 text-[13px] text-[var(--color-fg)]">
                {formatUsdc(agent.policy.max_per_call)}
              </p>
            </div>
            <div>
              <p className="t-label">Remaining</p>
              <p className="tnum mt-1 text-[13px] text-[var(--color-fg)]">
                {agent.remaining != null ? formatUsdc(agent.remaining) : "—"}
              </p>
            </div>
          </div>

          <div>
            <p className="t-label">Resources</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {agent.policy.allowed_resources?.length ? (
                agent.policy.allowed_resources.map((r) => (
                  <span
                    key={r}
                    className="t-mono rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[var(--color-fg-muted)]"
                  >
                    {r}
                  </span>
                ))
              ) : (
                <span className="t-support">Any resource — no allowlist set</span>
              )}
            </div>
          </div>

          {agent.policy.approval_threshold != null && (
            <p className="t-support">
              A human decides above {formatUsdc(agent.policy.approval_threshold)}.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-[13px] leading-relaxed text-[var(--color-warn)]">
          Not authorized. Only this agent&apos;s on-chain escrow bounds it — there is no
          per-resource or per-call limit until one is set.
        </p>
      )}

      {/* ---- actions ---- */}
      <div className="mt-4 flex flex-wrap gap-2">
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
        <button
          onClick={() => setDetails((v) => !v)}
          aria-expanded={details}
          className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
        >
          Technical details
          <ChevronDown className={`size-3 transition-transform ${details ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* ---- the raw identity, folded away by default ---- */}
      {details && (
        <dl className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="t-label">agent_id</dt>
            <dd className="t-mono text-[var(--color-fg-muted)]">{agent.agent_id}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="t-label">agent_pubkey</dt>
            <dd>
              <MonoKey value={agent.agent_pubkey} head={6} tail={6} />
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="t-label">owner_pubkey</dt>
            <dd>
              {agent.owner_pubkey ? (
                <MonoKey value={agent.owner_pubkey} head={6} tail={6} />
              ) : (
                <span className="t-support">—</span>
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="t-label">created</dt>
            <dd className="t-support">{new Date(agent.created_at).toLocaleString()}</dd>
          </div>
        </dl>
      )}

      {/* ---- the envelope editor ---- */}
      {open && (
        <div className="mt-3 space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <p className="t-support leading-relaxed">
            All amounts are micro-USDC. This envelope can only narrow what the escrow already
            permits — it never grants more.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
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
          <Field label="mode" hint="Human mode asks a person for every spend." htmlFor={id("mode")}>
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
  const [creating, setCreating] = React.useState(false);
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
    setCreating(false);
    void load();
  };

  /* Counted, never estimated. `paused` and `unauthorized` are mutually
     exclusive by `authState`, so these four numbers describe the list without
     double-counting it. */
  const active = agents.filter((a) => authState(a) === "authorized").length;
  const unauthorized = agents.filter((a) => authState(a) === "unauthorized").length;
  const paused = agents.filter((a) => authState(a) === "paused").length;
  const controlled = agents.reduce((acc, a) => {
    try {
      return acc + BigInt(a.policy?.max_total ?? "0");
    } catch {
      return acc;
    }
  }, 0n);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-page brand-gradient-text">Agents</h1>
          <p className="t-body mt-1.5 max-w-2xl">
            Manage agents and their spending permissions. The escrow on chain is the
            hard ceiling; everything set here narrows it.
          </p>
        </div>
        <Button onClick={() => setCreating((v) => !v)} disabled={unavailable}>
          {creating ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
          {creating ? "Cancel" : "Create agent"}
        </Button>
      </header>

      <section aria-label="Agent summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Authorized"
          value={String(active)}
          support={active > 0 ? "acting inside an envelope" : "none carry a policy yet"}
          icon={ShieldCheck}
          tone={active > 0 ? "accent" : "neutral"}
        />
        <Stat
          label="Awaiting authorization"
          value={String(unauthorized)}
          support={
            unauthorized > 0 ? "bounded only by their escrow" : "every agent has an envelope"
          }
          icon={TriangleAlert}
          tone={unauthorized > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Paused"
          value={String(paused)}
          support={paused > 0 ? "cannot spend at this gateway" : "none suspended"}
          icon={ShieldOff}
          tone={paused > 0 ? "danger" : "neutral"}
        />
        {/* The sum of every envelope — what a human has AUTHORIZED, which is
            not what has been spent and not what is escrowed. Named so. */}
        <Stat
          label="Authorized ceiling"
          value={formatUsdcCompact(controlled)}
          support="total of every envelope"
          icon={Wallet}
          tone="agent"
        />
      </section>

      {creating && (
        <Card accent="agent">
          <CardHeader>
            <div>
              <CardTitle>New agent</CardTitle>
              <CardDescription>Bind an Ed25519 wallet to an identity</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
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
            </div>
            <Button
              onClick={create}
              disabled={busy || !label.trim() || !pubkey.trim() || unavailable}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Create agent
            </Button>
            <p className="t-support border-t border-[var(--color-border)] pt-3 leading-relaxed">
              This creates an identity, not a wallet. It holds no private key and moves no money —
              spending power comes entirely from an on-chain escrow opened against this key, and
              the envelope you set afterwards can only narrow it.
            </p>
          </CardContent>
        </Card>
      )}

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
            Agents, policies and the registry need a database, and this gateway is running without
            one. Claims are still verified; nothing here can be stored.
          </p>
        </div>
      )}

      {!loaded && <SkeletonCards count={3} className="sm:grid-cols-2 xl:grid-cols-3" />}

      {loaded && !unavailable && agents.length === 0 && (
        <Card>
          <EmptyState
            icon={Bot}
            title="No agents yet"
            body="Create your first agent, then give it a bounded spending policy. Nothing can spend until both exist."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                Create agent
              </Button>
            }
          />
        </Card>
      )}

      {agents.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <AgentCard key={a.agent_id} agent={a} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
