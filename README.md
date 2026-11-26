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

## Read-only BI workbench

The console includes searchable history/schema panels, query/turn budgets, a paged result explorer,
local SQL and named snapshots, an evidence dashboard, keyboard commands (`Ctrl/⌘ K`) and light/dark themes.
Source data remains read-only; local analysis does not open another source extraction channel.
See [使用与配置说明](docs/readonly-bi-workbench.md) and [实施/验收记录](docs/readonly-bi-roadmap.md)
for safety boundaries, API examples, defaults and test limitations.

After connecting, use **业务资料** in the workbench to manage Markdown definitions and **业务上下文**
next to the chat input to apply documents once per session or save them as connection defaults.
See [业务资料与会话上下文](docs/readonly-bi-workbench.md#业务资料与会话上下文) for versioning,
limits and API details.

## Quick start

```bash
cp .env.example .env        # configure a model and choose an auth mode before deploying
npm install
npm run dev                 # http://127.0.0.1:8787  → web console at / (restarts on src and .env changes)
```

Model environment variables use the `DATA_AGENT_MODEL_*` prefix on purpose: `PI_*` is already used
by the pi harness itself and would collide.

**Independent model management:** open **模型配置 → 模型管理** to create, edit, test and select
project-owned channels with multiple models. Credentials and configuration survive restarts without
any pi CLI installation or personal pi directory. See [独立模型管理与服务器部署](docs/model-management.md)
for the UI workflow, HTTP API, migration and security boundaries.

For development compatibility, the model follows your pi setup when imports are enabled: with `DATA_AGENT_MODEL_PROVIDER`, `DATA_AGENT_MODEL_ID`
and `DATA_AGENT_MODEL_THINKING` unset, the service starts on whatever pi's `settings.json` says
(`defaultProvider` / `defaultModel` / `defaultThinkingLevel`) and uses that channel's credential from
`models.json`. A pi upgrade that retargets pi therefore needs no edit here.

Pin a channel explicitly when you want the service to differ from pi:

```dotenv
DATA_AGENT_MODEL_PROVIDER=openai
DATA_AGENT_MODEL_ID=gpt-5.2
DATA_AGENT_MODEL_API_KEY=sk-...   # optional: otherwise pi's channel key is used
# Optional OpenAI-compatible endpoint:
# DATA_AGENT_MODEL_BASE_URL=https://api.example.com/v1
# DATA_AGENT_MODEL_API=openai-completions
```

Values set in `.env` always win over the pi defaults; the console override
(`model-settings.json`) still layers on top of both.

## Account login and private connections

Enable account mode in `.env` (or `.env.prod` for Docker Compose):

```dotenv
DATA_AGENT_REQUIRE_AUTH=1
DATA_AGENT_ADMIN_PASSWORD=<unique password, at least 8 characters>
DATA_AGENT_PROFILE_SECRET_KEY=<random stable key, e.g. generated with openssl rand -hex 32>
```

1. Start the service once and sign in as **admin**. The bootstrap password only initializes a new
   account store. Afterward, remove `DATA_AGENT_ADMIN_PASSWORD` from the deployment and keep
   `DATA_AGENT_REQUIRE_AUTH=1`. Changing the environment password does not reset the account.
2. Build with `npm run build`, then use `npm run account -- add alice` or
   `npm run account -- reset alice`. Pass the new password via stdin, not as a command-line argument.
   For example, in Bash:

   ```bash
   read -rsp 'Password: ' pw
   printf '%s\n' "$pw" | npm run account -- add alice
   unset pw
   ```

   Append `--env-file .env.prod` if the running service uses that file. With Compose, pipe the password
   to `docker compose exec -T data-agent npm run account -- add alice` instead, so the CLI uses the
   same volume. Resetting a password revokes existing logins without deleting the account's data.
3. In the console, fill in the connection, click **保存连接**, then select the saved profile to
   connect. The server encrypts the full profile, including the database password, SSH private keys,
   passphrases and hop passwords. Credentials aren't returned by the API or saved in browser storage.
   Open a saved session and click **恢复分析** to reconnect using its linked profile, regardless of
   what is currently in the connection form. If the profile was deleted, the target changed, or it
   was never linked, select or enter the original connection and use **使用表单恢复**.

Use HTTPS for network access. Cookies are HttpOnly, SameSite=Strict and expire after seven days.
Production enables Secure cookies by default; keep that enabled behind an HTTPS reverse proxy,
forward the original `Host` header and restrict direct access to the backend port. Login rate limits
are applied per peer IP; clients behind a proxy share its limit. Back up the data directory
(including `accounts.db` and `connections.json`) and keep the encryption key separately and stable.
Losing the key means re-entering saved connection credentials. Global model settings are admin-only;
all accounts use the configured model. Give accounts only the database/network access they need.

Account mode ignores bearer tokens and `X-Caller-Id` for authentication and ownership. Existing bearer
and browser profiles/history are not automatically imported or assigned to an account. Back up legacy
storage and re-save connections after signing in. With account mode disabled, legacy bearer/open mode
remains available; production requires account mode or a bearer token.

## Server deployment

**Single instance only.** Accounts live in SQLite, sessions live in memory and all evidence lives in one
data directory. Do not run two replicas against the same volume and do not put this behind a load
balancer that distributes requests across instances. Scale the machine up instead.

`docker-compose.yml` binds `127.0.0.1:8787` and ships memory/CPU ceilings and log rotation. A reverse
proxy must:

- terminate TLS (account mode issues `Secure; __Host-` cookies, which browsers refuse over plain HTTP
  to anything but localhost), and
- forward the original `Host` header, because the CSRF check compares `Origin` against it, and
- forward `X-Forwarded-For` **and** set `DATA_AGENT_TRUST_PROXY` (e.g. `1` for one hop). Without it every
  request looks like it came from the proxy: the per-IP login limiter would lock out all users at once
  and audit records would show the proxy address. Never set it while the service is also directly
  reachable — a client could then forge the header and reset its own rate limit.
- wait for `GET /readyz` (503 while no model credential resolves) instead of `/healthz`. `/healthz` is a
  liveness probe and stays 200 even when the model is unconfigured, so the console can still be used to
  fix that. Proxies must also disable response buffering for `/v1/tasks/*/events` (SSE); the service
  sends `x-accel-buffering: no` for nginx-compatible proxies.

```caddyfile
agent.example.com {
  reverse_proxy 127.0.0.1:8787
  encode gzip
}
```

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;   # SSE task events
}
```

Retention defaults to 30 days when `NODE_ENV=production` (`DATA_AGENT_RETENTION_DAYS=0` disables it).
Enabling it is not optional in practice: without it, session evidence and event logs grow until the
volume fills. Audit `ndjson` files are never purged by retention and need their own rotation. Note that
`node:sqlite` is still flagged experimental in Node 24, so pin the image (e.g. `node:24.14-alpine`)
rather than tracking `24-alpine` if you cannot re-test on every minor upgrade.

Back up the data volume together with `DATA_AGENT_PROFILE_SECRET_KEY` — separately, since the key
unlocks the saved connection credentials:

```bash
DEST=/backup/data-agent/$(date +%F); mkdir -p "$DEST"
docker run --rm -v data-agent-data:/data:ro -v "$DEST":/backup alpine \
  tar czf /backup/data.tar.gz -C /data .
