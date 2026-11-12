#!/usr/bin/env bash
# End-to-end check with a real model and a real database.
#
#   bash scripts/e2e.sh
#
#   bash scripts/e2e.sh mysql      # against the docker MySQL from docker-compose.test.yml
#
# - boots PGlite (real PostgreSQL wire protocol) as the analysed database, or reuses MySQL
# - boots the service with .env.e2e (model credentials come from the local pi auth store)
# - creates a session, submits a multi-step analysis goal, streams SSE, prints the answer
set -uo pipefail
cd "$(dirname "$0")/.."

ENGINE="${1:-postgres}"
NODE="${NODE_BIN:-node.exe}"
CURL=/mnt/c/Windows/System32/curl.exe
PGLITE_PORT="${PGLITE_PORT:-55445}"
APP_PORT="${APP_PORT:-8801}"
BASE="http://127.0.0.1:${APP_PORT}"
tmp=/tmp/data-agent-e2e

rm -rf "$tmp"; mkdir -p "$tmp"

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  [ -n "${DB_PID:-}" ] && kill "$DB_PID" 2>/dev/null
  true
}
trap cleanup EXIT

if [ "$ENGINE" = "mysql" ]; then
  echo "== using MySQL on 127.0.0.1:53306 (docker compose -f docker-compose.test.yml up -d mysql) =="
  DB_PORT=53306; DB_NAME=analytics; DB_USER=ro_analyst; DB_PASS=ro
else
  echo "== boot database (pglite on ${PGLITE_PORT}) =="
  "$NODE" scripts/pglite-server.mjs "$PGLITE_PORT" > "$tmp/db.log" 2>&1 &
  DB_PID=$!
  for _ in $(seq 1 60); do grep -q listening "$tmp/db.log" 2>/dev/null && break; sleep 1; done
  grep -q listening "$tmp/db.log" || { echo "database failed:"; cat "$tmp/db.log"; exit 1; }
  DB_PORT=$PGLITE_PORT; DB_NAME=postgres; DB_USER=postgres; DB_PASS=postgres
fi

echo "== boot service on ${APP_PORT} =="
"$NODE" node_modules/tsx/dist/cli.mjs src/server.ts --env-file .env.e2e > "$tmp/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do grep -q "listening" "$tmp/app.log" 2>/dev/null && break; sleep 1; done
grep -q "listening" "$tmp/app.log" || { echo "service failed:"; tail -25 "$tmp/app.log"; exit 1; }

echo "== health =="
"$CURL" -s -m 10 "$BASE/healthz"; echo

echo "== create session =="
cat > "$tmp/session.json" <<JSON
{
  "connection": {
    "engine": "${ENGINE}",
    "host": "127.0.0.1",
    "port": ${DB_PORT},
    "database": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASS}",
    "environment": "non_production",
    "workspace": { "name": "analysis_ws" }
  }
}
JSON
"$CURL" -s -m 60 -X POST "$BASE/v1/sessions" -H 'content-type: application/json' --data-binary @"$(wslpath -w "$tmp/session.json")" > "$tmp/session-res.json"
cat "$tmp/session-res.json"; echo
SID=$(python3 -c "import json;s=json.load(open('$tmp/session-res.json'))['session'];print(s.get('session_id') or s.get('id'))" 2>/dev/null)
[ -n "$SID" ] || { echo "no session id"; exit 1; }

echo "== submit task =="
cat > "$tmp/task.json" <<'JSON'
{ "goal": "先看看库里有什么表和字段。然后按 region 统计订单数、总金额和退款率，找出退款率最高的 region。最后把这个汇总做成一个名为 ds_region_summary 的视图，并用它给出结论。" }
JSON
"$CURL" -s -m 30 -X POST "$BASE/v1/sessions/$SID/tasks" -H 'content-type: application/json' --data-binary @"$(wslpath -w "$tmp/task.json")" > "$tmp/task-res.json"
cat "$tmp/task-res.json"; echo
TID=$(python3 -c "import json;t=json.load(open('$tmp/task-res.json'))['task'];print(t.get('id') or t.get('task_id'))" 2>/dev/null)
[ -n "$TID" ] || { echo "no task id"; exit 1; }

echo "== stream events (task $TID) =="
# Stop reading as soon as task_finished arrives: without this the SSE connection stays open with
# heartbeats and curl waits out its full -m timeout even though the task already ended.
"$CURL" -sN -m 420 "$BASE/v1/tasks/$TID/events" 2>&1 | sed -u '/"type":"task_finished"/q' > "$tmp/sse.txt"
echo "-- event counts:"
grep -c '^event:' "$tmp/sse.txt" | sed 's/^/total /'
grep '^event:' "$tmp/sse.txt" | sort | uniq -c | sort -rn | head -12

echo "== task result =="
"$CURL" -s -m 30 "$BASE/v1/tasks/$TID" > "$tmp/task-final.json"
python3 - "$tmp/task-final.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
task = data["task"]
print("status:", task["status"], "| turns:", task["turns"], "| queries:", task["queries_used"])
print("error:", task.get("error"))
print("results:", task.get("results"))
print("answer:\n" + (task.get("answer") or "<none>"))
PY

echo "== datasets in session =="
"$CURL" -s -m 30 "$BASE/v1/sessions/$SID" > "$tmp/session-final.json"
python3 - "$tmp/session-final.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(json.dumps(data.get("datasets", data), ensure_ascii=False)[:600])
PY

echo "== tool trace =="
python3 - "$tmp/sse.txt" <<'PY'
import json, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if not line.startswith("data: "):
        continue
    try:
        event = json.loads(line[6:])
    except Exception:
        continue
    if event.get("type") in {"tool_started", "tool_finished", "task_finished"}:
        payload = event.get("data", {})
        print(event["type"], payload.get("tool") or payload.get("status") or "", str(payload.get("is_error", "")))
PY

echo "== service log tail =="
tail -12 "$tmp/app.log"
