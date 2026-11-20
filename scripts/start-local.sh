#!/usr/bin/env bash
# Dedicated migration network; does not stop or replace any existing network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ANVIL_PORT="${ANVIL_PORT:-5954}"
exec bash "$SCRIPT_DIR/with-toolchain.sh" aztec start --local-network --node-debug --port "${L2_PORT:-5180}" --admin-port "${ADMIN_PORT:-5980}"