cp .env.prod "$DEST/env.backup"; chmod 600 "$DEST/env.backup"
```

## HTTP API

In account mode, `POST /v1/auth/login` accepts `{username, password}` and sets a session cookie;
`GET /v1/auth/status` reports the current login and `POST /v1/auth/logout` revokes it. Other `/v1` routes
require the cookie. In legacy mode, those routes use `Authorization: Bearer $DATA_AGENT_API_TOKEN`
when configured; `X-Caller-Id` scopes legacy ownership (default: a hash of the token).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | liveness + active model |
| GET | `/v1/capabilities` | engines, tool names, budgets, limits |
| GET | `/v1/engines` | declared engine profiles (port, protocol, dialect, capability flags) |
| GET | `/v1/model` | effective model settings, where each value comes from, credential readiness |
| PUT | `/v1/model` | override model settings (write-only `apiKey`); refused unless `DATA_AGENT_ALLOW_MODEL_EDIT` |
| DELETE | `/v1/model` | drop all console overrides and rebuild from the environment |
| POST | `/v1/model/test` | send one 16-token completion through the active handle and report latency/HTTP status |
| GET | `/v1/tools` | complete tool catalogue; `?session_id=…` returns the active tools of an owned live session |
| POST | `/v1/connections/test` | open a connection, report capabilities, close it |
| POST | `/v1/connections/host-key` | read an unconfirmed jump host's key (`{connection}` or `{profile, credentials}`); `pin` stores the confirmed one |
| GET | `/v1/connections` or `/v1/connections/profiles` | caller's saved connections (credentials redacted) and secret-storage availability |
| PUT | `/v1/connections/profiles/{name}` | save/replace `{connection, rememberSecret, session_id?}`; in account mode credentials are always encrypted and saved |
| DELETE | `/v1/connections/profiles/{name}` | delete a saved connection |
| POST | `/v1/sessions` | create a pinned session (one DB connection + one SSH chain) |
| GET | `/v1/sessions` | list the caller's live and historical sessions |
| GET | `/v1/sessions/{id}` | session snapshot (capabilities, budgets, datasets, tasks) |
| DELETE | `/v1/sessions/{id}` | close session and its tunnel; `?purge=true` also deletes its history, results and artifacts |
| POST | `/v1/sessions/{id}/reconnect` | resume using the linked profile (no body), or provide the original connection explicitly |
| POST | `/v1/sessions/{id}/title` | name the session from its own conversation (works for live and saved sessions) |
| GET | `/v1/sessions/{id}/tasks` | saved tasks, including final/partial answers and errors |
| GET | `/v1/sessions/{id}/results` | result metadata for the session |
| POST | `/v1/sessions/{id}/tasks` | submit an analysis goal; queued if running, refused while awaiting clarification |
| GET | `/v1/tasks/{id}` | task state: `queued/running/waiting_for_user/succeeded/failed/cancelled/incomplete` |
| GET | `/v1/tasks/{id}/events` | SSE stream (resumable with `Last-Event-ID`) |
| POST | `/v1/tasks/{id}/answer` | answer a pending clarification: `{question_id, option_id}` or `{question_id, text}` |
| POST | `/v1/tasks/{id}/cancel` | cancel a queued, running or waiting task |
| POST | `/v1/tasks/{id}/steer` | inject an instruction into a running task; not a clarification answer |
| GET | `/v1/results/{id}` | paged rows: `?offset=0&limit=50` |
| GET | `/v1/results/{id}/data.csv` | streamed CSV export (truncated results are named `-partial`) |
| GET | `/v1/sessions/{id}/artifacts` | chart artifacts produced in the session |
| GET | `/v1/artifacts/{id}` | one artifact: spec, long-format data snapshot, compiled ECharts option, summary |
| GET | `/v1/artifacts/{id}/data.csv` | CSV export of the snapshot (audited) |
| GET | `/v1/artifacts/{id}/ref?ref=…` | resolve a URL-encoded value reference to the exact snapshot row and source SQL |
| GET | `/vendor/echarts.min.js` | vendored ECharts used by the console (7-day cache) |

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
`tool_started`, `tool_finished`, `usage`, `retry`, `context_compacted`, `notice`, `question_asked`,
`question_answered`, `answer_ready`, `task_finished`.

`answer_ready` carries a completed, non-tool assistant response (`{answer}`), before final evidence
bookkeeping. It is not emitted for intermediate query previews and is not a terminal task state;
clients must still process `task_finished` for the authoritative status, partial/failure label and evidence.

`succeeded` requires a complete, non-empty final assistant answer. A final model error is `failed`
(`MODEL_ERROR`); a token limit, missing final answer, turn limit or interrupted execution is
`incomplete`, with a reason code and any partial answer retained. User cancellation is `cancelled`;
wall-clock timeout is `failed`. A temporary model/tool error followed by a complete answer can still
succeed. Every queued task keeps its own `max_turns`.

The console reconnects interrupted streams with `Last-Event-ID`, suppresses duplicates and polls
task state between retries so a missed terminal event does not leave the controls stuck. Loading a
historical session also resumes an active task's progress. A per-question status card appears before
the submit request returns, displays event-backed stages and elapsed execution time, pauses while
waiting for a user choice, and exposes cancellation. Long queries show an explicit waiting message,
not invented percentages. Stream outages retain the task reservation and offer recovery; they do
not turn a running analysis into a failed task. Polling also restores pending clarification cards.

Analysis tasks start with the full capability-gated toolset, not a mandatory intent confirmation.
The model uses conversation, supplied business context and published definitions first, then targeted
metadata reads and bounded samples when needed to understand the available data. A clear request
proceeds directly. Once there is enough context to identify a material business choice that evidence
cannot settle, the model proactively calls `ask_user` before analysis that depends on that choice.
Questions explain the impact and offer grounded choices when known; “Other / add details” accepts
free-text corrections through the main message input. Selecting it does not answer or resume the
task until text is sent. There is no per-task question quota, generic “confirm and start” gate or
requirement to inspect the whole database. Obvious user-only choices may be asked immediately.

Each question settles the current Pi run and enters `waiting_for_user`; no other tool in that turn
executes. After a reply, analysis continues with the context already gathered rather than restarting
discovery. A later, newly discovered material ambiguity can prompt another question. API clients
read the pending question from `question_asked` or the last entry in `task.clarifications`. A reply
requires the current question ID; duplicate or stale replies cannot resume the task again. The task
continues in the same session under its original ID and cumulative budgets. `execution_ms` excludes
user wait time, which is tracked separately in `waiting_ms`. A task can ask up to eight questions,
one at a time. New tasks require `max_turns >= 1`; asking a question requires at least two model
turns left in the task budget. Each wait expires after 15 minutes or the
configured session TTL, whichever is shorter.
Waiting reserves the conversation, so queued work runs after the waiting task. Closing the session
cancels a pending task. On restart, any remaining pending tasks become `incomplete` and retain
their clarification history. Each clarification applies to its analysis task.

The model is instructed to answer only the requested scope, stop once sufficient evidence and
material correctness checks are available, and avoid unsolicited recommendations or extra analyses.
A value question leads with the number/unit/window; a comparison or distribution uses a compact
chart/table; causal claims are limited by available evidence. Detailed reports and SQL are provided
when explicitly requested. These are model instructions, not a guarantee of model compliance.

Each question groups intermediate text, tool cards, retries and notices into one execution-process
disclosure, collapsed by default during execution and again on completion. The completed answer is
placed before technical history. Fenced SQL in an answer is moved to a collapsed SQL disclosure,
without hiding prose or important caveats. Saved results have a separate collapsed data-evidence
entry to inspect rows, SQL and execution time. The final answer, charts and terminal error remain outside. The summary shows intermediate message
count, distinct tool calls and elapsed execution time, with retry/tool-error counts. SSE text deltas
are not counted as separate messages and hidden reasoning is never included. Plain answers without
intermediate content do not show an empty disclosure. Historical details load only when expanded via
`GET /v1/tasks/:id/activity` (owner-authorized, compacted deltas); reopening the fold preserves its DOM.
Old retained event histories receive optional summary metadata when first listed. Deleted or missing
history cannot be reconstructed from the final answer alone.

## Experience acceptance

`npm run eval:experience -- --env-file .env.e2e --pi-provider <provider> --pi-model <model>` runs four synthetic scenarios (value,
distribution/chart, evidence-grounded clarification and causal limits) with the configured real model
against a fresh isolated PGlite database. It writes `.tmp/answer-experience-eval.json` with answers,
questions, SQL, tool counts and answer-ready/execution timings, then removes its temporary data.
It never opens production connections or changes the application default. Pi overrides use the chosen
channel’s own endpoint and credentials, not the environment model key. Use `--case clarification`
to rerun a single scenario. A blocked model channel stops the run; a blocked channel or failed smoke
check returns a nonzero exit code. Review answer quality manually; these
timings exclude browser rendering and are not a before/after production benchmark. See
[experience acceptance](docs/analysis-experience-acceptance.md) for checks and current limitations.

## Agent tools

The service has 25 tool definitions, gated by session capabilities:

- Clarify: `ask_user`, available across all supported engines without a business catalog.
- Discover: `session_info`, `catalog_search`, `catalog_overview`, `object_describe(objects)` (1–20 relations), `data_profile`.
- Source read: `query_explain`, `query_execute` (`dry_run`, opt-in `reuse`).
- Saved rows: `result_read` (`mode: "rows"` for paging/projection, `"summary"` for statistics), `result_compute` (structured computation) and `result_transform` (local SQL over `source: {kind: "result" | "snapshot", id}`).
- Local snapshots: `snapshot_create`, `snapshot_list`, `snapshot_drop`.
- BI evidence: `chart_create`.
- Controlled workspace: `dataset_create`, `dataset_list`, `dataset_drop`.
- Task and chart management: `job_get`, `job_cancel`, `chart_list`, `chart_archive`, `chart_revise`.
- Optional Doris pilot: `business_lookup`, `business_analyze` (an enabled published catalog is required).

Management tools are available in the same conversation as analysis. The model is instructed to
cancel SQL, rename charts, or archive/restore charts only when the user asks. A session gets 20
standard tools on an engine with plan support, plus the 3 workspace tools when it has a writable workspace.
Engines without plan support omit `query_explain`. Tool visibility is not an access grant: workspace
checks, source read-only enforcement, ownership, and budgets still apply. The workbench’s task,
snapshot and artifact APIs are unchanged. The old `DATA_AGENT_TOOL_PROFILE` setting is ignored and
can be removed.

Models cannot issue source DDL/DML and never see credentials. For `dataset_create(name, select_sql, kind)`
the service generates `CREATE [SQL SECURITY INVOKER] VIEW` or `CREATE TABLE AS` in the pre-provisioned
workspace; `dataset_drop` can only remove session-owned workspace objects. Prefer saved rows for local
follow-ups; query the source only when saved data is insufficient or freshness is needed. Use a workspace
dataset only when later source SQL must reference it. See [tool routing A/B evaluation](docs/tool-routing-eval.md)
for the behavior checks against the old 24-tool setup.

## Charts and artifacts

`chart_create(result_id, type, …)` turns an executed result into an immutable artifact. It does not
run SQL and it cannot aggregate: the numbers must already be grouped by the query (`GROUP BY`), so the
snapshot and the SQL that produced it stay the same evidence. Types are `bar`, `line`, `area`,
`heatmap`, `table`, `pie`, `donut`, `scatter` and `kpi`. `series` splits a cartesian chart into
grouped series; stacking/percentage mode and value sorting must be explicit. A bar/line artifact also stores
the alternative figure type so the console can switch between them without another model call.

An artifact is a record, not a cache of the UI state:

- `spec`: what was asked for (fields, explicit axis order, formats). Versioned by `SPEC_VERSION`.
- `data`: the long-format snapshot (columns with roles `x`/`y`/`series`/`value`, rows, `row_key`).
- `compiled`: the ECharts option produced by the server compiler, plus `COMPILER_VERSION` and
  `ECHARTS_VERSION`. The console adapts the visible range to the chart's display size without
  modifying this saved option.
- `summary`: shape, cell/point count, missing combinations, colour clipping, top values and the
  `art_…#cell[field=value]` refs a report should quote instead of retyping numbers. Click a reference
  in the console to inspect its exact value, row and source SQL. Numeric strings retain their original
  precision when resolved; only chart coordinates use JavaScript floating-point numbers.

