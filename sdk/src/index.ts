/**
 * AgentPay — a client for deferred, enforced agent payments on Solana.
 *
 * Two entry points, kept apart on purpose:
 *
 *   AgentPayClient   what an AGENT carries: a session and a signing key.
 *   AgentPayControl  what an OPERATOR carries: the admin token.
 *
 * An agent process that never constructs the second cannot widen its own
 * envelope or approve its own spends, whatever else goes wrong in it.
 */
export { AgentPayClient, base58Decode, base58Encode } from "./client";
export type {
  ClientOptions,
  Signer,
  Quote,
  Purchase,
  BuyManyResult,
  SessionState,
  Settlement,
  RetryOptions,
} from "./client";

export { AgentPayControl } from "./control";
export type {
  ControlOptions,
  Agent,
  AgentMode,
  AgentStatus,
  Policy,
  CatalogueEntry,
  Plan,
  PlanOption,
  Approval,
} from "./control";

export { AgentPayError } from "./errors";
export type { ReasonCode } from "./errors";

export { claimMessage, CLAIM_DOMAIN, CLAIM_MESSAGE_LEN } from "./claim";
export type { ClaimFields } from "./claim";
