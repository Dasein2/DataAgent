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
const tool = (name: string, args: object, index = 0) => ({ index, id: `fixture-call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const text = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("");

for (const engine of ["postgres", "mysql", "doris", "starrocks"] as const) it(`${engine}: every task confirms intent before database tools and applies corrections`, async () => {
  const app = await testConfig(); delete app.intentConfirmation; app.budgets.taskTimeoutMs = 10_000;
  const database = new PGlite();
  const original = DbSession.open;
  const providerCalls: any[] = [], sqlCalls: string[] = [];
  let used = 0, metadataCalls = 0;
  let behavior: "normal" | "prose" | "stale" | "invalid" | "mixed" | "hold" = "normal";
  let extraQuestion = false;
  let release: (() => void) | undefined;
  let service: AnalysisService | undefined, http: Server | undefined;
  const profile = getProfile(engine);
  const caps: SessionCapabilities = { engine, engineLabel: profile.label, engineProfile: describeEngine(profile),
    environment: "non_production", serverVersion: "fixture", readOnlyProof: engine === "doris" || engine === "starrocks" ? "grants" : "transaction", notes: [],
    sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: false, streaming: true } };
  DbSession.open = async ({ results }) => ({
    id: "sess_intent", capabilitiesView: caps, engineProfile: profile, scopesView: ["public"], touch() {},
    snapshot: () => ({ session_id: "sess_intent", engine: "postgres", database: "fixture", status: "ready", capabilities: caps, queries: { used, limit: 60 } }),
    close: async () => {}, cancel: async () => true, listResults: () => results.listBySession("sess_intent"),
    observeOperations: (_: unknown, run: () => Promise<void>) => run(),
    catalogSearch: async () => { metadataCalls++; return []; },
    query: async (sql: string, options: { taskId: string }) => {
      sqlCalls.push(sql); used++;
      const result = await database.query<{ orders: number }>(sql);
      const writer = await results.create({ sessionId: "sess_intent", taskId: options.taskId, sql, previewRows: 1 });
      writer.setColumns([{ name: "orders", type: "bigint" }]);
      for (const row of result.rows) await writer.append([row.orders]);
      return writer.finish("none", 1);
    },
  }) as unknown as DbSession;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); providerCalls.push(body);
    const users = body.messages.filter((message: any) => message.role === "user");
    const latest = text(users.at(-1));
    const send = (delta: object, reason: string | null) => res.write(`data: ${JSON.stringify({ id: "intent-fixture", model: "local", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const initial = body.tools.length === 1 && body.tools[0].function.name === "ask_user";
    if (initial) {
      if (behavior === "hold") await new Promise<void>(resolve => { release = resolve; });
      const question = { question: "我理解你要统计最近一周的订单数。这样理解对吗？", impact: "确认后我会开始读取表结构和计算。" };
      if (behavior === "prose") { send({ role: "assistant", content: "不经确认就给出订单数 999" }, null); send({}, "stop"); }
      else {
        const calls = behavior === "stale" ? [tool("query_execute", { sql: "SELECT 999" })]
          : behavior === "mixed" ? [tool("catalog_search", { search: "orders" }), tool("ask_user", question, 1), tool("query_execute", { sql: "SELECT 999" }, 2)]
          : [tool("ask_user", behavior === "invalid" ? { ...question, options: [{ id: "same", label: "重复一" }, { id: "same", label: "重复二" }] } : question)];
        send({ role: "assistant", tool_calls: calls }, null); send({}, "tool_calls");
      }
    } else if (latest.startsWith("Continue the same analysis") && body.messages.at(-1).role === "user") {
      const payload = JSON.parse(latest.split("\n\n").at(-1));
      if (extraQuestion && payload.clarifications.length === 1) {
        send({ role: "assistant", tool_calls: [tool("ask_user", { question: "排除退款订单吗？", impact: "影响纳入统计的订单", options: [{ id: "exclude", label: "排除退款订单" }] })] }, null);
      } else {
        if (behavior === "normal") assert.match(payload.clarifications[0].answer, /支付时间.*只统计已支付订单/);
        send({ role: "assistant", tool_calls: [tool("query_execute", { sql: "SELECT COUNT(*) AS orders FROM orders WHERE paid_at >= DATE '2026-01-01' AND paid_at < DATE '2026-01-08' AND status = 'paid'" })] }, null);
      }
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "按已确认的支付时间统计，最近一周有 2 笔已支付订单。" }, null); send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  try {
    await database.exec(`CREATE TABLE orders(paid_at date, status text); INSERT INTO orders VALUES
      ('2026-01-01','paid'), ('2026-01-06','paid'), ('2026-01-04','cancelled'), ('2026-01-08','paid');`);
    app.model = { provider: "intent-fixture", modelId: "local", api: "openai-completions", apiKey: "fixture", thinkingLevel: "off", baseUrl: `${await listen(provider)}/v1` };
    service = await AnalysisService.create(app);
    const connection = ConnectionConfig.parse({ engine, host: "fixture.test", port: engine === "postgres" ? 5432 : 3306, database: "fixture", user: "analyst", password: "test", environment: "non_production" });
    const session = await service.createSession(connection, "alice");
    const apiBase = await listen(http = createServer(await createHttpApp(service)));
    const task = session.submit("统计最近一周的订单数");
    await until(() => task.status === "waiting_for_user" || Boolean(task.finished_at), 10_000);
    assert.equal(task.status, "waiting_for_user", JSON.stringify(task.error));
    assert.equal(task.turns, 1);
    assert.equal(metadataCalls, 0, "no catalog discovery before confirmation");
    assert.deepEqual(sqlCalls, [], "no source SQL before confirmation");
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0].tools.map((entry: any) => entry.function.name), ["ask_user"]);
    assert.equal(session.snapshot().current_task_id, task.id);
    const pending = task.clarifications?.[0]!;
    assert.equal(pending.kind, "intent_confirmation");
    assert.equal(pending.options?.[0]?.id, "confirm");

    const response = await fetch(`${apiBase}/v1/tasks/${task.id}/answer`, { method: "POST", headers: {
      authorization: "Bearer test-token", "x-caller-id": "alice", "content-type": "application/json",
    }, body: JSON.stringify({ question_id: pending.id, text: "请按支付时间统计最近一周，只统计已支付订单" }) });
    assert.equal(response.status, 202, await response.text());
    await until(() => Boolean(task.finished_at), 10_000);
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    assert.ok(task.clarifications?.some(question => question.kind === "intent_confirmation" && question.answer));
    assert.equal(task.queries_used, 1);
    assert.equal(providerCalls.length, 3);
    assert.ok(providerCalls[1].tools.some((entry: any) => entry.function.name === "query_execute"), "full toolset is available only after confirmation");
    assert.deepEqual(sqlCalls, ["SELECT COUNT(*) AS orders FROM orders WHERE paid_at >= DATE '2026-01-01' AND paid_at < DATE '2026-01-08' AND status = 'paid'"]);
    assert.equal(task.answer, "按已确认的支付时间统计，最近一周有 2 笔已支付订单。");
    const result = await service.results.get(task.results[0]!);
    assert.deepEqual(result?.preview.map(row => row[0]), [2]);

    if (engine === "postgres") {
      for (const mode of ["mixed", "prose", "stale", "invalid"] as const) {
        behavior = mode;
        const before = providerCalls.length, queriesBefore = used;
        const next = session.submit(`测试${mode}新任务`);
        await until(() => next.status === "waiting_for_user" || Boolean(next.finished_at));
        assert.equal(next.status, "waiting_for_user", JSON.stringify(next.error));
        assert.equal(providerCalls.length, before + 1, "one bounded confirmation attempt, even if the model ignores the tool");
        assert.equal(used, queriesBefore);
        assert.equal(metadataCalls, 0);
        assert.equal(next.answer, undefined, "unconfirmed model output is never presented as an analysis answer");
        assert.ok(!service.broker.list(next.id).some(e => e.type === "message_delta"));
        assert.deepEqual(providerCalls.at(-1).tools.map((t: any) => t.function.name), ["ask_user"]);
        const confirmation = next.clarifications![0]!;
        assert.equal(confirmation.kind, "intent_confirmation");
        assert.equal(confirmation.options?.[0]?.id, "confirm");
        if (mode !== "mixed") assert.match(confirmation.impact, /未能生成需求复述/);
        if (mode === "mixed") {
          session.answerClarification(next.id, { question_id: confirmation.id, option_id: "confirm" });
          await until(() => Boolean(next.finished_at));
          assert.equal(next.status, "succeeded");
          assert.equal(used, queriesBefore + 1);
        } else await session.cancelTask(next.id);
      }
      behavior = "normal";
      extraQuestion = true;
      const follow = session.submit("另一个需求也先确认");
      await until(() => follow.status === "waiting_for_user");
      session.answerClarification(follow.id, { question_id: follow.clarifications![0]!.id, text: "请按支付时间统计，只统计已支付订单" });
      await until(() => follow.status === "waiting_for_user" && follow.clarifications?.length === 2);
      assert.equal(follow.clarifications?.[1]?.kind, "follow_up");
      session.answerClarification(follow.id, { question_id: follow.clarifications![1]!.id, option_id: "exclude" });
      await until(() => Boolean(follow.finished_at));
      assert.equal(follow.status, "succeeded");
      assert.equal(follow.turns, 4);
      assert.equal(follow.queries_used, 1);
      assert.throws(() => session.submit("轮次不足", { maxTurns: 2 }), /at least 3/);
      behavior = "hold";
      const cancelled = session.submit("先等我确认");
      await until(() => Boolean(release));
      const beforeCancel = used;
      assert.equal(await session.cancelTask(cancelled.id), true);
      await until(() => Boolean(cancelled.finished_at));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.clarifications, undefined);
      assert.equal(used, beforeCancel);
      release!();
    }
  } finally {
    release?.();
    DbSession.open = original;
    await close(http);
    await service?.shutdown();
    await close(provider);
    await database.close();
    await cleanup(app);
  }
});
