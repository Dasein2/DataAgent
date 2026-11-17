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

## HTTP API

All `/v1/*` routes require `Authorization: Bearer $DATA_AGENT_API_TOKEN` when a token is configured.
Callers can add `X-Caller-Id` to scope session ownership (defaults to a hash of the token).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | liveness + active model |
| GET | `/v1/capabilities` | engines, tool names, budgets, limits |
| GET | `/v1/engines` | declared engine profiles (port, protocol, dialect, capability flags) |
| GET | `/v1/model` | effective model settings, where each value comes from, credential readiness |
| PUT | `/v1/model` | override model settings (write-only `apiKey`); refused unless `DATA_AGENT_ALLOW_MODEL_EDIT` |
| DELETE | `/v1/model` | drop all console overrides and rebuild from the environment |
| POST | `/v1/model/test` | send one 16-token completion through the active handle and report latency/HTTP status |
| GET | `/v1/tools` | tools the agent is given: labels, descriptions, parameters, read-only flags |
| POST | `/v1/connections/test` | open a connection, report capabilities, close it |
| POST | `/v1/connections/host-key` | read an unconfirmed jump host's key (`{connection}` or `{profile, credentials}`); `pin` stores the confirmed one |
| GET | `/v1/connections/profiles` | caller's saved connections (credentials redacted) and secret-storage availability |
| PUT | `/v1/connections/profiles/{name}` | save/replace `{connection, rememberSecret}` |
| DELETE | `/v1/connections/profiles/{name}` | delete a saved connection |
| POST | `/v1/sessions` | create a pinned session (one DB connection + one SSH chain) |
| GET | `/v1/sessions` | list the caller's live and historical sessions |
| GET | `/v1/sessions/{id}` | session snapshot (capabilities, budgets, datasets, tasks) |
| DELETE | `/v1/sessions/{id}` | close session and its tunnel; `?purge=true` also deletes its history, results and artifacts |
| POST | `/v1/sessions/{id}/reconnect` | reconnect the original database/account and resume the saved conversation |
| POST | `/v1/sessions/{id}/title` | name the session from its own conversation (works for live and saved sessions) |
| GET | `/v1/sessions/{id}/tasks` | saved tasks, including final/partial answers and errors |
| GET | `/v1/sessions/{id}/results` | result metadata for the session |
| POST | `/v1/sessions/{id}/tasks` | submit an analysis goal (queued if the session is busy) |
| GET | `/v1/tasks/{id}` | task state: `queued/running/succeeded/failed/cancelled/incomplete` |
| GET | `/v1/tasks/{id}/events` | SSE stream (resumable with `Last-Event-ID`) |
| POST | `/v1/tasks/{id}/cancel` | cancel the running query and the task |
| POST | `/v1/tasks/{id}/steer` | inject a follow-up instruction into the running task |
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
`dataset_drop`, `chart_create`.

Models never write DDL and never see credentials. `dataset_create(name, select_sql, kind)` is the
only write path; the service generates `CREATE [SQL SECURITY INVOKER] VIEW` or `CREATE TABLE AS` in
the pre-provisioned workspace. Results are always handle-based: `query_execute` returns a preview and
a `result_id`; `result_read` pages the full NDJSON on disk.

## Charts and artifacts

`chart_create(result_id, type, …)` turns an executed result into an immutable artifact. It does not
run SQL and it cannot aggregate: the numbers must already be grouped by the query (`GROUP BY`), so the
snapshot and the SQL that produced it stay the same evidence. Types are `bar`, `line`, `heatmap` and
`table`; `series` splits a cartesian chart into grouped series, and a bar/line artifact also stores
the alternative figure type so the console can switch between them without another model call.

An artifact is a record, not a cache of the UI state:

- `spec`: what was asked for (fields, explicit axis order, formats). Versioned by `SPEC_VERSION`.
- `data`: the long-format snapshot (columns with roles `x`/`y`/`series`/`value`, rows, `row_key`).
- `compiled`: the ECharts option produced by the server compiler, plus `COMPILER_VERSION` and
  `ECHARTS_VERSION`, so a chart reopened later renders exactly as it did when it was created.
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

Downloads and figure-type switching are console actions on the stored artifact: CSV and
streamed result export requests are audited to `data/audit/exports.ndjson`, SVG comes from the ECharts
instance, and PNG is drawn off-screen with the canvas renderer from the currently selected stored
option. The audit records export requests, not proof that the client finished downloading. SVG/PNG
exports run locally in the browser and are not in the server CSV audit.

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
configuration to `/v1/sessions/{id}/reconnect`, or reference an explicitly saved profile. The engine,
host, port, database, user, environment and workspace must match the original session. Reconnection
restores conversation context and dataset registry; it opens a fresh database connection and resets
its query budget. Interrupted SQL and tasks are never replayed automatically.

Doris/StarRocks cancellation uses `KILL <connection id>`. Cancellation, query timeout and result
truncation can therefore make the session `unavailable`; subsequent database work is refused with
`SESSION_UNAVAILABLE`. Read saved results, then use **恢复分析** (or create a new session) to continue.
MySQL uses statement-only `KILL QUERY`.

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

The console also lists the agent's tools from `/v1/tools` (the same descriptors feed
`/v1/capabilities.tool_names`): name, label, description, parameter names/types/optionality, and
whether a tool is read-only or serialised on the session connection. Both blocks sit in collapsible
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
- `connections.json`: server-side connection profiles; passwords and SSH credentials are removed
  from public configuration fields.

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

The console saves profiles through the service API. Non-secret configuration remains available
after clearing browser storage (re-enter the API token if required). To opt into storing database
passwords or SSH credentials, set a stable `DATA_AGENT_PROFILE_SECRET_KEY`, restart and select
**连同密码一起保存**. Secrets use AES-256-GCM; API responses never return decrypted values. Without
the key only non-secret configuration can be saved. Keep the key across restarts; changing it makes
old encrypted secrets unreadable. Unchecking the option and saving removes stored credentials.

For SSH private-key authentication, open **高级连接设置 → SSH 跳板机**, choose **私钥**, and
use **选择密钥文件…** (or paste its contents). OpenSSH and PEM private keys are supported, including
extensionless `id_ed25519` / `id_rsa` files; `.pub` public keys and PuTTY `.ppk` files are not.
Encrypted keys also need their passphrase. The browser reads the selected file locally; it does not
scan `~/.ssh`, store the key in browser storage, or send it merely because a file was selected.
Testing/connecting sends the key to the service; saving uses the same explicit encrypted-credential
opt-in described above. Use HTTPS when accessing the console over a network.

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
Credential overrides apply only to that request. Legacy browser profiles remain selectable and are
migrated only when explicitly saved; their local copy is removed after a successful migration.

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
    tools.ts             13 tool definitions (TypeBox schemas, annotations)
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