Guard rails are errors, not silent fixes: ungrouped duplicates (`CHART_DUPLICATE_CELL`), non-numeric
value columns (`CHART_VALUE_NOT_NUMERIC`), truncated results (`CHART_RESULT_TRUNCATED`), unknown or
ambiguous fields, a multi-label categorical axis without `order`/`sort` (`CHART_ORDER_REQUIRED`), and
row/cell caps (`DATA_AGENT_MAX_CHART_ROWS`, `DATA_AGENT_MAX_CHART_CELLS`). Missing combinations are
reported (`missing`) and drawn as gaps, never as zero. Artifacts are deduplicated per session by
`spec_hash` + `result_id`, and capped per task by `DATA_AGENT_MAX_ARTIFACTS_PER_TASK`.

When categories don't fit, the console adds independent horizontal and/or vertical sliders. Dense
scatter plots offer both sliders for zooming into a region. Drag the slider window to browse and its
ends to resize the window. Heatmaps also offer **展开全图** (scroll the complete matrix) and
**显示格内数值** (toggle cell labels), including for previously saved charts. These controls do
not run SQL, rewrite the artifact, or change the data, CSV, or artifact limits.

Downloads and figure-type switching are console actions on the stored artifact: CSV and
streamed result export requests are audited to `data/audit/exports.ndjson`. SVG comes from the ECharts
instance, and PNG is drawn off-screen with the canvas renderer. Both images show the current view. The audit records export requests, not proof that the client finished downloading. SVG/PNG
exports run locally in the browser; the console first records an authenticated export-action request
in the same audit (not proof of successful file delivery).

