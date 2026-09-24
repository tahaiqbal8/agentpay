"use client";

import * as React from "react";
import {
  ChartLine,
  ChevronDown,
  CloudSun,
  Loader2,
  MessageSquareQuote,
  Plug,
  Plus,
  Search,
  Store,
  Trash2,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonCards } from "@/components/empty-state";
import { Field, Input, Select, SearchInput } from "@/components/ui/input";
import { MonoKey } from "@/components/mono";
import { useToast } from "@/components/toast";
import { api, type Agent, type AggregateCatalogue, type Plan, type Provider } from "@/lib/api";
import { formatUsdc } from "@/lib/format";

/**
 * The provider registry and the planner — stages 4 and 5.
 *
 * Two things this page must not imply:
 *
 *  - that the gateway sets prices. Registering a provider records where to ask,
 *    never what to charge; every price shown was read from that provider's own
 *    catalogue moments ago.
 *  - that a plan authorises anything. The planner evaluates the envelope and
 *    reports what would be affordable; buying still goes through /v1/buy, where
 *    every rule is applied again for real.
 *
 * Layout rule: the catalogue is what this page is FOR, so it leads and it is a
 * grid of offers. Provider plumbing — base urls, registration, removal — is
 * real work but it is administration, so it folds away underneath.
 */

/**
 * An icon for a resource, by name.
 *
 * Cosmetic only, and it must stay that way: the fallback is a generic plug, so
 * an unrecognised resource looks unremarkable rather than wrong. Nothing here
 * changes what a resource IS.
 */
function iconFor(resource: string): React.ElementType {
  const r = resource.toLowerCase();
  if (r.includes("weather")) return CloudSun;
  if (r.includes("quote")) return MessageSquareQuote;
  if (r.includes("analy")) return ChartLine;
  return Plug;
}

