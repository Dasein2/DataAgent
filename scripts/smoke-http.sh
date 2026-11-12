#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
W=/mnt/c/Windows/System32/curl.exe
PORT=${DATA_AGENT_PORT:-8799}
TARGET=${1:-src}
if [ "$TARGET" = "dist" ]; then
  timeout 60 node.exe dist/server.js > /tmp/da5.log 2>&1 &
else
  timeout 60 node.exe node_modules/tsx/dist/cli.mjs src/server.ts > /tmp/da5.log 2>&1 &
fi
sleep 12
{
  echo "--- health"; $W -s -m 5 "http://127.0.0.1:$PORT/healthz"; echo
  echo "--- capabilities"; $W -s -m 5 "http://127.0.0.1:$PORT/v1/capabilities"; echo
  echo "--- session empty body (expect 400)"; $W -s -m 10 -X POST -H "content-type: application/json" -d '{}' "http://127.0.0.1:$PORT/v1/sessions"; echo
  echo "--- connection test unreachable (expect 422)"; $W -s -m 25 -X POST -H "content-type: application/json" \
    -d '{"connection":{"engine":"postgres","host":"127.0.0.1","port":5999,"database":"x","user":"y","password":"z"}}' \
    "http://127.0.0.1:$PORT/v1/connections/test"; echo
  echo "--- console html"; $W -s -m 5 "http://127.0.0.1:$PORT/" | head -c 120; echo
  echo "--- unknown result (expect 404)"; $W -s -m 5 "http://127.0.0.1:$PORT/v1/results/res_doesnotexist1"; echo
  echo "--- unknown task events (expect error event)"; $W -s -m 5 "http://127.0.0.1:$PORT/v1/tasks/task_nope/events"; echo
  echo "--- unknown route (expect 404)"; $W -s -m 5 "http://127.0.0.1:$PORT/v1/nope"; echo
} > /tmp/api.out 2>&1
wait
cat /tmp/api.out
echo "=== server log"
cat /tmp/da5.log