## Security model

| Layer | What it guarantees |
| --- | --- |
| Database account | Only `SELECT` on source; no DDL/DML on source objects |
| Read-only proof | PG uses a separate `BEGIN TRANSACTION READ ONLY` per query, with `SET LOCAL statement_timeout` and rollback/commit before returning to idle; MySQL uses `START TRANSACTION READ ONLY` pinned for the session; Doris/StarRocks have no read-only transaction, so `SHOW GRANTS` must prove the account cannot write (`read_only_proof = grants`), otherwise the connection is refused with `READONLY_UNVERIFIED` unless `allowWeakReadOnly: true` explicitly accepts `service_only` |
| SQL guard | Single statement, allowed leading verbs, denied keywords/functions, block-comment and dollar-quote aware, no `SELECT INTO`, no `FOR UPDATE/SHARE`, no file access |
| Workspace isolation | Session registries record dataset ownership; listing/deletion require this session's successful creation record. A shared workspace object or matching `ds_*` name alone grants no deletion rights. Conflicting names are refused; failed CREATE cleanup never drops an uncertain object. |
| Production policy | Undeclared environment = `production`; production workspaces are views-only |
| Network | SSH hops require pinned SHA256 host fingerprints (fail closed); DB TLS verify modes; cloud metadata IPs always blocked |
| Budgets | `min(caller budget, service ceiling)` for turns, queries, wall clock, result rows/bytes, datasets |
| Audit | Every session and query decision appended to `data/audit/{session}.ndjson` |