/** "/weather" → "Weather". A formatting of the real value, never a rename. */
function titleFor(resource: string): string {
  const bare = resource.replace(/^\/+/, "").replace(/[-_]/g, " ").trim();
  if (!bare) return resource;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export default function RegistryPage() {
  const toast = useToast();
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [catalogue, setCatalogue] = React.useState<AggregateCatalogue | null>(null);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [admin, setAdmin] = React.useState(false);
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
    setLoaded(true);
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

  /* Filtering happens here, in the browser, over the catalogue the gateway
     already returned — no endpoint gained a query parameter for this. */
  const entries = React.useMemo(() => {
    const all = catalogue?.entries ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (e) =>
        e.resource.toLowerCase().includes(q) ||
        e.provider_label.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q)
    );
  }, [catalogue, query]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-page brand-gradient-text">Resource registry</h1>
          <p className="t-body mt-1.5 max-w-2xl">
            Services available to authorized agents. The gateway records where to ask — every price
            here came from the provider&apos;s own catalogue, moments ago.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {down > 0 && (
            <Badge variant="denied">
              {down} provider{down === 1 ? "" : "s"} not answering
            </Badge>
          )}
          <Badge variant="neutral">{providers.length} registered</Badge>
        </div>
      </header>

      {unavailable && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-4">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]"
          />
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            <span className="font-semibold text-[var(--color-warn)]">
              The control plane is unavailable.
            </span>{" "}
            Registering providers and planning need a database; this gateway has none.
          </p>
        </div>
      )}

      {/* ---- the catalogue, as offers ---- */}
      <section aria-label="Catalogue" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="t-section">
            On offer{" "}
            <span className="font-normal text-[var(--color-fg-dim)]">
              · cheapest first, read live
            </span>
          </h2>
          <div className="w-full sm:w-64">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by resource or provider…"
            />
          </div>
        </div>

        {!loaded && <SkeletonCards count={3} className="sm:grid-cols-2 xl:grid-cols-3" />}

        {loaded && entries.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map((e) => {
              const Icon = iconFor(e.resource);
              return (
                <div
                  key={`${e.provider_id}${e.resource}`}
                  className="surface-card flex flex-col rounded-xl p-4 transition-colors hover:border-[var(--color-border-bright)]"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-brand-glow)]">
                      <Icon className="size-4.5 text-[var(--color-brand)]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-semibold leading-tight text-[var(--color-fg)]">
                        {titleFor(e.resource)}
                      </p>
                      <code className="t-mono mt-0.5 block truncate text-[var(--color-fg-muted)]">
                        {e.resource}
                      </code>
                    </div>
                  </div>

                  <p className="t-support mt-3 min-h-[2.6em] leading-relaxed">
                    {e.description || "No description published by this provider."}
                  </p>

                  <div className="mt-3 flex items-end justify-between gap-2 border-t border-[var(--color-border)] pt-3">
                    <div>
                      <p className="t-label">Price</p>
                      <p className="tnum mt-0.5 text-[17px] font-semibold leading-none text-[var(--color-fg)]">
                        {formatUsdc(e.price)}
                      </p>
                    </div>
                    {/* It is in the catalogue because its provider answered
                        just now. That is the whole basis for the word. */}
                    <Badge variant="allowed">Available</Badge>
                  </div>

                  <p className="t-support mt-2 truncate">{e.provider_label}</p>
                </div>
              );
            })}
          </div>
        )}

        {loaded && entries.length === 0 && (
          <Card>
            <EmptyState
              icon={Store}
              title={query ? "Nothing matches that filter" : "Nothing on offer yet"}
              body={
                query
                  ? "No resource or provider in the catalogue matches what you typed."
                  : "Register a provider and the resources it sells will appear here, priced from its own catalogue."
              }
              action={
                query ? (
                  <Button variant="outline" onClick={() => setQuery("")}>
                    Clear filter
                  </Button>
                ) : (
                  <Button onClick={() => setAdmin(true)} disabled={unavailable}>
                    <Plus className="size-3.5" />
                    Register a provider
                  </Button>
                )
              }
            />
          </Card>
        )}

        {/* A provider that did not answer is not a provider with no prices.
            Saying which one is down, and why, is the difference between a gap
            the operator can fix and one they cannot see. */}
        {catalogue?.unavailable.map((u) => (
          <div
            key={u.provider_id}
            className="rounded-xl border border-[var(--color-warn-dim)] bg-[#f59e0b0d] p-4"
          >
            <p className="text-[13px] font-semibold text-[var(--color-warn)]">
              {u.provider_id} did not answer
            </p>
            <p className="mt-1 break-all text-[13px] text-[var(--color-fg-muted)]">{u.error}</p>
            <p className="t-support mt-1.5">
              Its resources are not purchasable while it is down — pricing one means reading its
              catalogue.
            </p>
          </div>
        ))}
      </section>

      {/* ---- the planner ---- */}
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="agent" htmlFor="plan-agent">
              <Select id="plan-agent" value={planAgent} onChange={(e) => setPlanAgent(e.target.value)}>
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
            <div className="space-y-2">
              <p className="t-support">
                Spent {formatUsdc(plan.spent)}
                {plan.remaining != null && ` · ${formatUsdc(plan.remaining)} of the envelope left`}
                {" · "}asked for {plan.requested_calls} call
                {plan.requested_calls === 1 ? "" : "s"}
              </p>
              {plan.options.length === 0 && (
                <p className="t-support py-6 text-center">Nobody registered sells that.</p>
              )}
              {plan.options.map((o) => {
                const usable = o.affordable_calls > 0;
                const best = plan.recommended === o.provider_id;
                return (
                  <div
                    key={o.provider_id}
                    className={`rounded-lg border p-3 ${
                      best
                        ? "border-[var(--color-accent-dim)] bg-[#10b9811a]"
                        : usable
                          ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                          : "border-[var(--color-warn-dim)] bg-[#f59e0b0d]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--color-fg)]">
                        {o.provider_label}
                      </span>
                      {best && <Badge variant="allowed">Recommended</Badge>}
                      {o.needs_approval && <Badge variant="denied">Needs a human</Badge>}
                      <span className="tnum ml-auto text-[13px] text-[var(--color-fg)]">
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

      {/* ---- provider plumbing, folded ---- */}
      <Card>
        <button
          onClick={() => setAdmin((v) => !v)}
          aria-expanded={admin}
          className="flex w-full items-center gap-2 p-4 text-left"
        >
          <Store aria-hidden="true" className="size-4 text-[var(--color-fg-dim)]" />
          <span className="t-section">Providers</span>
          <span className="t-support">· where to ask, never what to charge</span>
          <ChevronDown
            className={`ml-auto size-4 shrink-0 text-[var(--color-fg-dim)] transition-transform ${
              admin ? "rotate-180" : ""
            }`}
          />
        </button>

        {admin && (
          <CardContent className="space-y-2 border-t border-[var(--color-border)] pt-4">
            {providers.map((p) => {
              const armed = confirming === p.provider_id;
              return (
                <div
                  key={p.provider_id}
                  className={`rounded-lg border p-3 ${
                    armed
                      ? "border-[var(--color-danger-dim)] bg-[#ef44440d]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-fg)]">
                      {p.label}
                    </span>
                    <Badge variant={p.enabled ? "allowed" : "denied"}>
                      {p.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <code className="t-mono text-[var(--color-fg-dim)]">{p.provider_id}</code>
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
                  <p className="t-mono mt-1.5 break-all text-[var(--color-fg-dim)]">{p.base_url}</p>
                  {p.provider_pubkey && (
                    <div className="mt-1.5">
                      <MonoKey value={p.provider_pubkey} head={6} tail={6} />
                    </div>
                  )}
                </div>
              );
            })}

            {providers.length === 0 && (
              <EmptyState
                icon={Store}
                title="No providers registered"
                body="Register one below to record where the gateway should ask for prices. Registering never sets a price."
              />
            )}

            <div className="mt-2 space-y-3 rounded-lg border border-[var(--color-border)] p-3">
              <p className="t-label">Register a provider</p>
              <div className="grid gap-3 sm:grid-cols-2">
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
                    placeholder="Weather Co."
                  />
                </Field>
                <Field label="base_url" htmlFor="provider-url">
                  <Input
                    id="provider-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://provider:4021"
                  />
                </Field>
                <Field
                  label="provider_pubkey"
                  hint="Optional. Where settlement lands."
                  htmlFor="provider-key"
                >
                  <Input
                    id="provider-key"
                    value={pkey}
                    onChange={(e) => setPkey(e.target.value)}
                    placeholder="Base58, optional"
                  />
                </Field>
              </div>
              <Button
                size="sm"
                onClick={register}
                disabled={busy || !pid.trim() || !label.trim() || !baseUrl.trim() || unavailable}
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                Register
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
