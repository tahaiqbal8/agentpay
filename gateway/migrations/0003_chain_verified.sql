-- Records whether a session was reconciled against its on-chain escrow account
-- when it was opened.
--
-- Without this the gateway cannot tell a real escrowed session from one admitted
-- under AGENTPAY_TRUST_OPEN_REQUESTS, and the console ends up offering
-- settlement for sessions that have no vault to settle from -- an action the
-- program can only refuse.
--
-- Defaults to false: an existing row was written before this column existed, so
-- we do not know it was verified, and claiming otherwise would be a guess.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS chain_verified BOOLEAN NOT NULL DEFAULT false;
