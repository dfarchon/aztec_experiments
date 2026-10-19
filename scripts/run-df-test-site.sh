#!/usr/bin/env bash
# Keep the local Aztec node and standalone billboard page alive in one terminal session.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p .local

SITE_PORT="${DF_TEST_SITE_PORT:-5001}"
NODE_URL="${DF_NODE_URL:-http://127.0.0.1:5180}"
NODE_PID=""
SITE_PID=""
CLOCK_PID=""

if ! DF_TEST_SITE_PORT="$SITE_PORT" python3 -c '
import os, socket
with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", int(os.environ["DF_TEST_SITE_PORT"])))
' 2>/dev/null; then
  echo "Port $SITE_PORT is already in use. Close the existing test site or set DF_TEST_SITE_PORT." >&2
  exit 1
fi

cleanup() {
  if [ -n "$CLOCK_PID" ]; then kill "$CLOCK_PID" 2>/dev/null || true; fi
  if [ -n "$SITE_PID" ]; then kill "$SITE_PID" 2>/dev/null || true; fi
  if [ -n "$NODE_PID" ]; then kill "$NODE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node_ready() {
  DF_NODE_URL="$NODE_URL" node --input-type=module -e '
    import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
    await createAztecNodeClient(process.env.DF_NODE_URL).getNodeInfo();
  ' >/dev/null 2>&1
}

echo 'Building standalone billboard contract and test page...'
npm run build:df
npm run build:df:l1
npm run build:sdk
npm run build:df:harness

if node_ready; then
  echo "Using existing Aztec node at $NODE_URL"
else
  if [ "$NODE_URL" != 'http://127.0.0.1:5180' ]; then
    echo "No node at $NODE_URL. Start the selected node first." >&2
    exit 1
  fi
  echo 'Starting local Aztec node; detailed log: .local/df-test-node.log'
  SEQ_BLOCK_DURATION_MS=12000 bash scripts/start-local.sh >.local/df-test-node.log 2>&1 &
  NODE_PID=$!
  for _ in $(seq 1 180); do
    if node_ready; then break; fi
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
      echo 'Aztec node exited during startup. Check .local/df-test-node.log' >&2
      exit 1
    fi
    sleep 1
  done
  if ! node_ready; then
    echo 'Aztec node did not become ready. Check .local/df-test-node.log' >&2
    exit 1
  fi
fi

echo 'Checking standalone billboard and Sponsored FPC on the local chain...'
npm run deploy:df:harness >.local/df-test-deploy.log 2>&1 || {
  echo 'Deployment failed; recent output:' >&2
  tail -n 60 .local/df-test-deploy.log >&2
  exit 1
}

echo "DF test page: http://127.0.0.1:${SITE_PORT}/"
echo "Design and testing: df-billboard/README.md"
node scripts/sync-df-clock.mjs
node scripts/sync-df-clock.mjs --watch >.local/df-clock.log 2>&1 &
CLOCK_PID=$!
echo 'Keep this terminal open while testing; Ctrl+C stops services started here.'
node node_modules/vite/bin/vite.js --config apps/src/df-billboard-test/vite.config.ts --port "$SITE_PORT" &
SITE_PID=$!
wait "$SITE_PID"
