import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
import { getProfile, describeEngine } from "../src/db/engines/profiles.js";
import { AnalysisService } from "../src/agent/service.js";
import { createHttpApp } from "../src/api/http.js";
import { DorisEngine } from "../src/db/engines/mysql.js";
import { TtlCache } from "../src/analysis/cache.js";
import { MetadataPool } from "../src/analysis/pool.js";
import { SOURCE_TOOLS } from "../src/agent/tools.js";
import { cleanup, testConfig, until } from "./support.js";

const connection = ConnectionConfig.parse({ engine: "postgres", host: "fixture.test", port: 5432, database: "fixture", user: "analyst", password: "never-persist-this-password" });
const textContent = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("");
const capabilities: SessionCapabilities = {
  engine: "postgres", engineLabel: "PostgreSQL", engineProfile: describeEngine(getProfile("postgres")),
  environment: "production", serverVersion: "fixture", readOnlyProof: "transaction", notes: [],
  sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: true, streaming: true },
};
function stubDatabase() {
  const original = DbSession.open;
  let nextId = 0;
  DbSession.open = async (options) => {
    let closed = false;
    const id = options.sessionId ?? `sess_sdk${++nextId}`;
    return { id, capabilitiesView: capabilities, engineProfile: getProfile("postgres"), scopesView: ["public"],
      catalogScopeNames: () => ["public", "sales"],
      describe: async (schema: string, name: string) => ({ object: { schema, name, kind: name === "orders" ? "table" : "view" } }),
      expiresAt: new Date(Date.now() + 60_000), touch() {},
      snapshot: () => ({ session_id: id, database: "fixture", status: closed ? "closed" : "ready", capabilities, queries: { used: 0, limit: 60 } }),
      close: async () => { closed = true; }, cancel: async () => true, listResults: async () => [],
      observeOperations: (_: unknown, run: () => Promise<void>) => run(),
    } as any;
  };
  return () => { DbSession.open = original; };
}

