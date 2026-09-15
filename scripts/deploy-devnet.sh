#!/usr/bin/env bash
#
# Deploy agentpay to Solana devnet and run the attack suite against it.
# Requires the deployer wallet to already hold SOL (see the balance check below).
#
# Usage: ./scripts/deploy-devnet.sh [--skip-tests]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC_URL="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
PROGRAM_KEYPAIR="target/deploy/agentpay-keypair.json"
SKIP_TESTS=0
[[ "${1:-}" == "--skip-tests" ]] && SKIP_TESTS=1

# Deploy rent measured from an actual deploy of this 243 KB program.
DEPLOY_LAMPORTS=1750000000   # ~1.75 SOL
TEST_LAMPORTS=800000000      # ~0.80 SOL

DEPLOYER="$(solana-keygen pubkey "$WALLET")"

echo "==> cluster:  $RPC_URL"
echo "==> deployer: $DEPLOYER"

# --- program id must agree in all four places -------------------------------
DECLARED="$(grep -oE 'declare_id!\("[^"]+"\)' programs/agentpay/src/lib.rs | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,}')"
KEYPAIR_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
TOML_ID="$(grep -A1 '^\[programs.devnet\]' Anchor.toml | grep agentpay | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,}')"
echo "==> program id: $DECLARED"
if [[ "$DECLARED" != "$KEYPAIR_ID" || "$DECLARED" != "$TOML_ID" ]]; then
  echo "PROGRAM ID MISMATCH -- refusing to deploy" >&2
  echo "  declare_id!:            $DECLARED" >&2
  echo "  $PROGRAM_KEYPAIR: $KEYPAIR_ID" >&2
  echo "  Anchor.toml [devnet]:   $TOML_ID" >&2
  exit 1
fi

# --- balance gate -----------------------------------------------------------
BAL="$(solana balance --url "$RPC_URL" --keypair "$WALLET" --lamports | grep -oE '^[0-9]+')"
if [[ "$SKIP_TESTS" == "1" ]]; then NEEDED=$DEPLOY_LAMPORTS; else NEEDED=$((DEPLOY_LAMPORTS + TEST_LAMPORTS)); fi
echo "==> balance:  $(echo "scale=4; $BAL/1000000000" | bc) SOL (need ~$(echo "scale=2; $NEEDED/1000000000" | bc) SOL)"

if (( BAL < NEEDED )); then
  cat >&2 <<EOF

INSUFFICIENT BALANCE.

The devnet CLI faucet is frequently rate-limited per IP. Fund the deployer
from a web faucet, then re-run this script:

  address: $DEPLOYER
  faucet:  https://faucet.solana.com

Or, if the CLI faucet is available to you:

  solana airdrop 2 --url $RPC_URL

EOF
  exit 1
fi

echo "==> building"
anchor build

echo "==> deploying to devnet"
solana program deploy target/deploy/agentpay.so \
  --program-id "$PROGRAM_KEYPAIR" \
  --url "$RPC_URL" \
  --keypair "$WALLET"

echo "==> deployed program account"
solana program show "$DECLARED" --url "$RPC_URL"

if [[ "$SKIP_TESTS" == "1" ]]; then
  echo "==> skipping tests (--skip-tests)"
  exit 0
fi

echo "==> running attack suite against devnet"
echo "    (slower than localnet: public RPC latency + rate limits)"
ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET" \
  npm exec -- ts-mocha -p ./tsconfig.json -t 1000000 tests/attacks.ts

echo "==> done"
echo "    explorer: https://explorer.solana.com/address/$DECLARED?cluster=devnet"