Session credentials are held in memory. After restart, callers can send the original connection
configuration to `/v1/sessions/{id}/reconnect`, reference a saved profile, or omit the body for a
session already linked to a saved profile with credentials. The engine,
host, port, database, user, environment and workspace must match the original session. Reconnection
restores conversation context and dataset registry; it opens a fresh database connection and resets
its query budget. Interrupted SQL and tasks are never replayed automatically.

### Connection-level SQL timeout

In the connection dialog, **单条 SQL 超时** defaults to **自动**. **手动设置** accepts
1–3600 seconds (API: `connection.queryTimeoutMs`, 1000–3600000 ms). Save the profile,
then create/reconnect a session; a running session keeps its original policy. Credentials
are preserved when editing only this setting on a saved profile. Test Connection and session
details expose the effective value, detected server setting, fallback source and any caps.

Auto mode reads the actual session setting at connect time: PostgreSQL `statement_timeout`
(milliseconds / PostgreSQL units), MySQL `max_execution_time` (ms), Doris/StarRocks
`query_timeout` (seconds). Probes read settings only: no performance benchmark, source scan,
server/global setting changes, or automatic retry with a larger timeout. Unsupported settings,
permission failures and malformed values are shown as `unavailable`, not invented defaults.
A detected zero means no server limit, not unlimited agent execution. In those cases, auto
mode falls back to 300 s for Doris/StarRocks and `DATA_AGENT_QUERY_TIMEOUT_MS` (default 60 s)
for PostgreSQL/MySQL. These are safety defaults, not a claim about database capacity.

The effective limit is the minimum of the selected/auto value, a detected positive server
limit, `DATA_AGENT_MAX_QUERY_TIMEOUT_MS` (default 600000 ms), and the task wall-clock limit
(`DATA_AGENT_TASK_TIMEOUT_MS`, default 900000 ms). The task may have less time remaining
when a query starts. PostgreSQL per-statement settings never increase the detected role/session
limit. Preflight remains bounded to at most 5 s; metadata has its own bounded operations.

For a saved-profile request, top-level `queryTimeoutMs: <milliseconds>` overrides only this
policy for testing/connecting/saving; `queryTimeoutMs: null` restores auto mode. Omit the field
to retain the profile policy. The SQL/model tools cannot increase the limit. Reconnect to
re-read settings after a DBA changes them. A larger limit does **not** fix missing partition
filters, server overload or slow SQL.

