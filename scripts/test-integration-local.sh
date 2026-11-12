#!/usr/bin/env bash
# PostgreSQL conformance without Docker: boots PGlite over the PostgreSQL wire protocol,
# points tests/.env.test at it, runs the integration suite, then shuts it down.
#
#   bash scripts/test-integration-local.sh
#
# Any DATA_AGENT_TEST_MYSQL line already in tests/.env.test is preserved, so a running MySQL
# (docker compose -f docker-compose.test.yml up -d mysql) is tested in the same run.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PGLITE_PORT:-55444}"
NODE="${NODE_BIN:-node.exe}"
ENV_FILE="tests/.env.test"
DSN="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres?workspace=analysis_ws"

mkdir -p tests
touch "$ENV_FILE"
grep -v '^DATA_AGENT_TEST_PG=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
printf 'DATA_AGENT_TEST_PG=%s\n' "$DSN" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

"$NODE" scripts/pglite-server.mjs "$PORT" > /tmp/pglite-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

port_open() {
  "$NODE" -e "const s=require('net').connect($PORT,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null
}

if port_open; then
  echo "port $PORT is already in use; set PGLITE_PORT to a free port" >&2
  exit 1
fi

for _ in $(seq 1 60); do
  grep -q 'listening' /tmp/pglite-server.log 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done

if ! grep -q 'listening' /tmp/pglite-server.log 2>/dev/null; then
  echo "pglite-server did not start:" >&2; tail -20 /tmp/pglite-server.log >&2; exit 1
fi

echo "== integration suite =="
"$NODE" --import tsx --test "tests/integration/*.test.ts"
