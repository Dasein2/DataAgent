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
| POST | `/v1/sessions` | create a pinned session (one DB connection + one SSH chain) |
| GET | `/v1/sessions` | list the caller's sessions |
| GET | `/v1/sessions/{id}` | session snapshot (capabilities, budgets, datasets, tasks) |
| DELETE | `/v1/sessions/{id}` | close session and its tunnel |
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
| Workspace isolation | Objects must live in this session's workspace (`dwa_` reserved prefix); other sessions' workspaces are rejected |
| Production policy | Undeclared environment = `production`; production workspaces are views-only |
| Network | SSH hops require pinned SHA256 host fingerprints (fail closed); DB TLS verify modes; cloud metadata IPs always blocked |
| Budgets | `min(caller budget, service ceiling)` for turns, queries, wall clock, result rows/bytes, datasets |
| Audit | Every session and query decision appended to `data/audit/{session}.ndjson` |

Credentials are held in memory per session. After a restart callers must send the connection
configuration again; saved conversations/results remain readable but never imply that a database
connection was restored.

## Result storage

`data/results/{result_id}.ndjson` + `.meta.json`. The first N rows are duplicated into the metadata so
previews never touch disk. Parquet export is intentionally left as an interface, not an implementation.

## Testing

```bash
npm test                        # unit: SQL guard, schemas, redaction, result store, event broker
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
  db/
    types.ts             zod connection schema, capabilities
    guard.ts             tokenizer + AST scope checks
    ssh-tunnel.ts        multi-hop SSH chain with pinned fingerprints
    session.ts           pinned connection, budgets, datasets, audit
    engines/             base.ts, profiles.ts, postgres.ts, mysql.ts (Doris/StarRocks derivations)
  results/store.ts       NDJSON result storage + paging
web/index.html           dependency-free console (forms, chat, SSE, result drawer)
tests/                   unit + integration
```

## Known limitations (P0)

- Queries are synchronous; `job_get` reports task state, there is no detached job queue.
- One task runs per session at a time (queue depth 8); steering is supported, approval prompts are not.
- MySQL workspaces require a separate database; if it is unavailable the session degrades to
  read-only analysis with `workspace_access = none`.
- Doris/StarRocks support is declared (profiles, grants-based read-only proof, catalog/query paths)
  but not yet conformance-tested against live servers; dataset DDL is the least verified part.
- The console is a debugging surface, not a product UI.
