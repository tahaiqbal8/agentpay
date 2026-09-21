"use client";

import * as React from "react";
import { Loader2, Plus, Store, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import {
  api,
  type Agent,
  type AggregateCatalogue,
  type Plan,
  type Provider,
} from "@/lib/api";
import { formatUsdc } from "@/lib/format";

/**
 * The provider registry and the planner — stages 5 to 7.
 *
 * Two things this page must not imply:
 *
 *  - that the gateway sets prices. Registering a provider records where to ask,
 *    never what to charge; every price shown was read from that provider's own
 *    catalogue moments ago.
 *  - that a plan authorises anything. The planner evaluates the envelope and
 *    reports what would be affordable; buying still goes through /v1/buy, where
 *    every rule is applied again for real.
 */

export default function RegistryPage() {
  const toast = useToast();
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [catalogue, setCatalogue] = React.useState<AggregateCatalogue | null>(null);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [unavailable, setUnavailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Which provider's remove button is armed. A single click on a bin icon
  // should not delete a registration: the second click is the decision.
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const [pid, setPid] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [pkey, setPkey] = React.useState("");

  const [planAgent, setPlanAgent] = React.useState("");
  const [planResource, setPlanResource] = React.useState("");
  const [planCalls, setPlanCalls] = React.useState("10");
  const [plan, setPlan] = React.useState<Plan | null>(null);

  const load = React.useCallback(async () => {
    const [p, c, a] = await Promise.all([api.providers(), api.catalogue(), api.agents()]);
    if (p.ok) setProviders(p.data.providers);
    if (c.ok) setCatalogue(c.data);
    if (a.ok) {
      setAgents(a.data.agents);
      setUnavailable(false);
      if (!planAgent && a.data.agents.length > 0) setPlanAgent(a.data.agents[0].agent_id);
    } else if (a.error.reason_code === "ERR_CONTROL_PLANE_UNAVAILABLE") {
      setUnavailable(true);
    }
  }, [planAgent]);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const register = async () => {
    setBusy(true);
    const res = await api.registerProvider({
      provider_id: pid.trim(),
      label: label.trim(),
      base_url: baseUrl.trim(),
      provider_pubkey: pkey.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: "Provider not registered", body: res.error.reason_code });
      return;
    }
    toast({ kind: "success", title: "Provider registered", body: pid.trim() });
    setPid("");
    setLabel("");
    setBaseUrl("");
    setPkey("");
    void load();
  };

  const remove = async (id: string) => {
    setConfirming(null);
    const res = await api.deleteProvider(id);
    if (!res.ok) {
      toast({ kind: "error", title: "Not removed", body: res.error.reason_code });
      return;
    }
    toast({ kind: "success", title: "Provider removed", body: id });
    void load();
  };

  const runPlan = async () => {
    setBusy(true);
    const res = await api.plan({
      agent_id: planAgent,
      resource: planResource.trim(),
      calls: Number(planCalls) || 1,
    });
    setBusy(false);
    if (!res.ok) {
      setPlan(null);
      toast({ kind: "error", title: "Plan failed", body: res.error.reason_code });
      return;
    }
    setPlan(res.data);
  };

  const down = catalogue?.unavailable.length ?? 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page">Registry</h1>
          <p className="t-body mt-1 max-w-2xl">
            Who sells what, and at what price. The gateway records where to ask — every price on
            this page came from the provider&apos;s own catalogue, moments ago.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {down > 0 && (
            <Badge variant="denied">
              {down} provider{down === 1 ? "" : "s"} not answering
            </Badge>
          )}
          <Badge variant="neutral">{providers.length} registered</Badge>
        </div>
      </header>

      {unavailable && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] px-3 py-2">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warn)]"
          />
          <p className="text-xs text-[var(--color-fg-muted)]">
            <span className="font-semibold text-[var(--color-warn)]">
              The control plane is unavailable.
            </span>{" "}
            Registering providers and planning need a database; this gateway has none.
          </p>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>Providers</CardTitle>
              <CardDescription>Where to ask — never what to charge</CardDescription>
            </div>
            <Badge variant="neutral">{providers.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-1.5 p-2">
            {providers.map((p) => {
              const armed = confirming === p.provider_id;
              return (
                <div
                  key={p.provider_id}
                  className={`rounded-md border p-2.5 ${
                    armed
                      ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Store
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-[var(--color-fg-dim)]"
                    />
                    <span className="text-xs font-medium text-[var(--color-fg)]">{p.label}</span>
                    <Badge variant={p.enabled ? "allowed" : "denied"}>
                      {p.enabled ? "enabled" : "disabled"}
                    </Badge>
                    <code className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                      {p.provider_id}
                    </code>
                    {/* Two steps, because removing a registration is not
                        something to do by brushing an icon. */}
                    {armed ? (
                      <span className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="danger" onClick={() => remove(p.provider_id)}>
                          Remove
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setConfirming(p.provider_id)}
                        aria-label={`Remove ${p.provider_id}`}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    )}
                  </div>
                  {armed && (
                    <p className="t-support mt-1.5 text-[var(--color-warn)]">
                      Its resources disappear from the catalogue. Sessions already open are
                      unaffected — the escrow is on chain, not here.
                    </p>
                  )}
                  <p className="mt-1 break-all font-mono text-[11px] text-[var(--color-fg-dim)]">
                    {p.base_url}
                  </p>
                  {p.provider_pubkey && (
                    <div className="mt-1">
                      <MonoKey value={p.provider_pubkey} head={6} tail={6} />
                    </div>
                  )}
                </div>
              );
            })}
            {providers.length === 0 && (
              <p className="py-8 text-center text-xs text-[var(--color-fg-muted)]">
                No providers registered.
              </p>
            )}

            <div className="mt-2 space-y-2.5 rounded-md border border-[var(--color-border)] p-3">
              <p className="t-label">Register a provider</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <Field label="provider_id" htmlFor="provider-id">
                  <Input
                    id="provider-id"
                    value={pid}
                    onChange={(e) => setPid(e.target.value)}
                    placeholder="weather-co"
                  />
                </Field>
                <Field label="label" htmlFor="provider-label">
                  <Input
                    id="provider-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Weather Co"
                  />
                </Field>
              </div>
              <Field
                label="base_url"
                hint="Must serve /_catalogue. http:// or https:// only."
                htmlFor="provider-url"
              >
                <Input
                  id="provider-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://provider:4021"
                />
              </Field>
              <Field
                label="provider_pubkey"
                hint="Optional for browsing; settlement needs it."
                htmlFor="provider-pubkey"
              >
                <Input
                  id="provider-pubkey"
                  value={pkey}
                  onChange={(e) => setPkey(e.target.value)}
                  placeholder="Base58, optional"
                />
              </Field>
              <Button
                size="sm"
                onClick={register}
                disabled={busy || !pid.trim() || !label.trim() || !baseUrl.trim()}
                className="w-full"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                Register
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div>
              <CardTitle>Catalogue</CardTitle>
              <CardDescription>Read live from each provider, cheapest first</CardDescription>
            </div>
            <Badge variant="neutral">{catalogue?.entries.length ?? 0}</Badge>
          </CardHeader>
          <CardContent className="space-y-1.5 p-2">
            {catalogue?.entries.map((e) => (
              <div
                key={`${e.provider_id}${e.resource}`}
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-xs text-[var(--color-fg)]">{e.resource}</code>
                  <p className="t-support truncate">
                    {e.provider_label} · {e.description || "no description"}
                  </p>
                </div>
                <span className="tnum shrink-0 font-mono text-xs text-[var(--color-accent)]">
                  {formatUsdc(e.price)}
                </span>
              </div>
            ))}
            {catalogue?.entries.length === 0 && (
              <p className="py-8 text-center text-xs text-[var(--color-fg-muted)]">
                Nothing on offer.
              </p>
            )}
            {/* A provider that did not answer is not a provider with no prices.
                Saying which one is down, and why, is the difference between a
                gap the operator can fix and one they cannot see. */}
            {catalogue?.unavailable.map((u) => (
              <div
                key={u.provider_id}
                className="rounded-md border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-2.5"
              >
                <p className="text-xs font-semibold text-[var(--color-warn)]">
                  {u.provider_id} did not answer
                </p>
                <p className="mt-0.5 break-all text-xs text-[var(--color-fg-muted)]">
                  {u.error}
                </p>
                <p className="t-support mt-1">
                  Its resources are not purchasable while it is down — pricing one means reading its
                  catalogue.
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card accent="agent">
        <CardHeader>
          <div>
            <CardTitle>Planner</CardTitle>
            <CardDescription>
              What could this agent afford? Evaluates the envelope — authorises nothing
            </CardDescription>
          </div>
          <Wand2 aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2.5 sm:grid-cols-3">
            <Field label="agent" htmlFor="plan-agent">
              <Select
                id="plan-agent"
                value={planAgent}
                onChange={(e) => setPlanAgent(e.target.value)}
              >
                {agents.length === 0 && <option value="">no agents</option>}
                {agents.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="resource" htmlFor="plan-resource">
              <Input
                id="plan-resource"
                value={planResource}
                onChange={(e) => setPlanResource(e.target.value)}
                placeholder="/weather"
              />
            </Field>
            <Field label="calls needed" htmlFor="plan-calls">
              <Input
                id="plan-calls"
                value={planCalls}
                onChange={(e) => setPlanCalls(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <Button size="sm" onClick={runPlan} disabled={busy || !planAgent || !planResource.trim()}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
            Plan
          </Button>

          {plan && (
            <div className="space-y-1.5">
              <p className="t-support">
                Spent {formatUsdc(plan.spent)}
                {plan.remaining != null && ` · ${formatUsdc(plan.remaining)} of the envelope left`}
                {" · "}asked for {plan.requested_calls} call
                {plan.requested_calls === 1 ? "" : "s"}
              </p>
              {plan.options.length === 0 && (
                <p className="py-6 text-center text-xs text-[var(--color-fg-muted)]">
                  Nobody registered sells that.
                </p>
              )}
              {plan.options.map((o) => {
                const usable = o.affordable_calls > 0;
                const best = plan.recommended === o.provider_id;
                return (
                  <div
                    key={o.provider_id}
                    className={`rounded-md border p-2.5 ${
                      best
                        ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                        : usable
                        ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                        : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-[var(--color-fg)]">
                        {o.provider_label}
                      </span>
                      {best && <Badge variant="allowed">recommended</Badge>}
                      {o.needs_approval && <Badge variant="denied">needs a human</Badge>}
                      <span className="tnum ml-auto font-mono text-xs text-[var(--color-fg)]">
                        {formatUsdc(o.unit_price)} each
                      </span>
                    </div>
                    <p className="t-support mt-1">
                      {o.refused_by ? (
                        <>
                          Refused by{" "}
                          <code className="font-mono text-[var(--color-warn)]">{o.refused_by}</code>
                        </>
                      ) : (
                        <>
                          {o.affordable_calls} call{o.affordable_calls === 1 ? "" : "s"} affordable ·{" "}
                          {formatUsdc(o.total_cost)} total
                          {!o.sufficient && " — fewer than requested"}
                        </>
                      )}
                    </p>
                  </div>
                );
              })}
              <p className="t-support pt-1 leading-relaxed">
                A plan is advice. Nothing is reserved or authorised here — buying goes through{" "}
                <code className="font-mono">/v1/buy</code>, where the signature, the price and this
                same envelope are all checked again.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
