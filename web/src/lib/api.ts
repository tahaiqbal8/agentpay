/**
 * Gateway client.
 *
 * Talks to the REAL AgentPay gateway through a same-origin proxy at /api/gw,
 * so there is no CORS to loosen on the gateway itself.
 *
 * Mock data exists only as a fallback when the gateway is unreachable, and every
 * response carries `live: false` in that case. The UI is required to render that
 * state visibly — seeded numbers must never be mistaken for on-chain state.
 */

export interface SessionSummary {
  session: string;
  agent: string;
  provider: string;
  mint: string;
  deposited_total: string;
  cumulative_accepted: string;
  remaining: string;
  last_nonce: string | null;
  expires_at: number;
  is_settled: boolean;
  /** False when the escrow was never verified on chain — cannot settle. */
  chain_verified: boolean;
  evidence_count: number;
  created_at: string;
}

export interface RecentDecision {
  session: string;
  sequence_id: number;
  decision: string;
  allowed: boolean;
  cumulative_amount: string;
  nonce: string;
  entry_hash: string;
  created_at: string;
}

export interface EvidenceEntry {
  sequence_id: number;
  decision: string;
  cumulative_amount: string;
  nonce: string;
  prev_hash: string;
  entry_hash: string;
}

export interface SessionEvidence {
  session: string;
  merkle_root: string;
  entry_count: number;
  chain_valid: boolean;
  chain_error: string | null;
  entries: EvidenceEntry[];
}

export interface ProofNode {
  hash: string;
  side: "left" | "right";
}

export interface EvidenceProof {
  session: string;
  sequence_id: number;
  decision: string;
  cumulative_amount: string;
  nonce: string;
  leaf_hash: string;
  merkle_root: string;
  leaf_index: number;
  total_leaves: number;
  proof: ProofNode[];
  verified_locally: boolean;
}


// ---------------------------------------------------------------------------
// Control plane — who may spend, on what, and how much.
//
// Every amount is a decimal string of micro-USDC, matching the rest of this
// client. A JSON number above 2^53 rounds, and these are budgets.
// ---------------------------------------------------------------------------

export type AgentMode = "human" | "autonomous";
export type AgentStatus = "active" | "suspended";

export interface PolicyView {
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
  /** Null means the agent has never been authorized: only its escrow bounds it. */
  policy: PolicyView | null;
  /** Derived from the money path, not a counter kept alongside it. */
  spent: string;
  calls: number;
  remaining: string | null;
}

export interface Provider {
  provider_id: string;
  label: string;
  base_url: string;
  provider_pubkey: string | null;
  enabled: boolean;
}

export interface CatalogueEntry {
  provider_id: string;
  provider_label: string;
  resource: string;
  price: string;
  description: string;
}

export interface ProviderError {
  provider_id: string;
  base_url: string;
  error: string;
}

export interface AggregateCatalogue {
  entries: CatalogueEntry[];
  /** Providers that did not answer. Listed so "down" is not read as "absent". */
  unavailable: ProviderError[];
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
  unavailable: ProviderError[];
}

export interface Approval {
  approval_id: string;
  agent_id: string;
  session: string | null;
  resource: string;
  price: string;
  calls: number;
  state: "pending" | "approved" | "rejected" | "consumed";
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  /** Who decided, snapshotted at the moment of the decision. */
  decided_by: string | null;
  decided_by_label: string | null;
}

export interface Health {
  status: string;
  program_id: string;
  ephemeral_state: boolean;
  state_backend: string;
}

export interface ApiError {
  reason_code: string;
  message: string;
  request_id: string;
}

export type Result<T> =
  | { ok: true; data: T; live: boolean }
  | { ok: false; error: ApiError; status: number };

const BASE = "/api/gw";

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: (body as ApiError) ?? {
          reason_code: "ERR_UNREACHABLE",
          message: "The gateway did not return a readable response.",
          request_id: "-",
        },
      };
    }
    return { ok: true, data: body as T, live: true };
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        reason_code: "ERR_GATEWAY_UNREACHABLE",
        message: "Could not reach the gateway.",
        request_id: "-",
      },
    };
  }
}

