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
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE="${1:-postgres}"
ENV_FILE="${2:-.env.e2e}"
NODE="${NODE_BIN:-node.exe}"
CURL=/mnt/c/Windows/System32/curl.exe
PGLITE_PORT="${PGLITE_PORT:-55445}"
APP_PORT="${APP_PORT:-8801}"
BASE="http://127.0.0.1:${APP_PORT}"
tmp="${TMPDIR:-.tmp}/data-agent-e2e-run-${BASHPID}"
mkdir -p "$tmp"
DATA_DIR="./.tmp/data-agent-e2e-data-${BASHPID}"

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

echo "== prepare isolated service config =="
python3 - "$ENV_FILE" "$tmp/runtime.env" "$DATA_DIR" <<'PY'
import sys
from pathlib import Path
source = Path(sys.argv[1])
target = Path(sys.argv[2])
data_dir = sys.argv[3]
lines = source.read_text(encoding="utf-8").splitlines()
lines = [line for line in lines if not line.startswith("DATA_AGENT_DATA_DIR=")]
lines.append(f"DATA_AGENT_DATA_DIR={data_dir}")
target.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

echo "== boot service on ${APP_PORT} =="
"$NODE" node_modules/tsx/dist/cli.mjs src/server.ts --env-file "$tmp/runtime.env" > "$tmp/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do grep -q "listening" "$tmp/app.log" 2>/dev/null && break; sleep 1; done
grep -q "listening" "$tmp/app.log" || { echo "service failed:"; tail -25 "$tmp/app.log"; exit 1; }

echo "== health =="
"$CURL" -s -m 10 "$BASE/healthz"; echo

echo "== test configured model =="
"$CURL" -fsS -m 90 -X POST "$BASE/v1/model/test" -H 'content-type: application/json' > "$tmp/model-test.json"
python3 - "$tmp/model-test.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
print("model test:", result)
assert result.get("ok") is True, "configured model channel failed its test call"
PY

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
"$CURL" -fsS -m 60 -X POST "$BASE/v1/sessions" -H 'content-type: application/json' --data-binary @"$(wslpath -w "$tmp/session.json")" > "$tmp/session-res.json"
cat "$tmp/session-res.json"; echo
SID=$(python3 -c "import json;s=json.load(open('$tmp/session-res.json'))['session'];print(s.get('session_id') or s.get('id'))" 2>/dev/null)
[ -n "$SID" ] || { echo "no session id"; exit 1; }

echo "== submit task =="
cat > "$tmp/task.json" <<'JSON'
{ "goal": "请先查看 sales 表和字段，然后用 SQL 按 region 汇总订单数、订单金额总和及退款率。将汇总结果做成柱状图：x 轴为 region，数值为订单金额总和。请指出退款率最高的 region，并在结论中附上图表的最高数值引用（art_...#cell[...]）。不要创建视图或数据集。" }
JSON
"$CURL" -fsS -m 30 -X POST "$BASE/v1/sessions/$SID/tasks" -H 'content-type: application/json' --data-binary @"$(wslpath -w "$tmp/task.json")" > "$tmp/task-res.json"
cat "$tmp/task-res.json"; echo
TID=$(python3 -c "import json;t=json.load(open('$tmp/task-res.json'))['task'];print(t.get('id') or t.get('task_id'))" 2>/dev/null)
[ -n "$TID" ] || { echo "no task id"; exit 1; }

echo "== stream events (task $TID) =="
# Stop the SSE reader at the terminal event. Disable pipefail for this pipeline because curl
# may receive SIGPIPE after sed exits early even though the task completed normally.
set +o pipefail
"$CURL" -sN -m 420 "$BASE/v1/tasks/$TID/events" 2>&1 | sed -u '/"type":"task_finished"/q' > "$tmp/sse.txt"
set -o pipefail
echo "-- event counts:"
grep -c '^event:' "$tmp/sse.txt" | sed 's/^/total /'
grep '^event:' "$tmp/sse.txt" | sort | uniq -c | sort -rn | head -12

