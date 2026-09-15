#!/usr/bin/env bash
#
# Run the AgentPay gateway against devnet.
#
# Config comes from the environment; nothing is hardcoded in the binary.
# Override any of these by exporting them before running.
#
# Usage: ./scripts/run-gateway.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/gateway"

export PATH="$HOME/.cargo/bin:$PATH"

export AGENTPAY_BIND_ADDR="${AGENTPAY_BIND_ADDR:-127.0.0.1:8080}"
export AGENTPAY_RPC_URL="${AGENTPAY_RPC_URL:-https://api.devnet.solana.com}"
export AGENTPAY_PROGRAM_ID="${AGENTPAY_PROGRAM_ID:-3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U}"
export AGENTPAY_LOG="${AGENTPAY_LOG:-info,tower_http=debug}"

echo "==> gateway    $AGENTPAY_BIND_ADDR"
echo "==> rpc        $AGENTPAY_RPC_URL"
echo "==> program    $AGENTPAY_PROGRAM_ID"
echo "==> WARNING    session state is in-memory; a restart loses every"
echo "               session's claim high-water mark"

exec cargo run --quiet