it("delivers the selected older answer and qualified table to the model and persists the reply on its own turn", async () => {
  const config = await testConfig();
  const restore = stubDatabase();
  const prompts: string[] = [];
  let service: AnalysisService | undefined;
  let http: ReturnType<typeof createServer> | undefined;
  const model = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const messages = JSON.parse(raw).messages;
    prompts.push(textContent(messages.filter((m: any) => m.role === "user").at(-1)));
    const answer = ["Orders in May were 120.", "The latest topic was regions.", "Details for May."][prompts.length - 1];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "quote", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: "quote", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  try {
    config.model = { provider: "reply-fixture", modelId: "test", api: "openai-completions", apiKey: "test", thinkingLevel: "off", baseUrl: `http://127.0.0.1:${await listen(model)}/v1` };
    service = await AnalysisService.create(config);
    const session = await service.createSession(connection, "alice");
    const other = await service.createSession(connection, "alice");
    const port = await listen(http = createServer(await createHttpApp(service)));
    const submit = (context: object, id = session.id) => fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/tasks`, {
      method: "POST", headers: { authorization: "Bearer test-token", "x-caller-id": "alice", "content-type": "application/json" },
      body: JSON.stringify({ goal: "Break that down", context }),
    });
    const first = session.submit("Count May orders");
    await until(() => !!first.finished_at);
    const second = session.submit("Show the regions");
    await until(() => !!second.finished_at);
    assert.equal(first.status, "succeeded", JSON.stringify(first.error));
    assert.equal(second.status, "succeeded", JSON.stringify(second.error));
    const context = { reply_to: first.id, target_scope: "sales", tables: [{ schema: "sales", name: "orders" }] };
    assert.equal((await submit(context, other.id)).status, 404);
    assert.equal((await submit({ ...context, target_scope: "private" })).status, 403);
    assert.equal((await submit({ ...context, tables: [{ schema: "private", name: "orders" }] })).status, 403);
    assert.equal((await submit({ ...context, tables: [{ schema: "sales", name: "order_view" }] })).status, 400);
    const created = await submit(context);
    assert.equal(created.status, 202);
    const { task } = await created.json();
    await until(() => !!session.getTask(task.id).finished_at);
    const saved = service.listTasksWithActivity(session.id, "alice").find(t => t.id === task.id)!;
    assert.deepEqual(saved.context, context);
    assert.equal(saved.goal, "Break that down");
    assert.equal(prompts.length, 3);
    assert.match(prompts[2]!, /Orders in May were 120/);
    assert.doesNotMatch(prompts[2]!, /latest topic was regions/);
    assert.ok(prompts[2]!.includes(`"task_id":"${first.id}"`));
    assert.ok(prompts[2]!.includes('"target_database_or_schema":"sales"'));
    assert.ok(prompts[2]!.includes('"mentioned_tables":[{"schema":"sales","name":"orders"}]'));
  } finally {
    restore();
    for (const server of [http, model]) if (server?.listening) {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await service?.shutdown(); await cleanup(config);
  }
});

for (const concurrent of [false, true]) it(`removes source declarations after a Doris stream failure (${concurrent ? "with in-flight and queued calls" : "single attempt"}); saved data still computes`, async () => {
  const app = await testConfig(); app.analysis = { preflight: "off" }; app.budgets.taskTimeoutMs = 15_000;
  const saved: { id?: string } = {};
  const original = DbSession.open;
  let service: AnalysisService | undefined;
  let dispatches = 0, closes = 0, metadataDispatches = 0;
  let startMetadata!: () => void, releaseMetadata!: () => void;
  const metadataStarted = new Promise<void>(resolve => { startMetadata = resolve; });
  const holdMetadata = new Promise<void>(resolve => { releaseMetadata = resolve; });
  const calls: any[] = [];
  const oldSql = "SELECT region, amount FROM fixture.orders";
  const data = ConnectionConfig.parse({ ...connection, engine: "doris", port: 9030 });
  DbSession.open = async ({ config, app, results }) => {
    const id = "sess_dorisreplay";
    const db = new (DbSession as any)(id, config, app, results) as DbSession;
    const engine = new DorisEngine(config);
    Object.assign(engine, { inReadOnly: true, connection: { query: () => { dispatches++; return undefined; }, destroy: () => { closes++; } } });
    if (concurrent) {
      const metadataPool = new MetadataPool(2, async () => {
        const lane = new DorisEngine(config);
        Object.assign(lane, { connection: { end: (cb: Function) => cb(), promise: () => ({ query: async ({ sql }: { sql: string }) => {
          metadataDispatches++;
          if (sql.includes("first_hold")) { startMetadata(); await holdMetadata; }
          else if (sql.includes("second_lost")) {
            await metadataStarted;
            // Simulate a socket close observed on the source while independent metadata lanes run.
            engine.unavailableReason = "Fixture source socket closed";
          }
          return [[], []];
        } }) } });
        return lane;
      });
      Object.assign(db, { metadataPool });
    }
    Object.assign(db, { engine, allowedScopes: ["fixture"], metadataCache: new TtlCache(300), capabilities: {
      ...capabilities, engine: "doris", engineLabel: "Doris", readOnlyProof: "grants", engineProfile: describeEngine(getProfile("doris")),
    } });
    const writer = await results.create({ sessionId: id, sql: oldSql, previewRows: 4 });
    writer.setColumns([{ name: "region", type: "text" }, { name: "amount", type: "integer" }]);
    for (const row of [["华南", 2], ["华南", 3], ["华北", 15]]) await writer.append(row);
    saved.id = (await writer.finish("none", 1)).id;
    return db;
  };
  const endpoint = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: any, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "replay", model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (index: number, name: string, args: object) => ({ index, id: `call_${calls.length}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (calls.length <= 2) {
      // Deliberately return stale tool calls after the schema has been removed.
      const tools = calls.length === 1 ? (concurrent ? [
        tool(0, "catalog_search", { search: "first_hold" }), tool(1, "catalog_search", { search: "second_lost" }), tool(2, "catalog_search", { search: "queued" }),
      ] : [tool(0, "query_execute", { sql: "SELECT 1" })]) : [
        tool(0, "query_execute", { sql: "SELECT 2" }), tool(1, "catalog_search", { search: "orders" }),
        tool(2, "business_lookup", { question: "支付订单" }), tool(3, "result_compute", { result_id: saved.id,
          operation: { group_by: ["region"], aggregates: [{ fn: "sum", field: "amount", as: "total" }], share: { field: "total", as: "share" }, sort: [{ field: "total", direction: "desc" }] } }),
      ];
      send({ role: "assistant", tool_calls: tools }, null); send({}, "tool_calls");
    } else { send({ role: "assistant", content: "Saved results are available; reconnect for new queries." }, null); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  try {
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    app.model = { provider: "replay", modelId: "local", api: "openai-completions", apiKey: "fixture", thinkingLevel: "off", baseUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1` };
    service = await AnalysisService.create(app);
    const session = await service.createSession(data, "fixture-owner");
    const task = session.submit("Use stored evidence after disconnect");
    if (concurrent) {
      await until(() => !!task.source_recovery, 10_000);
      releaseMetadata();
    }
    await until(() => !!task.finished_at, 18_000);
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    assert.equal(task.source_recovery?.code, "SESSION_UNAVAILABLE");
    assert.equal(dispatches, concurrent ? 0 : 1); assert.equal(closes, concurrent ? 0 : 1);
    assert.equal(task.source_requests?.source_select?.count, concurrent ? undefined : 1);
    assert.equal(metadataDispatches, concurrent ? 2 : 0);
    assert.equal(task.source_requests?.metadata?.count, concurrent ? 2 : undefined);
    assert.equal(task.operations?.local?.count, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].tools.some((t: any) => t.function.name === "query_execute"));
    for (const call of calls.slice(1)) assert.ok(call.tools.every((t: any) => !SOURCE_TOOLS.has(t.function.name)));
    assert.equal(task.results.length, concurrent ? 1 : 2); // Local result, plus failed source attempt when applicable.
    const result = await session.db.readResult(task.results.at(-1)!, 0, 5);
    assert.deepEqual(result.rows.map(([region, total, share]) => [region, Number(total), Number(share)]), [["华北", 15, .75], ["华南", 5, .25]]);
    assert.equal((await service.results.get(result.id))?.lineage?.parent_result_id, saved.id);
    const events = service.broker.list(task.id);
    const recovery = events.find(e => e.type === "notice" && e.data.code === "SESSION_UNAVAILABLE")!;
    assert.ok(recovery);
    assert.ok(events.filter(e => e.seq > recovery.seq && e.type === "source_request").every(e => e.data.phase !== "started"));
    if (concurrent) {
      const started = events.find(e => e.type === "source_request" && e.data.kind === "metadata" && e.data.phase === "started")!;
      const finished = events.find(e => e.type === "source_request" && e.data.id === started.data.id && e.data.phase === "finished")!;
      assert.ok(started.seq < recovery.seq && recovery.seq < finished.seq);
      assert.deepEqual(task.source_recovery?.in_flight_requests, [started.data.id]);
      assert.ok(task.source_recovery?.in_flight.includes("call_1_0"));
      assert.ok(task.source_recovery?.in_flight.includes("call_1_2"));
    } else assert.deepEqual(task.source_recovery?.in_flight_requests, []);
    const evidence = await service.resultEvidence(`${saved.id}#row=2&col=1`, "fixture-owner");
    assert.equal(evidence.value, 15); assert.equal(evidence.sql, oldSql);
    await assert.rejects(service.resultEvidence(`${saved.id}#row=2&col=1`, "different-owner"), { code: "NOT_FOUND" });
  } finally {
    startMetadata(); releaseMetadata();
    DbSession.open = original;
    endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await service?.shutdown(); await cleanup(app);
  }
});

it("serves scoped business documents and projects only the active revision into model requests", async () => {
  const config = await testConfig(); config.budgets.taskTimeoutMs = 10_000;
  const restore = stubDatabase();
  let service: AnalysisService | undefined;
  let appServer: ReturnType<typeof createServer> | undefined;
  let resumeModel: (() => void) | undefined;
  const requests: any[] = [];
  const endpoint = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (body.messages.some((m: any) => m.role === "user" && textContent(m) === "hold-first-run") && requests.length === 1) {
      await new Promise<void>((resolve) => { resumeModel = resolve; });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: any, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "fixture", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant", content: "OK" }, null); send({}, "stop"); res.end("data: [DONE]\n\n");
  });
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const close = async (server?: ReturnType<typeof createServer>) => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const modelPort = await listen(endpoint);
    config.model = { provider: "local-fixture", modelId: "fixture-model", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "fixture-key", thinkingLevel: "off" };
    service = await AnalysisService.create(config);
    const session = await service.createSession(connection, "alice");
    const bob = await service.createSession(connection, "bob");
    const other = await service.createSession({ ...connection, database: "other" }, "alice");
    const port = await listen(appServer = createServer(await createHttpApp(service)));
    const prefix = (id: string) => `/v1/sessions/${id}/business-context`;
    const route = prefix(session.id);
    const request = async (path: string, expected: number, method = "GET", body?: unknown, owner = "alice") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { authorization: "Bearer test-token", "x-caller-id": owner, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await res.text();
      assert.equal(res.status, expected, raw);
      return raw ? JSON.parse(raw) : null;
    };
    // The retired catalog has no routes, including on connections that can still use business context.
    for (const [method, suffix] of [["GET", "business-catalog"], ["GET", "business-catalog/old"],
      ["POST", "business-catalog"], ["POST", "business-catalog/old/publish"], ["PUT", "business-pilot"], ["POST", "business-analysis"]]) {
      const response = await request(`/v1/sessions/${session.id}/${suffix}`, 404, method);
      assert.equal(response.error.message, "Unknown endpoint");
    }
    await request("/business-catalog.js", 404);
    const oldText = "fixture_gmv_excludes_refunds_v1";
    const newText = "fixture_gmv_excludes_refunds_v2";
    const { file } = await request(route, 201, "POST", { name: "GMV 口径", content: `# GMV\n${oldText}` });
    const doc = `${route}/${file.id}`;
    assert.equal((await request(doc, 200)).file.content, `# GMV\n${oldText}`);
    const listing = await request(route, 200);
    assert.equal(listing.files[0].content, undefined);
    assert.deepEqual(listing.active, []);
    await request(route, 404, "GET", undefined, "bob");
    assert.deepEqual((await request(prefix(bob.id), 200, "GET", undefined, "bob")).files, []);
    await request(`${prefix(other.id)}/${file.id}`, 404);
    await request(`${route}/..%2Fdefaults`, 400);
    await request(route, 400, "POST", { name: "过长", content: "字".repeat(3_000) });
    // Uploaded .md files: new names are created, a repeated name replaces in place, one bad file is reported.
    const uploaded = await request(`${route}/import`, 200, "POST", {
      documents: [
        { name: "上传口径 A", content: "# A\nuploaded_markdown_a" },
        { name: "上传口径 B", content: "# B\nuploaded_markdown_b" },
        { name: "上传口径 A", content: "# A\nuploaded_markdown_a_v2" },
        { name: "空文档", content: "   " },
        { name: "超预算", content: "字".repeat(12_000) },
      ],
    });
    assert.deepEqual(uploaded.created.map((file: any) => file.name), ["上传口径 A", "上传口径 B"]);
    assert.deepEqual(uploaded.updated.map((file: any) => file.name), ["上传口径 A"]);
    assert.deepEqual(uploaded.failed.map((item: any) => item.name), ["空文档", "超预算"]);
    assert.ok(uploaded.created.every((file: any) => file.content === undefined));
    assert.equal(uploaded.updated[0].estimatedTokens > 0, true);
    const imported = (await request(`${route}/${uploaded.updated[0].id}`, 200)).file;
    assert.match(imported.content, /uploaded_markdown_a_v2/);
    assert.equal((await request(route, 200)).files.filter((file: any) => file.name === "上传口径 A").length, 1);
    await request(`${route}/import`, 400, "POST", { documents: [] });
    const bobImported = await request(`${prefix(bob.id)}/import`, 200, "POST", { documents: [{ name: "bob 的口径", content: "b" }] }, "bob");
    assert.deepEqual(bobImported.created.map((file: any) => file.name), ["bob 的口径"]);
    await request(`${route}/selection`, 404, "PUT", { ids: ["ctx_00000000000000000000"] });
    const heavy = [];
    for (let i = 0; i < 5; i++) heavy.push((await request(route, 201, "POST", { name: `大文档 ${i}`, content: "x".repeat(7_000) })).file.id);
    await request(`${route}/selection`, 400, "PUT", { ids: heavy });
    await request(`${route}/defaults`, 400, "PUT", { ids: heavy });
    assert.equal((await request(`${route}/selection`, 200, "PUT", { ids: [file.id, file.id] })).active.length, 1);
    assert.deepEqual((await request(`${route}/defaults`, 200, "PUT", { ids: [file.id] })).default_ids, [file.id]);
    const first = session.submit("hold-first-run");
    await until(() => !!resumeModel);
    await request(`${route}/selection`, 409, "PUT", { ids: [] });
    resumeModel!(); await until(() => !!first.finished_at);
    assert.equal(first.status, "succeeded", JSON.stringify(first.error));
    const latest = () => requests.at(-1).messages.map(textContent).join("\n");
    assert.equal(latest().split(oldText).length - 1, 1);
    const liveTools = (await request(`/v1/tools?session_id=${session.id}`, 200)).tools;
    const liveNames = liveTools.map((t: any) => t.name).sort();
    const catalogue = (await request("/v1/tools", 200)).tools;
    assert.equal(catalogue.length, 23);
    assert.ok(catalogue.every((tool: { name: string }) => !tool.name.startsWith("business_")));
    assert.deepEqual(liveNames, catalogue.map((t: any) => t.name).filter((name: string) => !name.startsWith("dataset_")).sort());
    assert.deepEqual(requests.at(-1).tools.map((t: any) => t.function.name).sort(), liveNames);
    for (const name of ["job_get", "job_cancel", "chart_list", "chart_archive", "chart_revise"]) {
      assert.ok(liveNames.includes(name), `ordinary sessions expose ${name}`);
    }
    await request(`/v1/tools?session_id=${session.id}`, 404, "GET", undefined, "bob");
    await request("/v1/tools?session_id=invalid", 400);
    assert.doesNotMatch(latest(), /dataset_create|result_summary|object_describe_batch|snapshot_query/);
    assert.match(latest(), /Use chart_revise or chart_archive only when the user asks/);
    assert.match(latest(), /Use job_cancel only when the user asks to cancel the running SQL/);

    const updated = (await request(doc, 200, "PUT", { name: file.name, content: newText })).file;
    assert.notEqual(file.revision, updated.revision);
    const next = await service.createSession(connection, "alice");
    assert.equal(next.businessContextSelection()[0]?.revision, updated.revision, "fresh sessions load the latest defaults");
    const run = async (s: typeof session, goal: string) => {
      const task = s.submit(goal); await until(() => !!task.finished_at);
      assert.equal(task.status, "succeeded", JSON.stringify(task.error));
      return latest();
    };
    const unchanged = await run(session, "still pinned to v1");
    assert.equal(unchanged.split(oldText).length - 1, 1);
    assert.ok(!unchanged.includes(newText));
    await request(`${route}/selection`, 200, "PUT", { ids: [file.id] });
    const changed = await run(session, "use v2 now");
    assert.ok(!changed.includes(oldText));
    assert.equal(changed.split(newText).length - 1, 1);
    const transcripts = join(config.dataDir, "conversations", session.id);
    for (const name of (await readdir(transcripts)).filter((p) => p.endsWith(".jsonl"))) {
      const raw = await readFile(join(transcripts, name), "utf8");
      assert.ok(!raw.includes(oldText) && !raw.includes(newText), "Pi does not accumulate document bodies in the transcript");
    }

    await request(doc, 204, "DELETE");
    const deleted = await request(route, 200);
    assert.ok(!deleted.files.some((f: any) => f.id === file.id));
    assert.deepEqual(deleted.default_ids, []);
    assert.equal(deleted.active[0]?.revision, updated.revision);
    await close(appServer); appServer = undefined;
    await service.shutdown(); service = await AnalysisService.create(config);
    const differentRoute = ConnectionConfig.parse({ ...connection, ssh: { hops: [{
      host: "other-bastion.test", username: "jump", auth: { method: "password", password: "fixture" },
    }] } });
    await assert.rejects(() => service!.createSession(differentRoute, "alice", session.id), /original database connection/);
    const resumed = await service.createSession({ ...connection, businessContextIds: [] }, "alice", session.id);
    assert.equal(resumed.businessContextSelection()[0]?.revision, updated.revision);
    const afterReconnect = await run(resumed, "resumed with pinned document");
    assert.equal(afterReconnect.split(newText).length - 1, 1);
    assert.ok(afterReconnect.includes("hold-first-run"));
    resumed.setBusinessContext([]);
    assert.ok(!(await run(resumed, "without documents")).includes(newText));
  } finally {
    resumeModel?.(); restore();
    await close(appServer); await service?.shutdown(); await close(endpoint); await cleanup(config);
  }
});

it("passes configured thinking levels into the actual SDK", async () => {
  const config = await testConfig();
  const restore = stubDatabase(); let service: AnalysisService | undefined;
  try {
    service = await AnalysisService.create(config);
    for (const level of ["off", "low", "high"] as const) {
      config.model.thinkingLevel = level;
      const session = await service.createSession(connection, "alice");
      assert.equal((session as any).agent.thinkingLevel, level);
      await service.closeSession(session.id, "alice");
    }
  } finally { restore(); await service?.shutdown(); await cleanup(config); }
});

it("keeps existing sessions on their original project channel handle after credential rotation", async () => {
  const config = await testConfig(); config.allowModelEdit = true; config.budgets.taskTimeoutMs = 5000;
  const restore = stubDatabase(); let service: AnalysisService | undefined;
  const requests: { key?: string; org?: string }[] = [];
  const endpoint = createServer(async (req, res) => {
    for await (const _ of req) { }
    requests.push({ key: req.headers.authorization, org: req.headers["x-org"] as string });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "rot", model: "alpha", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "rot", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  const provider = { name: "Owned", baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, api: "openai-completions", models: [{ id: "alpha" }] };
  try {
    service = await AnalysisService.create(config);
    const { ProviderWrite } = await import("../src/agent/provider-store.js");
    await service.saveProvider("owned", ProviderWrite.parse({ ...provider, apiKey: "first-key", headers: { "X-Org": "first-org" } }));
    await service.selectChannel("owned", "alpha");
    const old = await service.createSession(connection, "alice");
    await service.saveProvider("owned", ProviderWrite.parse({ ...provider, apiKey: "second-key", headers: { "X-Org": "second-org" } }));
    const next = await service.createSession(connection, "alice");
    for (const session of [old, next]) {
      const task = session.submit("say OK"); await until(() => !!task.finished_at);
      assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    }
    assert.deepEqual(requests, [{ key: "Bearer first-key", org: "first-org" }, { key: "Bearer second-key", org: "second-org" }]);
  } finally {
    restore(); await service?.shutdown(); endpoint.closeAllConnections();
    await new Promise<void>((r) => endpoint.close(() => r())); await cleanup(config);
  }
});

it("handles real SDK success/length/error, persists conversation and resumes it after service restart", async () => {
  const config = await testConfig(); config.budgets.taskTimeoutMs = 5_000;
  const restore = stubDatabase(); let service: AnalysisService | undefined;
  const requests: any[] = [];
  const endpoint = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const prompt = textContent(body.messages.filter((m: any) => m.role === "user").at(-1));
    if (prompt === "model-error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture rejected request", type: "invalid_request_error" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (delta: any, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    data({ role: "assistant", content: prompt === "truncated" ? "partial answer" : "fixture final answer" }, null);
    data({}, prompt === "truncated" ? "length" : "stop"); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  config.model = { provider: "local-fixture", modelId: "fixture-model", api: "openai-completions",
    baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, apiKey: "fixture-key", thinkingLevel: "off" };
  try {
    service = await AnalysisService.create(config);
    let session = await service.createSession(connection, "alice");
    const id = session.id;
    const first = session.submit("remember-this-context"); await until(() => !!first.finished_at);
    assert.equal(first.status, "succeeded", JSON.stringify(first.error));
    assert.equal(first.answer, "fixture final answer");
    await service.shutdown();
    const transcripts = join(config.dataDir, "conversations", id);
    const files = await readdir(transcripts); assert.equal(files.filter((p) => p.endsWith(".jsonl")).length, 1);
    const transcript = await readFile(join(transcripts, files.find((p) => p.endsWith(".jsonl"))!), "utf8");
    assert.ok(transcript.includes("remember-this-context")); assert.ok(!transcript.includes(connection.password));
    config.model.thinkingLevel = "high";
    service = await AnalysisService.create(config);
    assert.equal(service.findTask(first.id, "alice").task.status, "succeeded");
    session = await service.createSession(connection, "alice", id);
    assert.equal((session as any).agent.thinkingLevel, "high");
    const second = session.submit("continue-from-history"); await until(() => !!second.finished_at);
    assert.equal(second.status, "succeeded", JSON.stringify(second.error));
    assert.equal(requests.at(-1).reasoning_effort, "high");
    const toolNames = (request: any) => request.tools.map((t: any) => t.function.name).sort();
    assert.deepEqual(toolNames(requests.at(-1)), toolNames(requests[0]));
    assert.ok(toolNames(requests.at(-1)).includes("chart_revise"));
    assert.ok(requests.at(-1).messages.some((m: any) => m.role === "user" && textContent(m) === "remember-this-context"), JSON.stringify(requests.at(-1).messages));
    const truncated = session.submit("truncated"); await until(() => !!truncated.finished_at);
    assert.equal(truncated.status, "incomplete"); assert.equal(truncated.error?.code, "MODEL_OUTPUT_TRUNCATED");
    assert.equal(truncated.answer, "partial answer");
    const error = session.submit("model-error"); await until(() => !!error.finished_at);
    assert.equal(error.status, "failed"); assert.equal(error.error?.code, "MODEL_ERROR");
    assert.match(error.error.message, /fixture rejected request/);
  } finally {
    restore(); await service?.shutdown(); endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve())); await cleanup(config);
  }
});