export const api = {
  // --- control plane ---
  agents: () => call<{ agents: Agent[] }>("/v1/agents"),
  agent: (id: string) => call<Agent>(`/v1/agents/${id}`),
  createAgent: (body: {
    label: string;
    agent_pubkey: string;
    owner_pubkey?: string;
    mode?: AgentMode;
  }) => call<Agent>("/v1/agents", { method: "POST", body: JSON.stringify(body) }),
  authorizeAgent: (
    id: string,
    body: {
      max_total: string;
      max_per_call: string;
      approval_threshold?: string | null;
      allowed_resources?: string[] | null;
      max_calls?: number | null;
      mode?: AgentMode;
    }
  ) => call<Agent>(`/v1/agents/${id}/authorize`, { method: "POST", body: JSON.stringify(body) }),
  setAgentStatus: (id: string, status: AgentStatus) =>
    call<Agent>(`/v1/agents/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  providers: () => call<{ providers: Provider[] }>("/v1/providers"),
  registerProvider: (body: {
    provider_id: string;
    label: string;
    base_url: string;
    provider_pubkey?: string;
    enabled?: boolean;
  }) => call<{ providers: Provider[] }>("/v1/providers", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  deleteProvider: (id: string) =>
    call<{ providers: Provider[] }>(`/v1/providers/${id}`, { method: "DELETE" }),
  catalogue: () => call<AggregateCatalogue>("/v1/catalogue"),
  plan: (body: { agent_id: string; resource: string; calls: number }) =>
    call<Plan>("/v1/agent/plan", { method: "POST", body: JSON.stringify(body) }),
  approvals: () => call<{ approvals: Approval[] }>("/v1/approvals"),
  decideApproval: (id: string, approved: boolean, reason?: string) =>
    call<{ approvals: Approval[] }>(`/v1/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved, reason }),
    }),
  health: () => call<Health>("/health"),
  sessions: () => call<{ sessions: SessionSummary[] }>("/v1/sessions"),
  /**
   * One session by address. Unlike the listing this needs no operator token,
   * because reading a session you can already name is not enumeration.
   */
  session: (pubkey: string) => call<SessionSummary>(`/v1/session/${pubkey}`),
  recentDecisions: () => call<{ decisions: RecentDecision[] }>("/v1/decisions/recent"),
  evidence: (session: string) =>
    call<SessionEvidence>(`/v1/session/${session}/evidence`),
  proof: (session: string, sequence_id: number) =>
    call<EvidenceProof>("/v1/evidence/proof", {
      method: "POST",
      body: JSON.stringify({ session, sequence_id }),
    }),
  verifyClaim: (claim: Record<string, string>) =>
    call<{
      decision: string;
      cumulative_amount: string;
      previous_cumulative: string;
      delta: string;
      nonce: string;
    }>("/v1/claim/verify", { method: "POST", body: JSON.stringify({ claim }) }),
  /**
   * Reads the evidence root the program actually stored, back off the chain.
   *
   * This is the last hop of the audit. `merkle_root` here comes from the
   * settlement PDA, not from the gateway's memory of what it submitted, so a
   * gateway that committed a different root than its own log produces would be
   * caught by comparing the two.
   */
  onChainSettlement: (session: string) =>
    call<{
      session: string;
      settlement_record: string;
      settled: boolean;
      merkle_root?: string;
      claim_hash?: string;
      /** The CUMULATIVE total settled, not this transaction's delta. */
      settled_amount?: string;
      settled_at?: number;
      /**
       * Whether this root can still change.
       *
       * Program v2 makes settlement repeatable, so a later settlement commits
       * a root over more evidence entries. `true` means the root shown is the
       * latest, not a final one — which matters to anyone about to export a
       * proof. `undefined` when the gateway could not read the session to tell.
       */
      root_may_advance?: boolean;
    }>(`/v1/session/${session}/settlement`),
  /**
   * Re-checks a session against its on-chain escrow.
   *
   * A session opened while reconciliation was disabled is recorded unverified,
   * and unverified is not the same as unbacked — the escrow may exist and
   * nobody looked. This asks the gateway to look.
   */
  reconcile: (session: string) =>
    call<{
      decision: string;
      session: string;
      chain_verified: boolean;
      on_chain_deposit: string;
    }>("/v1/session/reconcile", {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  settle: (session: string) =>
    call<{
      decision: string;
      session: string;
      signature: string;
      merkle_root: string;
      evidence_entries: number;
      cumulative_amount: string;
      provider_token_account: string;
      settlement_record: string;
    }>("/v1/session/settle", {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
};

// ---------------------------------------------------------------------------
// Fallback fixtures
//
// Shaped exactly like the gateway's responses so the components cannot drift.
// Anything rendered from these MUST be labelled SEEDED in the UI.
// ---------------------------------------------------------------------------

const MOCK_SESSION = "DEMOsess1oNpubKey1111111111111111111111111111";

export const mock = {
  sessions: (): SessionSummary[] => {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        session: MOCK_SESSION,
        agent: "DEMOagent1111111111111111111111111111111111",
        provider: "DEMOprov1der111111111111111111111111111111",
        mint: "DEMOm1nt11111111111111111111111111111111111",
        deposited_total: "5000000",
        cumulative_accepted: "1234567",
        remaining: "3765433",
        last_nonce: "4",
        expires_at: now + 3600,
        is_settled: false,
        chain_verified: true,
        evidence_count: 7,
        created_at: new Date(Date.now() - 600_000).toISOString(),
      },
      {
        session: "DEMOsess1oN2ndPubKey222222222222222222222222",
        agent: "DEMOagent2222222222222222222222222222222222",
        provider: "DEMOprov1der222222222222222222222222222222",
        mint: "DEMOm1nt11111111111111111111111111111111111",
        deposited_total: "2000000",
        cumulative_accepted: "2000000",
        remaining: "0",
        last_nonce: "11",
        expires_at: now - 120,
        is_settled: true,
        chain_verified: true,
        evidence_count: 12,
        created_at: new Date(Date.now() - 7_200_000).toISOString(),
      },
    ];
  },
  decisions: (): RecentDecision[] =>
    [
      ["ALLOWED", "1234567", "4"],
      ["ERR_CLAIM_EXCEEDS_DEPOSIT", "99000000", "9"],
      ["ERR_NONCE_NOT_MONOTONIC", "900000", "2"],
      ["ERR_CLAIM_NOT_MONOTONIC", "400000", "3"],
      ["ALLOWED", "400000", "2"],
      ["ALLOWED", "100000", "1"],
    ].map(([decision, cumulative_amount, nonce], i) => ({
      session: MOCK_SESSION,
      sequence_id: 5 - i,
      decision,
      allowed: decision === "ALLOWED",
      cumulative_amount,
      nonce,
      entry_hash: `${(i + 1).toString(16).repeat(8)}`.padEnd(64, "0"),
      created_at: new Date(Date.now() - i * 9000).toISOString(),
    })),
};
