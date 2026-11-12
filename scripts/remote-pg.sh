#!/usr/bin/env bash
# Quick check against the provisioned remote PostgreSQL, using the service HTTP API.
#
#   bash scripts/remote-pg.sh            # healthz + credentials probe + connection test
#   bash scripts/remote-pg.sh session    # also create a session and print its capabilities
#
# Credentials live in .secrets/remote-pg.env (gitignored), never in this script.
set -euo pipefail
cd "$(dirname "$0")/.."

CURL="${CURL:-/mnt/c/Windows/System32/curl.exe}"
BASE="${DATA_AGENT_BASE:-http://127.0.0.1:8787}"
CREDS=".secrets/remote-pg.env"
[ -f "$CREDS" ] || { echo "missing $CREDS"; exit 1; }

# shellcheck disable=SC1090
set -a; . "$CREDS"; set +a
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/connection.json" <<JSON
{
  "engine": "postgres",
  "host": "${DATA_AGENT_PG_HOST}",
  "port": ${DATA_AGENT_PG_PORT},
  "database": "${DATA_AGENT_PG_DATABASE}",
  "user": "${DATA_AGENT_PG_USER}",
  "password": "${DATA_AGENT_PG_PASSWORD}",
  "environment": "non_production",
  "workspace": { "name": "${DATA_AGENT_PG_WORKSPACE}" },
  "label": "shared-pg"
}
JSON
WIN_JSON="$(wslpath -w "$TMP/connection.json")"

echo "== healthz"
"$CURL" -sS "$BASE/healthz"; echo

echo "== connection test"
"$CURL" -sS -X POST "$BASE/v1/connections/test" \
  -H "content-type: application/json" --data-binary @"$WIN_JSON" | head -c 1200; echo

if [ "${1:-}" = "session" ]; then
  echo "== create session"
  "$CURL" -sS -X POST "$BASE/v1/sessions" \
    -H "content-type: application/json" --data-binary @"$WIN_JSON" | head -c 1200; echo
fi
