import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AnalysisService } from "../src/agent/service.js";
import { createHttpApp } from "../src/api/http.js";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
import { describeEngine, getProfile } from "../src/db/engines/profiles.js";
import { cleanup, testConfig, until } from "./support.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server?: Server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
const tool = (name: string, args: object, id: number) => ({ index: 0, id: `fixture-call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const text = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("");
const goal = "统计 2026 年 1 月的订单数";
const correctedSql = "SELECT COUNT(*) AS orders FROM orders WHERE paid_at >= DATE '2026-01-01' AND paid_at < DATE '2026-02-01' AND status = 'paid'";
const answer = "按支付时间统计，2026 年 1 月有 2 笔已支付订单。";

for (const engine of ["postgres", "mysql", "doris", "starrocks"] as const) it(`${engine}: discover schema and samples before asking; clear follow-ups skip confirmation`, async () => {
  const app = await testConfig(); app.budgets.taskTimeoutMs = 15_000;
  // All four capability profiles use the same local SQL fixture, not external database servers.
  const database = new PGlite();
  const original = DbSession.open;
  const providerCalls: any[] = [], sqlCalls: string[] = [], discovery: string[] = [];
  let used = 0;
  let service: AnalysisService | undefined, http: Server | undefined;
  const profile = getProfile(engine);
  const caps: SessionCapabilities = { engine, engineLabel: profile.label, engineProfile: describeEngine(profile),
    environment: "non_production", serverVersion: "fixture", readOnlyProof: engine === "doris" || engine === "starrocks" ? "grants" : "transaction", notes: [],
    sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: false, streaming: true } };
  const object = { schema: "public", name: "orders", kind: "table" };
  DbSession.open = async ({ results }) => ({
    id: "sess_grounded", capabilitiesView: caps, engineProfile: profile, scopesView: ["public"], touch() {},
    snapshot: () => ({ session_id: "sess_grounded", engine, database: "fixture", status: "ready", capabilities: caps, queries: { used, limit: 60 } }),
    close: async () => {}, cancel: async () => true, listResults: () => results.listBySession("sess_grounded"),
    observeOperations: (_: unknown, run: () => Promise<void>) => run(),
    catalogSearch: async () => { discovery.push("catalog_search"); return [object]; },
    describeMany: async () => {
      discovery.push("object_describe");
      return [{ ...object, description: { object, columns: [
        { name: "created_at", type: "date", nullable: false }, { name: "paid_at", type: "date", nullable: true },
        { name: "status", type: "text", nullable: false },
      ], primaryKey: [], indexes: [], foreignKeys: [] } }];
    },
    profile: async (_schema: string, _name: string, sampleRows: number) => {
      discovery.push("data_profile"); assert.equal(sampleRows, 5);
      return { object, sampled: true, sampleMethod: "head", sampleRows: 4,
        columns: [{ name: "status", type: "text", nulls: 0, distinct: 2, samples: ["paid", "cancelled"] }] };
    },
    query: async (sql: string, options: { taskId: string }) => {
      sqlCalls.push(sql); used++;
      const result = await database.query<{ orders: number }>(sql);
      const writer = await results.create({ sessionId: "sess_grounded", taskId: options.taskId, sql, previewRows: 1 });
      writer.setColumns([{ name: "orders", type: "bigint" }]);
      for (const row of result.rows) await writer.append([row.orders]);
      return writer.finish("none", 1);
    },
  }) as unknown as DbSession;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); providerCalls.push(body);
    const latest = text(body.messages.filter((message: any) => message.role === "user").at(-1));
    const last = body.messages.at(-1);
    const lastTool = body.messages.filter((message: any) => message.role === "assistant").at(-1)?.tool_calls?.at(-1)?.function.name;
    const send = (delta: object, reason: string | null) => res.write(`data: ${JSON.stringify({ id: "grounded-fixture", model: "local", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = (name: string, args: object) => {
      send({ role: "assistant", tool_calls: [tool(name, args, providerCalls.length)] }, null); send({}, "tool_calls");
    };
    if (last.role === "user") {
      if (latest === goal) {
        send({ role: "assistant", content: "先查看订单表结构和状态样例。" }, null);
        call("catalog_search", { search: "orders" });
      } else if (latest.startsWith("Continue the same analysis")) {
        const payload = JSON.parse(latest.split("\n\n").at(-1));
        // If a resume drops or changes the user's correction, produce a different real query result.
        call("query_execute", { sql: payload.clarifications[0].answer.includes("只统计已支付") ? correctedSql : "SELECT 999 AS orders" });
      } else if (latest === "再按刚才的支付口径统计一次") call("query_execute", { sql: correctedSql });
      else { send({ role: "assistant", content: "已收到。" }, null); send({}, "stop"); }
    } else if (lastTool === "catalog_search") call("object_describe", { objects: [{ name: "orders", schema: "public" }] });
    else if (lastTool === "object_describe") call("data_profile", { name: "orders", schema: "public", sample_rows: 5, sampling: "head" });
    else if (lastTool === "data_profile") call("ask_user", {
      question: "订单表同时有下单时间和支付时间。2026 年 1 月的订单数按哪个时间统计？",
      impact: "跨月支付的订单会归入不同月份；样例也包含已支付和已取消状态，可补充要纳入的状态。",
      options: [{ id: "created", label: "按下单时间" }, { id: "paid", label: "按支付时间" },
        { id: "unlisted", label: "其他事件类型或口径（请说明 event_type）" }],
    });
    else { send({ role: "assistant", content: answer }, null); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  try {
    await database.exec(`CREATE TABLE orders(created_at date, paid_at date, status text); INSERT INTO orders VALUES
      ('2025-12-31','2026-01-01','paid'), ('2026-01-06','2026-01-06','paid'),
      ('2026-01-04','2026-01-04','cancelled'), ('2026-01-08','2026-02-01','paid');`);
    app.model = { provider: "grounded-fixture", modelId: "local", api: "openai-completions", apiKey: "fixture", thinkingLevel: "off", baseUrl: `${await listen(provider)}/v1` };
    service = await AnalysisService.create(app);
    const connection = ConnectionConfig.parse({ engine, host: "fixture.test", port: engine === "postgres" ? 5432 : 3306, database: "fixture", user: "analyst", password: "test", environment: "non_production" });
    const session = await service.createSession(connection, "alice");
    const apiBase = await listen(http = createServer(await createHttpApp(service)));
    const task = session.submit(goal);
    await until(() => task.status === "waiting_for_user" || Boolean(task.finished_at), 15_000);
    assert.equal(task.status, "waiting_for_user", JSON.stringify(task.error));
    assert.equal(task.turns, 4);
    assert.deepEqual(discovery, ["catalog_search", "object_describe", "data_profile"]);
    assert.deepEqual(sqlCalls, [], "no dependent analysis before the user settles its scope");
    assert.equal(providerCalls.length, 4);
    assert.equal(task.answer, undefined, "interim narration is not an analysis answer");
    assert.ok(service.broker.list(task.id).some(event => event.type === "message_delta"));
    const prompt = providerCalls[0].messages.filter((message: any) => message.role === "system").map(text).join("\n");
    assert.match(prompt, /Do not require an initial confirmation/);
    assert.match(prompt, /proactively use ask_user/);
    assert.match(prompt, /bounded data_profile/);
    const question = task.clarifications![0]!;
    assert.equal(question.kind, "follow_up");
    assert.deepEqual(question.options?.map(option => option.id), ["created", "paid"]);
    assert.ok(text(providerCalls[3].messages.at(-1)).includes("cancelled"), "the question follows an observed sample");

    const rejected = await fetch(`${apiBase}/v1/tasks/${task.id}/answer`, { method: "POST", headers: {
      authorization: "Bearer test-token", "x-caller-id": "alice", "content-type": "application/json",
    }, body: JSON.stringify({ question_id: question.id, option_id: "unlisted" }) });
    assert.equal(rejected.status, 400, await rejected.text());
    assert.equal(task.status, "waiting_for_user");
    assert.equal(question.answer, undefined);

    const response = await fetch(`${apiBase}/v1/tasks/${task.id}/answer`, { method: "POST", headers: {
      authorization: "Bearer test-token", "x-caller-id": "alice", "content-type": "application/json",
    }, body: JSON.stringify({ question_id: question.id, text: "按支付时间，只统计已支付订单" }) });
    assert.equal(response.status, 202, await response.text());
    await until(() => Boolean(task.finished_at), 15_000);
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    assert.equal(task.clarifications?.length, 1);
    assert.equal(task.turns, 6);
    assert.equal(task.queries_used, 1);
    assert.equal(task.answer, answer);
    assert.deepEqual(sqlCalls, [correctedSql]);
    assert.equal(discovery.length, 3, "resume reuses schema and sample context");
    const result = await service.results.get(task.results[0]!);
    assert.deepEqual(result?.preview.map(row => row[0]), [2]);
    assert.ok(providerCalls[4].messages.some((message: any) => message.role === "tool" && text(message).includes("cancelled")));

    const direct = session.submit("再按刚才的支付口径统计一次", { maxTurns: 2 });
    await until(() => Boolean(direct.finished_at), 15_000);
    assert.equal(direct.status, "succeeded", JSON.stringify(direct.error));
    assert.equal(direct.clarifications, undefined);
    assert.equal(direct.turns, 2);
    assert.equal(direct.answer, answer);
    const prose = session.submit("收到，谢谢", { maxTurns: 1 });
    await until(() => Boolean(prose.finished_at), 15_000);
    assert.equal(prose.status, "succeeded");
    assert.equal(prose.answer, "已收到。");
    assert.equal(prose.clarifications, undefined, "no synthetic confirm-and-start fallback");
    assert.throws(() => session.submit("invalid budget", { maxTurns: 0 }), /positive integer/);
    for (const body of providerCalls) {
      const names = body.tools.map((entry: any) => entry.function.name);
      for (const name of ["ask_user", "catalog_search", "object_describe", "data_profile", "query_execute"]) assert.ok(names.includes(name), `${name} remains available`);
    }
  } finally {
    DbSession.open = original;
    await close(http);
    await service?.shutdown();
    await close(provider);
    await database.close();
    await cleanup(app);
  }
});
