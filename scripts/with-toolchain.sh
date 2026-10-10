#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_VERSION="$(tr -d '\n' < "$PROJECT_ROOT/.aztec-version")"
TOOLCHAIN_DIR="${AZTEC_TOOLCHAIN_DIR:-${AZTEC_INSTALL_DIR:-$HOME/.aztec}/versions/$EXPECTED_VERSION}"
if [ ! -x "$TOOLCHAIN_DIR/bin/aztec" ]; then
  echo "Install Aztec $EXPECTED_VERSION with aztec-up, or set AZTEC_TOOLCHAIN_DIR." >&2
  exit 1
fi
export PATH="$TOOLCHAIN_DIR/bin:$PATH"
export AZTEC_VERSIONED=1
ACTUAL_VERSION="$(aztec --version)"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Expected Aztec $EXPECTED_VERSION, got $ACTUAL_VERSION" >&2
  exit 1
fi
if [ "$(node --version)" != "v$(tr -d '\n' < "$PROJECT_ROOT/.nvmrc")" ]; then
  echo "Select the Node version in .nvmrc before running this command." >&2
  exit 1
fi
exec "$@"
