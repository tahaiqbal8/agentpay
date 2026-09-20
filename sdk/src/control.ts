/**
 * The control-plane client: agents, envelopes, the registry and planning.
 *
 * Separate from `AgentPayClient` on purpose. That one is what an *agent*
 * carries — a session and a signing key, no privileged credential. This one is
 * what an *operator* carries, and it holds the admin token.
 *
 * Keeping them apart means an agent process cannot accidentally be given
 * authority to widen its own envelope or approve its own spends, because the
 * class that can do those things is never constructed there.
 */

import { errorFrom } from "./errors";

export type AgentMode = "human" | "autonomous";
export type AgentStatus = "active" | "suspended";

export interface Policy {
  max_total: string;
  max_per_call: string;
  approval_threshold: string | null;
  allowed_resources: string[] | null;
  max_calls: number | null;
}

export interface Agent {
  agent_id: string;
  label: string;
  agent_pubkey: string;
  owner_pubkey: string | null;
  mode: AgentMode;
  status: AgentStatus;
  created_at: string;
  policy: Policy | null;
  spent: string;
  calls: number;
  remaining: string | null;
}

export interface CatalogueEntry {
  provider_id: string;
  provider_label: string;
  resource: string;
  price: string;
  description: string;
}

export interface PlanOption {
  provider_id: string;
  provider_label: string;
  resource: string;
  unit_price: string;
  affordable_calls: number;
  total_cost: string;
  sufficient: boolean;
  refused_by: string | null;
  needs_approval: boolean;
}

export interface Plan {
  agent_id: string;
  resource: string;
  requested_calls: number;
  options: PlanOption[];
  recommended: string | null;
  spent: string;
  remaining: string | null;
}

export interface Approval {
  approval_id: string;
  agent_id: string;
  resource: string;
  price: string;
  state: "pending" | "approved" | "rejected" | "consumed";
  reason: string | null;
  created_at: string;
}

export interface ControlOptions {
  gateway: string;
  /**
   * The control-plane admin token.
   *
   * Required unless the gateway runs unauthenticated on loopback. Never put
   * this in a browser bundle or an agent process — it can approve spends and
   * suspend agents.
   */
  adminToken?: string;
  fetch?: typeof globalThis.fetch;
}

export class AgentPayControl {
  private readonly gateway: string;
  private readonly token?: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(opts: ControlOptions) {
    this.gateway = opts.gateway.replace(/\/+$/, "");
    this.token = opts.adminToken?.trim() || undefined;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.doFetch(`${this.gateway}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res.status, body);
    return body as T;
  }

  // --- agents ---

  async createAgent(input: {
    label: string;
    agent_pubkey: string;
    owner_pubkey?: string;
    mode?: AgentMode;
  }): Promise<Agent> {
    return this.call<Agent>("/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async agents(): Promise<Agent[]> {
    const b = await this.call<{ agents: Agent[] }>("/v1/agents");
    return b.agents;
  }

  async agent(agentId: string): Promise<Agent> {
    return this.call<Agent>(`/v1/agents/${agentId}`);
  }

  /**
   * Sets the permission envelope.
   *
   * Amounts are micro-USDC decimal strings, never numbers: above 2^53 a
   * JavaScript number rounds, and these are budgets.
   *
   * This can only NARROW what the on-chain escrow already permits. It never
   * grants an agent more spending power.
   */
  async authorize(
    agentId: string,
    envelope: {
      max_total: string;
      max_per_call: string;
      approval_threshold?: string | null;
      allowed_resources?: string[] | null;
      max_calls?: number | null;
      mode?: AgentMode;
    }
  ): Promise<Agent> {
    return this.call<Agent>(`/v1/agents/${agentId}/authorize`, {
      method: "POST",
      body: JSON.stringify(envelope),
    });
  }

  /**
   * Stops or restarts an agent at the gateway.
   *
   * Immediate, and it does not need the session to expire. Two limits worth
   * knowing: it binds only what passes through this gateway, and it does not
   * claw back the escrow or recall a settlement in flight.
   */
  async setStatus(agentId: string, status: AgentStatus): Promise<Agent> {
    return this.call<Agent>(`/v1/agents/${agentId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }

  // --- registry ---

  async registerProvider(input: {
    provider_id: string;
    label: string;
    base_url: string;
    provider_pubkey?: string;
    enabled?: boolean;
  }) {
    return this.call<{ providers: unknown[] }>("/v1/providers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Every resource every registered provider offers, cheapest first. */
  async catalogue(): Promise<CatalogueEntry[]> {
    const b = await this.call<{ entries: CatalogueEntry[] }>("/v1/catalogue");
    return b.entries;
  }

  /**
   * What this agent could afford, and from whom.
   *
   * Advice only — nothing is reserved or authorised. Buying goes through the
   * agent client, where the signature, the price and the envelope are all
   * checked again.
   */
  async plan(agentId: string, resource: string, calls: number): Promise<Plan> {
    return this.call<Plan>("/v1/agent/plan", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, resource, calls }),
    });
  }

  // --- approvals ---

  async approvals(): Promise<Approval[]> {
    const b = await this.call<{ approvals: Approval[] }>("/v1/approvals");
    return b.approvals;
  }

  /** Approves or rejects one spend. An approval is single-use. */
  async decide(approvalId: string, approved: boolean, reason?: string) {
    return this.call<{ approvals: Approval[] }>(`/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved, reason }),
    });
  }
}
