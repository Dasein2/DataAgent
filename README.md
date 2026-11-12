# Data Agent

Headless database-analysis agent service. An HTTP client hands over a connection configuration
(PostgreSQL, MySQL, Apache Doris or StarRocks, optionally through an SSH jump host) and an analysis
goal; the service drives a pi agent session that explores the catalog, writes SQL, collects results
and can persist intermediate views — while source data stays read-only.

- Agent runtime: [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  (no kernel changes; only public SDK, custom tools and prompt configuration).
- Database layer: own engine abstraction (`src/db/engines/`), pinned connection, read-only proof,
  server-side cancellation on a second connection. Per-engine differences are declared as data in
  `src/db/engines/profiles.ts`; the tool layer never branches on the engine id.
- Access control: `source_access = read_only` is enforced by the database account **and** a
  read-only transaction (or, on engines that have none, by analysing the account's grants); the SQL
  guard is defence in depth, never the only boundary.

## Quick start

```bash
cp .env.example .env        # set DATA_AGENT_MODEL_* and (in production) DATA_AGENT_API_TOKEN
npm install
npm run dev                 # http://127.0.0.1:8787  → web console at / (restarts on src and .env changes)
```

Model environment variables use the `DATA_AGENT_MODEL_*` prefix on purpose: `PI_*` is already used
by the pi harness itself and would collide.

Minimum model configuration:

```dotenv
DATA_AGENT_MODEL_PROVIDER=openai
DATA_AGENT_MODEL_ID=gpt-5.2
DATA_AGENT_MODEL_API_KEY=sk-...
# Optional OpenAI-compatible endpoint:
# DATA_AGENT_MODEL_BASE_URL=https://api.example.com/v1
# DATA_AGENT_MODEL_API=openai-completions
```

## HTTP API

All `/v1/*` routes require `Authorization: Bearer $DATA_AGENT_API_TOKEN` when a token is configured.
Callers can add `X-Caller-Id` to scope session ownership (defaults to a hash of the token).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | liveness + active model |
| GET | `/v1/capabilities` | engines, tool names, budgets, limits |
| GET | `/v1/engines` | declared engine profiles (port, protocol, dialect, capability flags) |
| POST | `/v1/connections/test` | open a connection, report capabilities, close it |
| GET | `/v1/connections/profiles` | caller's saved connections (credentials redacted) and secret-storage availability |
| PUT | `/v1/connections/profiles/{name}` | save/replace `{connection, rememberSecret}` |
| DELETE | `/v1/connections/profiles/{name}` | delete a saved connection |
| POST | `/v1/sessions` | create a pinned session (one DB connection + one SSH chain) |
| GET | `/v1/sessions` | list the caller's live and historical sessions |
| GET | `/v1/sessions/{id}` | session snapshot (capabilities, budgets, datasets, tasks) |
| DELETE | `/v1/sessions/{id}` | close session and its tunnel |
| POST | `/v1/sessions/{id}/reconnect` | reconnect the original database/account and resume the saved conversation |
| GET | `/v1/sessions/{id}/tasks` | saved tasks, including final/partial answers and errors |
| GET | `/v1/sessions/{id}/results` | result metadata for the session |
| POST | `/v1/sessions/{id}/tasks` | submit an analysis goal (queued if the session is busy) |
| GET | `/v1/tasks/{id}` | task state: `queued/running/succeeded/failed/cancelled/incomplete` |
| GET | `/v1/tasks/{id}/events` | SSE stream (resumable with `Last-Event-ID`) |
| POST | `/v1/tasks/{id}/cancel` | cancel the running query and the task |
| POST | `/v1/tasks/{id}/steer` | inject a follow-up instruction into the running task |
| GET | `/v1/results/{id}` | paged rows: `?offset=0&limit=50` |

Create a session:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "connection": {
    "engine": "postgres",
    "host": "db.internal",
    "port": 5432,
    "database": "analytics",
    "user": "ro_analyst",
    "password": "…",
    "environment": "production",
    "workspace": { "name": "analysis_ws" },
    "ssl": { "mode": "verify-full", "serverName": "db.internal", "ca": "-----BEGIN CERTIFICATE-----…" },
    "ssh": { "hops": [{ "host": "bastion", "port": 22, "username": "jump",
              "auth": { "method": "privateKey", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----…" },
              "hostFingerprint": "SHA256:…" }] }
  }
}'
```

Submit a task and stream it:

```bash
curl -s -X POST .../v1/sessions/$SID/tasks -H 'content-type: application/json' \
  -d '{"goal":"按月统计 2025 年 GMV，并指出退款率异常的月份"}'
curl -N .../v1/tasks/$TID/events
```

SSE frame shape (`event:` mirrors `data.type`):

```json
{ "seq": 12, "id": "task_ab12:12", "task_id": "task_ab12",
  "type": "tool_finished", "at": "2025-03-01T10:00:00.000Z",
  "data": { "tool": "query_execute", "is_error": false, "duration_ms": 41,
            "details": { "result_id": "res_…", "row_count": 240, "truncated": "none" } } }
```

Event types: `task_queued`, `task_started`, `turn_started`, `message_delta`, `reasoning_delta`,
`tool_started`, `tool_finished`, `usage`, `retry`, `context_compacted`, `notice`, `task_finished`.

`succeeded` requires a complete, non-empty final assistant answer. A final model error is `failed`
(`MODEL_ERROR`); a token limit, missing final answer, turn limit or interrupted execution is
`incomplete`, with a reason code and any partial answer retained. User cancellation is `cancelled`;
wall-clock timeout is `failed`. A temporary model/tool error followed by a complete answer can still
succeed. Every queued task keeps its own `max_turns`.

The console reconnects interrupted streams with `Last-Event-ID`, suppresses duplicates and polls
task state between retries so a missed terminal event does not leave the controls stuck. Loading a
historical session also resumes an active task's progress.

## Agent tools

`session_info`, `catalog_search`, `object_describe`, `data_profile`, `query_explain`,
`query_execute`, `job_get`, `job_cancel`, `result_read`, `dataset_create`, `dataset_list`,
`dataset_drop`.

Models never write DDL and never see credentials. `dataset_create(name, select_sql, kind)` is the
only write path; the service generates `CREATE [SQL SECURITY INVOKER] VIEW` or `CREATE TABLE AS` in
the pre-provisioned workspace. Results are always handle-based: `query_execute` returns a preview and
a `result_id`; `result_read` pages the full NDJSON on disk.

## Security model

| Layer | What it guarantees |
| --- | --- |
| Database account | Only `SELECT` on source; no DDL/DML on source objects |
| Read-only proof | `BEGIN TRANSACTION READ ONLY` (PG) / `START TRANSACTION READ ONLY` (MySQL) pinned for the session; Doris/StarRocks have no read-only transaction, so `SHOW GRANTS` must prove the account cannot write (`read_only_proof = grants`), otherwise the connection is refused with `READONLY_UNVERIFIED` unless `allowWeakReadOnly: true` explicitly accepts `service_only` |
| SQL guard | Single statement, allowed leading verbs, denied keywords/functions, block-comment and dollar-quote aware, no `SELECT INTO`, no `FOR UPDATE/SHARE`, no file access |
| Workspace isolation | Session registries record dataset ownership; listing/deletion require this session's successful creation record. A shared workspace object or matching `ds_*` name alone grants no deletion rights. Conflicting names are refused; failed CREATE cleanup never drops an uncertain object. |
| Production policy | Undeclared environment = `production`; production workspaces are views-only |
| Network | SSH hops require pinned SHA256 host fingerprints (fail closed); DB TLS verify modes; cloud metadata IPs always blocked |
| Budgets | `min(caller budget, service ceiling)` for turns, queries, wall clock, result rows/bytes, datasets |
| Audit | Every session and query decision appended to `data/audit/{session}.ndjson` |

Session credentials are held in memory. After restart, callers can send the original connection
configuration to `/v1/sessions/{id}/reconnect`, or reference an explicitly saved profile. The engine,
host, port, database, user, environment and workspace must match the original session. Reconnection
restores conversation context and dataset registry; it opens a fresh database connection and resets
its query budget. Interrupted SQL and tasks are never replayed automatically.

Doris/StarRocks cancellation uses `KILL <connection id>`. Cancellation, query timeout and result
truncation can therefore make the session `unavailable`; subsequent database work is refused with
`SESSION_UNAVAILABLE`. Read saved results, then use **恢复分析** (or create a new session) to continue.
MySQL uses statement-only `KILL QUERY`.

`DATA_AGENT_MODEL_THINKING=off|minimal|low|medium|high` is passed to the SDK. Custom endpoint metadata
also enables reasoning when the setting is not `off`; use `off` for endpoints without reasoning
support. Built-in model metadata determines the supported levels for built-in providers.

## History and saved connections

History is persisted under the configured `DATA_AGENT_DATA_DIR` (default `data/`):

- `history/sessions/*.json`: caller ownership, connection identity digest and session snapshots.
- `history/tasks/*.json`: task states, answers, errors and result handles.
- `history/events/*.ndjson`: task event streams; SSE keeps the most recent 5,000 events in memory.
- `conversations/{session_id}/*.jsonl`: pi conversation context for explicit reconnection.
- `connections.json`: server-side connection profiles; passwords and SSH credentials are removed
  from public configuration fields.

Closing/expiring a session releases its connection and preserves its history/results. Restart marks
previously queued/running tasks `incomplete` with `SERVICE_RESTARTED`, retains partial answers and
repairs missing terminal events. Historical APIs enforce the same caller ownership as live APIs.
Existing results from versions without a persisted ownership record cannot be recovered by guessing
their session ID. This is single-process filesystem storage with no automatic history retention;
back up the data directory and avoid sharing it between concurrent service instances.

The console saves profiles through the service API. Non-secret configuration remains available
after clearing browser storage (re-enter the API token if required). To opt into storing database
passwords or SSH credentials, set a stable `DATA_AGENT_PROFILE_SECRET_KEY`, restart and select
**连同密码一起保存**. Secrets use AES-256-GCM; API responses never return decrypted values. Without
the key only non-secret configuration can be saved. Keep the key across restarts; changing it makes
old encrypted secrets unreadable. Unchecking the option and saving removes stored credentials.

Session creation, connection tests and reconnection also accept
`{ "profile": "saved-name", "credentials": { "password": "optional override", "ssh": [] } }`.
Credential overrides apply only to that request. Legacy browser profiles remain selectable and are
migrated only when explicitly saved; their local copy is removed after a successful migration.

## Result storage

`data/results/{result_id}.ndjson` + `.meta.json`. The first N rows are duplicated into the metadata so
previews never touch disk. Parquet export is intentionally left as an interface, not an implementation.
Failed/cancelled query metadata remains available for diagnosis; reading its rows returns
`RESULT_FAILED` rather than presenting a partial/empty result as a successful query.

## Testing

```bash
npm test                        # guard + driver/runtime/history/HTTP/SSE regressions; no external model calls
npm run check                   # tsc --noEmit
npm run build                   # dist/
npm run smoke                   # boots src/ and exercises the HTTP endpoints
bash scripts/smoke-http.sh dist # same against the compiled build
bash scripts/test-integration-local.sh   # PostgreSQL conformance, no Docker (PGlite, real wire protocol)
bash scripts/e2e.sh             # full path: real model + Postgres + SSE + dataset
bash scripts/e2e.sh mysql       # same against the docker MySQL
```

Docker-based conformance for both engines:

```bash
docker compose -f docker-compose.test.yml up -d
printf 'DATA_AGENT_TEST_PG=postgres://ro_analyst:ro@127.0.0.1:55433/analytics?workspace=analysis_ws\nDATA_AGENT_TEST_MYSQL=mysql://ro_analyst:ro@127.0.0.1:53306/analytics?workspace=analysis_ws\n' > tests/.env.test
npm run test:integration
```

`tests/.env.test` exists because a Node binary on another OS (WSL → Windows `node.exe`) does not
inherit shell variables. The integration suite verifies capabilities, SELECT + result paging, write
rejection (guard + database), dataset create/query/drop, the production views-only rule, EXPLAIN and
query budgets, plus cancellation through the control connection on both engines.

`scripts/e2e.sh` is the end-to-end proof: PGlite as the analysed database, `.env.e2e` for the model,
a multi-step goal, then an assertion-friendly dump of the SSE tool trace, the task status and the
final answer (the task record exposes `answer`, so polling clients do not have to reassemble deltas).

## Layout

```
src/
  server.ts              bootstrap + graceful shutdown
  config.ts              env config, .env loader, secret redaction
  errors.ts              error codes → HTTP status
  api/http.ts            Express 5 routes, bearer auth, SSE
  agent/
    model.ts             pi ModelRuntime (models.json, in-memory API key)
    prompts.ts           per-engine system prompt
    tools.ts             12 tool definitions (TypeBox schemas, annotations)
    runtime.ts           pi AgentSession + task queue + event mapping
    service.ts           sessions, ownership, TTL sweeper, result access
    events.ts            bounded per-task event log for SSE resume
    history.ts           durable session/task ownership and event history, restart recovery
  db/
    types.ts             zod connection schema, capabilities
    guard.ts             tokenizer + AST scope checks
    ssh-tunnel.ts        multi-hop SSH chain with pinned fingerprints
    session.ts           pinned connection, budgets, datasets, audit
    profiles-store.ts    per-caller server profiles with opt-in encrypted credentials
    engines/             base.ts, profiles.ts, postgres.ts, mysql.ts (Doris/StarRocks derivations)
  results/store.ts       NDJSON result storage + paging
web/index.html           dependency-free console (forms, chat, SSE, result drawer; saved connections)
web/task-stream.js       SSE reconnection, cursor deduplication and terminal-state polling
tests/                   unit + integration
```

## Known limitations (P0)

- Queries are synchronous; `job_get` reports task state, there is no detached job queue.
- One task runs per session at a time (queue depth 8); steering is supported, approval prompts are not.
- MySQL workspaces require a separate database; if it is unavailable the session degrades to
  read-only analysis with `workspace_access = none`.
- Doris/StarRocks support is declared (profiles, grants-based read-only proof, catalog/query paths)
  but not yet conformance-tested against live servers; dataset DDL is the least verified part.
- The console is a debugging surface, not a product UI. Server profiles and history use local
  filesystem storage; production operators must provide backups, retention and suitable access control.