MySQL, Doris and StarRocks use statement-only `KILL QUERY <connection id>` without falling back
to a connection kill. Stopping an analysis does not close its database session; if no SQL is active
on the pinned connection, no cancellation command is dispatched there. A genuinely lost connection
still reports `SESSION_UNAVAILABLE` and can be recovered with **恢复分析**.

`DATA_AGENT_MODEL_THINKING=off|minimal|low|medium|high|xhigh|max` is passed to the SDK. Custom
endpoint metadata also enables reasoning when the setting is not `off`; use `off` for endpoints
without reasoning support. Built-in model metadata determines the supported levels for built-in
providers, and pi clamps a level the selected model does not serve — `xhigh` and `max` exist for the
families that do (the same set pi's own `defaultThinkingLevel` accepts).
`DATA_AGENT_MODEL_REASONING` (default `env`) turns the declared thinking capability on or off
independently, for a model that accepts a high level but rejects reasoning parameters.

### Wire protocols

`DATA_AGENT_MODEL_API` is validated against the protocols pi-ai can actually speak, because pi accepts
any string and only fails in the middle of a task:

| Protocol | Use it for |
| --- | --- |
| `openai-completions` | Chat Completions; the widest gateway coverage (DeepSeek, Moonshot, Qwen, Ollama, vLLM, one-api) |
| `openai-responses` | OpenAI Responses API; native reasoning items, better tool-call fidelity |
| `anthropic-messages` | Claude, or a gateway exposing an Anthropic-compatible endpoint |
| `google-generative-ai` | Gemini `generateContent` |

`mistral-conversations`, `azure-openai-responses`, `openai-codex-responses`, `bedrock-converse-stream`,
`google-vertex` and `pi-messages` are recognised but refused here: each needs a credential or setting
this service does not manage, and the error says which. A protocol without a base URL is also refused,
because the provider's built-in endpoint already carries its own protocol — leave both unset to use it.

With a base URL the service writes a full provider block (protocol, endpoint, headers, model metadata)
and declares text input only. Without one it leaves pi's catalogue in charge and writes only the fields
you set explicitly, so a model's real 400k window is not replaced by a 128k default. `GET /v1/model`
reports what the runtime will really use for this reason.

### Model settings and tools in the console

The console shows the effective model configuration (provider, model id, protocol, base url, thinking
level, reasoning, context/max tokens, credential source, readiness) and can override it at runtime.
Overrides are stored in `model-settings.json` and layered over the environment: `null` in a patch drops
that override back to the environment value, and **恢复为 .env** clears the file. Two deliberate limits:

- **A key typed in the console is stored per provider** in `model-key.json`, so a restart is not a
reconfiguration. It is accepted write-only and never returned: the API reports only `has_api_key`,
`api_key_source` (`console`, `env`, `channel`, `pi-auth`, `none`) and `api_key_store` (path,
`protection`, providers). Encryption uses the same `DATA_AGENT_PROFILE_SECRET_KEY` as saved
connection passwords; without it the file is plain text with mode 0600 — the same exposure as
`.env` — and `protection` says `file-mode-0600` instead of implying otherwise. A key is scoped to
the provider it was typed for, so switching channels never forwards one gateway's credential to
another endpoint, and **恢复为 .env** deletes the saved keys along with the overrides.
- **Editing is refused in production by default** (`MODEL_EDIT_DISABLED`, 403), because pointing
`baseUrl` elsewhere redirects every database answer to another endpoint. Set
`DATA_AGENT_ALLOW_MODEL_EDIT=1` to allow it deliberately.

The new runtime is built and validated before anything is saved, so an unknown provider/model leaves
the previous working configuration in place. Overrides apply to sessions created afterwards; an open
session keeps the model handle it was created with. **测试模型** (`POST /v1/model/test`) sends one
16-token completion, because a saved protocol or base URL can be well-formed and still wrong — that
only shows up on a real request.

### Channels imported from the pi config

The console can list and switch between every channel pi itself knows, without copying any secret
into this service. It reads, and never writes, `~/.pi/agent/models.json`, `settings.json` and
`auth.json` (`DATA_AGENT_PI_HOME`, `DATA_AGENT_PI_MODELS_PATH`, `DATA_AGENT_PI_SETTINGS_PATH`,
`DATA_AGENT_MODEL_AUTH_PATH` override the locations):

Production disables external pi imports by default; `DATA_AGENT_PI_IMPORT=0` also disables them
explicitly in development. Project-owned channels always remain available. The model manager can
copy a custom pi channel into a new project-owned channel once, without writing to the source.

- `GET /v1/model/channels` returns the channels, their models, why each one is ready
  (`key_source`: `channel` from a `models.json` key, `pi-auth` from an `auth.json` credential, or
  `none`), and which models `settings.json`'s `enabledModels` lets through — that glob list filters
  the list, it is not a whitelist this service enforces.
- `POST /v1/model/select {provider, modelId}` switches to one of them. Only those two fields are
  persisted: base url, protocol, limits and any console key belong to the channel they were typed
  for. Endpoint metadata keeps coming from the pi config, so editing that file stays effective.
- A key saved from the console beats `.env` and the channel's own credential for the same provider,
  and is picked up again when you switch back to that channel.

Keys from the pi config are read into memory only; the generated `models.json` this service writes
for its own runtime is built with `apiKey`/`oauth` stripped (a `${VAR}` reference survives, since it
is not a secret). An `.env` key is never forwarded to another provider's endpoint: switching
channels drops it, and the channel's own credential is used instead.

The console lists tools from `/v1/tools`: name, label, description, parameter names/types/optionality,
and whether a tool is read-only or serialised on the session connection. With a live session selected,
it requests `?session_id=…` to show only that session’s model tools. The unscoped catalogue is the
complete service inventory, also reflected by `/v1/capabilities.tool_names`. Both blocks sit in collapsible
panels below the main view — one button per block, and the model block is split into the channel
list on the left and the editable form on the right.

## History and saved connections

History is persisted under the configured `DATA_AGENT_DATA_DIR` (default `data/`):

- `history/sessions/*.json`: caller ownership, connection identity digest and session snapshots.
- `history/tasks/*.json`: task states, answers, errors and result handles.
- `history/events/*.ndjson`: task event streams; SSE keeps the most recent 5,000 events in memory.
- `conversations/{session_id}/*.jsonl`: pi conversation context for explicit reconnection.
- `artifacts/objects/{artifact_id}.json`: immutable chart artifacts; `artifacts/index/*.json` is the
  per-session index (rebuildable from the objects).
- `audit/exports.ndjson`: one line per CSV export (artifact or result), with caller, session and whether
  the result was truncated.
- `connections.json`: server-side profiles (fully encrypted for account-owned profiles).
- `accounts.db`: account IDs, scrypt password hashes, and hashed login session tokens (account mode).

Closing/expiring a session releases its connection and preserves its history/results. Restart marks
previously queued/running tasks `incomplete` with `SERVICE_RESTARTED`, retains partial answers and
repairs missing terminal events. Historical APIs enforce the same caller ownership as live APIs.

**Session titles.** `POST /v1/sessions/{id}/title` asks the model for a short name based on the
conversation and stores it in the session snapshot (`title`). A live session uses its own handle; a
saved session uses the active model over its persisted goals and answers, so naming never reopens the
database connection. The prompt contains a bounded transcript (user turns and reply openings, no tool
calls/results), so title cost does not grow with session length. The console exposes the same action
as **生成标题** next to the chat heading and shows the title in the history selector.
Existing results from versions without a persisted ownership record cannot be recovered by guessing
their session ID. This is single-process filesystem storage with no automatic history retention;
back up the data directory and avoid sharing it between concurrent service instances.

In legacy mode, non-secret server profiles remain available after clearing browser storage
(re-enter the API token if required). To opt into storing database
passwords or SSH credentials, set a stable `DATA_AGENT_PROFILE_SECRET_KEY`, restart and select
**连同密码一起保存**. Secrets use AES-256-GCM; API responses never return decrypted values. Without
the key only non-secret configuration can be saved. Keep the key across restarts; changing it makes
old encrypted secrets unreadable. Unchecking the option and saving removes stored credentials.

For SSH private-key authentication, open **高级连接设置 → SSH 跳板机**, choose **私钥**, and
use **选择密钥文件…** (or paste its contents). OpenSSH and PEM private keys are supported, including
extensionless `id_ed25519` / `id_rsa` files; `.pub` public keys and PuTTY `.ppk` files are not.
Encrypted keys also need their passphrase. The browser reads the selected file locally; it does not
scan `~/.ssh`, store the key in browser storage, or send it merely because a file was selected.
Testing/connecting sends the key to the service. Account mode encrypts it on save; legacy mode
requires the explicit credential opt-in described above.

The SSH **host key** is separate from that private key: the private key proves who you are, the host
key proves which server you reached. Like `ssh` and `ssh-keyscan`, the console does not ask you to
type a fingerprint in advance. Leave **主机密钥指纹** empty and click **测试连接** (or **获取指纹**):
the service performs the SSH handshake without sending any credential, shows the fingerprint it read,
and pins it only after you confirm — then stores it in the selected profile. Later connections verify
the pinned key automatically; if the server ever presents a different one the connection is refused
with `SSH_HOST_KEY_MISMATCH` (409) and both fingerprints, instead of silently accepting it.
After a rebuild or host replacement, click **获取指纹** on that profile: it re-reads the key the
server presents now, shows `已保存` next to the new one, and replaces the pin only when you confirm.
An unchanged key is reported as `指纹未变` without asking again, so the button is safe to press.

Session creation, connection tests and reconnection also accept
`{ "profile": "saved-name", "credentials": { "password": "optional override", "ssh": [] } }`.
Credential overrides apply only to that request unless saving a profile. In legacy mode, browser
profiles are migrated only when explicitly saved; their local copy is removed after a successful save.

## Result storage

`data/results/{result_id}.ndjson` + `.meta.json`. The first N rows are duplicated into the metadata so
previews never touch disk. Parquet export is intentionally left as an interface, not an implementation.
Failed/cancelled query metadata remains available for diagnosis; reading its rows returns
`RESULT_FAILED` rather than presenting a partial/empty result as a successful query. A full export is
streamed in one forward pass (`iterateRows`), never paged from the start, so memory stays bounded and a
truncated result is labelled `-partial` with an `x-result-truncated` header.

## Testing

```bash
npm test                        # guard + driver/runtime/history/HTTP/SSE regressions; no external model calls
npm run check                   # tsc --noEmit
npm run build                   # dist/
npm run sync:vendor             # copy node_modules/echarts into web/vendor/
npm run smoke                   # boots src/ and exercises the HTTP endpoints
bash scripts/smoke-http.sh dist # same against the compiled build
npm run test:integration:local   # PGlite wire-protocol tests; uses a free port and cleans up child processes
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

The local PGlite runner skips PostgreSQL control-connection cancellation: PGlite multiplexes one
backend and cannot exercise concurrent cancellation. Run `npm run test:integration` with
`DATA_AGENT_TEST_PG` pointing to a real PostgreSQL instance to cover that case. MySQL conformance
runs when `DATA_AGENT_TEST_MYSQL` is configured. The local runner has startup and test deadlines;
it does not rewrite `tests/.env.test`.

`scripts/e2e.sh` is the end-to-end proof: PGlite as the analysed database, `.env.e2e` for the model,
a multi-step goal, then an assertion-friendly dump of the SSE tool trace, the task status and the
final answer (the task record exposes `answer`, so polling clients do not have to reassemble deltas).

The first-phase acceptance results and coverage boundaries are recorded in
[docs/phase1-acceptance.md](docs/phase1-acceptance.md).

## Layout

```
src/
  server.ts              bootstrap + graceful shutdown
  config.ts              env config, .env loader, secret redaction
  errors.ts              error codes → HTTP status
  api/http.ts            Express 5 routes, bearer auth, SSE
  agent/
    model.ts             pi ModelRuntime (models.json, in-memory API key)
    model-settings.ts    console-editable model overrides layered over the environment
    prompts.ts           per-engine system prompt
    tools.ts             core tool definitions, shared metadata, and profile/capability selection
    analysis-tools.ts    local analysis, snapshot and chart management definitions
    runtime.ts           pi AgentSession + task queue + event mapping
    session-title.ts     one-shot, tool-free session naming over a bounded transcript
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
  results/store.ts       NDJSON result storage + paging + streaming export
  artifacts/
    types.ts             artifact/spec/compiled-chart contracts and versions
    charts.ts            server-side compiler: spec + rows → ECharts option + summary + refs
    refs.ts              art_…#cell[field=value] refs: build, parse, resolve
    store.ts             immutable artifacts + per-session index + write lock
    service.ts           create/dedupe/ownership/limits, CSV export
    csv.ts               UTF-8 BOM, formula-injection escaping
  audit.ts               append-only export audit log
web/index.html           dependency-free console (forms, chat, SSE, result drawer, chart cards; saved connections)
web/vendor/               echarts.min.js (copied by `npm run sync:vendor`)
web/task-stream.js       SSE reconnection, cursor deduplication and terminal-state polling
tests/                   unit + integration
```

## Known limitations (P0)

- Single instance only: SQLite account store, in-memory sessions and one local data directory. No
  shared state, no horizontal scaling, no failover.
- Only login is rate limited. Task creation, `/v1/model/test` and connection tests have no per-account
  quota, so one authenticated account can consume model tokens or outbound connections until budgets
  or the global session ceiling stop it. `DATA_AGENT_MAX_SESSIONS` is global, not per account.
- Streaming events are appended one `appendFileSync` call per token. On a slow or network-backed data
  volume that write is the bottleneck; keep `/data` on local SSD and cap `MAX_SESSIONS`.
- `SIGTERM` cancels running tasks (recorded as `TASK_INTERRUPTED`) after at most the compose grace
  period; there is no drain-and-finish mode.
- Queries are synchronous; `job_get` reports task state, there is no detached job queue.
- One task runs per session at a time (queue depth 8); steering is supported, approval prompts are not.
- MySQL workspaces require a separate database; if it is unavailable the session degrades to
  read-only analysis with `workspace_access = none`.
- Doris/StarRocks support is declared (profiles, grants-based read-only proof, catalog/query paths)
  but not yet conformance-tested against live servers; dataset DDL is the least verified part.
- The chart layer does not aggregate, bucket time or fill missing points; that work belongs in SQL, so a
  spec that would need it fails with a fix hint instead of drawing a chart that disagrees with the query.
- Chart export is CSV (server) plus SVG/PNG (console, from the stored option). There is no server-side
  PNG renderer, no scheduled refresh and no dashboard composition yet.
- The console is a debugging surface, not a product UI. Server profiles and history use local
  filesystem storage; production operators must provide backups, retention and suitable access control.
