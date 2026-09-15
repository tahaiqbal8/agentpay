#!/usr/bin/env bash
#
# Clean-clone reproduction: build, deploy to a fresh local validator, run the
# attack suite. Leaves no validator running.
#
# Usage: ./scripts/test-local.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

for bin in cargo solana solana-test-validator anchor node npm; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required tool: $bin" >&2; exit 1; }
done

LEDGER_DIR="$(mktemp -d)"
VALIDATOR_PID=""

cleanup() {
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "==> stopping validator"
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$LEDGER_DIR"
}
trap cleanup EXIT

if [[ ! -f "$HOME/.config/solana/id.json" ]]; then
  echo "==> generating dev keypair"
  solana-keygen new --no-bip39-passphrase --outfile "$HOME/.config/solana/id.json" --silent
fi

echo "==> pointing CLI at localhost (never mainnet)"
solana config set --url http://127.0.0.1:8899 >/dev/null

echo "==> installing node dependencies"
[[ -d node_modules ]] || npm install

echo "==> building program"
anchor build

echo "==> starting validator (ledger: $LEDGER_DIR)"
( cd "$LEDGER_DIR" && solana-test-validator --reset --quiet ) &
VALIDATOR_PID=$!

echo "==> waiting for RPC"
until solana cluster-version >/dev/null 2>&1; do sleep 1; done
solana cluster-version

echo "==> funding deployer"
solana airdrop 100 >/dev/null

echo "==> deploying program"
solana program deploy target/deploy/agentpay.so \
  --program-id target/deploy/agentpay-keypair.json

echo "==> running attack suite"
ANCHOR_PROVIDER_URL="http://127.0.0.1:8899" \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
  npm exec -- ts-mocha -p ./tsconfig.json -t 1000000 tests/attacks.ts

echo "==> done"