echo "== task result =="
"$CURL" -fsS -m 30 "$BASE/v1/tasks/$TID" > "$tmp/task-final.json"
python3 - "$tmp/task-final.json" "$tmp/sse.txt" "$tmp/artifact-id.txt" <<'PY'
import json, sys
from pathlib import Path
data = json.load(open(sys.argv[1]))
task = data["task"]
print("status:", task["status"], "| turns:", task["turns"], "| queries:", task["queries_used"])
print("error:", task.get("error"))
print("results:", task.get("results"))
print("artifacts:", task.get("artifacts"))
print("answer:\n" + (task.get("answer") or "<none>"))
assert task["status"] == "succeeded", f"task did not succeed: {task['status']}"
assert task.get("artifacts"), "model did not create a chart artifact"
started, finished = set(), set()
for line in open(sys.argv[2], encoding="utf-8", errors="replace"):
    if not line.startswith("data: "): continue
    try: event = json.loads(line[6:])
    except Exception: continue
    payload = event.get("data", {})
    if event.get("type") == "tool_started": started.add(payload.get("tool"))
    if event.get("type") == "tool_finished" and payload.get("tool") == "chart_create" and not payload.get("is_error"):
        finished.add(payload.get("details", {}).get("chart_id"))
assert "query_execute" in started, "model did not execute SQL"
assert "chart_create" in started, "model did not call chart_create"
assert set(task["artifacts"]) & finished, "successful chart tool result was not persisted on the task"
Path(sys.argv[3]).write_text(task["artifacts"][0], encoding="utf-8")
PY
ART_ID=$(cat "$tmp/artifact-id.txt")
echo "== persisted chart artifact =="
"$CURL" -fsS -m 30 "$BASE/v1/artifacts/$ART_ID" > "$tmp/artifact.json"
python3 - "$tmp/artifact.json" "$TID" "$tmp/ref.txt" <<'PY'
import json, sys
from pathlib import Path
artifact = json.load(open(sys.argv[1]))["artifact"]
assert artifact["kind"] == "chart" and artifact["status"] == "ready"
assert artifact["source"]["task_id"] == sys.argv[2]
assert artifact.get("data", {}).get("rows"), "artifact snapshot has no rows"
assert artifact.get("compiled", {}).get("option"), "ECharts option was not persisted"
assert artifact.get("summary", {}).get("top"), "chart has no numeric references"
ref = artifact["summary"]["top"][0]["ref"]
assert ref.startswith(artifact["id"] + "#cell[")
Path(sys.argv[3]).write_text(ref, encoding="utf-8")
print("artifact:", artifact["id"], "| type:", artifact["spec"]["type"], "| points:", artifact["summary"]["cells"], "| ref:", ref)
PY
REF=$(cat "$tmp/ref.txt")
echo "== resolve stable chart reference =="
"$CURL" -fsS -m 30 --get "$BASE/v1/artifacts/$ART_ID/ref" --data-urlencode "ref=$REF" > "$tmp/ref-res.json"
python3 - "$tmp/ref-res.json" "$tmp/artifact.json" "$tmp/ref.txt" <<'PY'
import json, sys
from pathlib import Path
resolved = json.load(open(sys.argv[1]))
artifact = json.load(open(sys.argv[2]))["artifact"]
assert resolved["ref"] == Path(sys.argv[3]).read_text(encoding="utf-8")
assert resolved.get("source", {}).get("sql") == artifact["source"]["sql"]
assert resolved.get("value") is not None
print("value:", resolved["value"], "| SQL:", resolved["source"]["sql"][:240])
PY
echo "== session artifact listing =="
"$CURL" -fsS -m 30 "$BASE/v1/sessions/$SID/artifacts" > "$tmp/artifacts.json"
python3 - "$tmp/artifacts.json" "$ART_ID" <<'PY'
import json, sys
ids = {item["id"] for item in json.load(open(sys.argv[1]))["artifacts"]}
assert sys.argv[2] in ids, "created chart missing from session artifact list"
print("listed artifact:", sys.argv[2])
PY

echo "== restart service and reload artifact =="
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
"$NODE" node_modules/tsx/dist/cli.mjs src/server.ts --env-file "$tmp/runtime.env" > "$tmp/app-restart.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do grep -q "listening" "$tmp/app-restart.log" 2>/dev/null && break; sleep 1; done
grep -q "listening" "$tmp/app-restart.log" || { echo "service restart failed:"; tail -25 "$tmp/app-restart.log"; exit 1; }
"$CURL" -fsS -m 30 "$BASE/v1/artifacts/$ART_ID" > "$tmp/artifact-reloaded.json"
python3 - "$tmp/artifact-reloaded.json" "$tmp/artifact.json" "$tmp/ref-res.json" <<'PY'
import json, sys
reloaded = json.load(open(sys.argv[1]))["artifact"]
original = json.load(open(sys.argv[2]))["artifact"]
resolved = json.load(open(sys.argv[3]))
assert reloaded["id"] == original["id"]
assert reloaded["data"] == original["data"]
assert reloaded["compiled"] == original["compiled"]
assert resolved["value"] == "560.74"
print("reloaded artifact:", reloaded["id"], "| ref value:", resolved["value"])
PY

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
