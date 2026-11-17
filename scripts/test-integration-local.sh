#!/usr/bin/env bash
# Compatibility entry point. The Node runner owns startup, deadlines and process cleanup.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${NODE_BIN:-}" ]]; then
  exec "$NODE_BIN" scripts/test-integration-local.mjs
elif command -v node >/dev/null 2>&1; then
  exec node scripts/test-integration-local.mjs
else
  exec node.exe scripts/test-integration-local.mjs
fi
