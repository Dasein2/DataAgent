import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AnalysisService } from "../src/agent/service.js";
import { HistoryStore } from "../src/agent/history.js";
import { EventBroker } from "../src/agent/events.js";
import type { TaskRecord } from "../src/agent/runtime.js";
import { createHttpApp } from "../src/api/http.js";
import { describeEngine, getProfile } from "../src/db/engines/profiles.js";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
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

const question = { question: "按支付时间还是下单时间统计？", impact: "时间字段会改变纳入统计的订单。", options: [
  { id: "paid", label: "按支付时间" }, { id: "created", label: "按下单时间" },
] };
const goal = "统计 2026 年 1 月的订单数";
const iterativeGoal = "分阶段确认订单统计口径";
const moreQuestions = ["未支付订单是否计入？", "取消订单是否计入？", "退款订单是否计入？", "测试订单是否计入？", "线下订单是否计入？", "员工订单是否计入？", "预售订单是否计入？", "赠品订单是否计入？"];
const paidSql = "SELECT COUNT(*) AS orders FROM orders WHERE paid_at >= '2026-01-01' AND paid_at < '2026-02-01'";
const createdSql = paidSql.replaceAll("paid_at", "created_at");
const tool = (index: number, name: string, args: object, turn: number) => ({ index, id: `call_${turn}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const content = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");

for (const engine of ["postgres", "mysql", "doris", "starrocks"] as const) {
  it(`clarifies and resumes ${engine} without a business catalog; one task and no SQL in the question batch`, async () => {
    const app = await testConfig();
    app.budgets.taskTimeoutMs = engine === "postgres" ? 2_000 : 8_000;
    if (engine === "postgres") app.sessionTtlMs = 4_000;
    const dialect = new PGlite();
    const original = DbSession.open;
    const submittedSql: string[] = [];
    const requests: any[] = [];
    let metadataCalls = 0, used = 0;
    let service: AnalysisService | undefined;
    let httpServer: Server | undefined;
    const profile = getProfile(engine);
    const caps: SessionCapabilities = { engine, engineLabel: profile.label, engineProfile: describeEngine(profile), environment: "non_production", serverVersion: "fixture",
      readOnlyProof: engine === "postgres" || engine === "mysql" ? "transaction" : "grants", notes: [], sourceAccess: "read_only", workspaceAccess: "none",
      features: { cancel: true, explain: true, explainAnalyze: false, streaming: true } };
    DbSession.open = async ({ results }) => ({
      id: `sess_${engine}`, capabilitiesView: caps, engineProfile: profile, scopesView: ["fixture"],
      touch() {}, snapshot: () => ({ session_id: `sess_${engine}`, engine, database: "fixture", status: "ready", capabilities: caps, queries: { used, limit: 60 } }),
      close: async () => {}, cancel: async () => true,
      listResults: () => results.listBySession(`sess_${engine}`),
      observeOperations: (_: unknown, run: () => Promise<void>) => run(),
      catalogSearch: async () => { metadataCalls++; return [{ schema: "fixture", name: "orders", kind: "table" }]; },
      query: async (sql: string, options: { taskId: string }) => {
        submittedSql.push(sql); used++;
        const data = await dialect.query<{ orders: number }>(sql);
        const writer = await results.create({ sessionId: `sess_${engine}`, taskId: options.taskId, sql, previewRows: 2 });
        writer.setColumns([{ name: "orders", type: "bigint" }]);
        for (const row of data.rows) await writer.append([row.orders]);
        return writer.finish("none", 1);
      },
    }) as unknown as DbSession;
    const endpoint = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const turn = requests.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "fixture", model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const lastUser = content(body.messages.findLast((m: any) => m.role === "user"));
      const last = body.messages.at(-1);
      const pending = lastUser.includes("等我确认");
      let tools;
      if (lastUser === iterativeGoal) {
        tools = [tool(0, "ask_user", question, turn)];
      } else if (lastUser.includes(iterativeGoal)) {
        const { clarifications } = JSON.parse(lastUser.split("\n\n").at(-1));
        if (clarifications.length === 1 && last.role === "user") {
          tools = [tool(0, "query_execute", { sql: paidSql }, turn)];
        } else if (last.role === "user" || clarifications.length === 1) {
          tools = [tool(0, "ask_user", { question: moreQuestions[clarifications.length - 1], impact: "这会改变统计范围。" }, turn)];
        }
      } else if (lastUser.startsWith("Continue the same analysis") && last.role === "user") {
        const clarification = JSON.parse(lastUser.split("\n\n").at(-1));
        if (pending && clarification.clarifications.length === 1) {
          tools = [tool(0, "ask_user", { question: "统计哪个月？", impact: "月份决定查询的日期范围。" }, turn)];
        } else if (!pending || clarification.clarifications[1].answer === "2026 年 1 月") {
          tools = [tool(0, "query_execute", { sql: clarification.clarifications[0].answer.includes("支付") ? paidSql : createdSql }, turn)];
        }
      } else if (pending && last.role === "user") {
        tools = [tool(0, "ask_user", question, turn)];
      } else if (lastUser === goal && last.role === "user") tools = [tool(0, "catalog_search", { search: "orders" }, turn)];
      else if (lastUser === goal) {
        // Put the query first to test the full-batch guard, not just blocking after ask_user executes.
        tools = [tool(0, "query_execute", { sql: createdSql }, turn), tool(1, "ask_user", question, turn), tool(2, "catalog_search", { search: "skip" }, turn)];
      } else if (lastUser === "明确按下单时间统计一月订单" && last.role === "user") tools = [tool(0, "query_execute", { sql: createdSql }, turn)];
      if (tools) {
        send({ role: "assistant", tool_calls: tools }, null); send({}, "tool_calls");
      } else {
        const tally = submittedSql.at(-1) === paidSql ? 2 : 3;
        const answer = lastUser.includes(iterativeGoal) || lastUser === "等我确认，但只剩一轮"
          ? "仍有口径待确认，暂无法给出正式数字。"
          : `按${tally === 2 ? "支付" : "下单"}时间统计，共 ${tally} 笔订单。`;
        send({ role: "assistant", content: answer }, null); send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    try {
      await dialect.exec(`CREATE TABLE orders(created_at date, paid_at date); INSERT INTO orders VALUES
        ('2025-12-31','2026-01-01'), ('2026-01-01','2026-01-02'), ('2026-01-02','2026-02-01'), ('2026-01-03',NULL);`);
      app.model = { provider: "clarification-replay", api: "openai-completions", modelId: "local", apiKey: "fixture", thinkingLevel: "off", baseUrl: `${await listen(endpoint)}/v1` };
      service = await AnalysisService.create(app);
      const session = await service.createSession(ConnectionConfig.parse({ engine, host: "fixture.test", port: engine === "postgres" ? 5432 : 3306, database: "fixture", user: "analyst", password: "test" }), "alice");
      const base = await listen(httpServer = createServer(await createHttpApp(service)));
      const request = async (path: string, status: number, payload?: unknown, owner = "alice") => {
        const res = await fetch(base + path, { method: payload === undefined ? "GET" : "POST", headers: {
          authorization: "Bearer test-token", "x-caller-id": owner, "content-type": "application/json",
        }, body: payload === undefined ? undefined : JSON.stringify(payload) });
        const data = await res.json();
        assert.equal(res.status, status, JSON.stringify(data));
        return data;
      };
      const task = session.submit(goal, { maxTurns: 4 });
      const path = `/v1/tasks/${task.id}`;
      await until(() => task.status === "waiting_for_user" || !!task.finished_at, 9_000);
      assert.equal(task.status, "waiting_for_user", JSON.stringify(task.error));
      assert.equal(task.turns, 2);
      assert.equal(metadataCalls, 1);
      assert.deepEqual(submittedSql, []);
      assert.equal(requests.length, 2);
      assert.ok(requests[0].tools.some((entry: any) => entry.function.name === "ask_user"));
      assert.ok(!requests[0].tools.some((entry: any) => entry.function.name.startsWith("business_")));
      assert.equal(session.snapshot().current_task_id, task.id);
      const pending = (await request(path, 200)).task.clarifications[0];
      assert.equal(pending.question, question.question);
      if (engine === "postgres") {
        await request(path + "/answer", 404, { question_id: pending.id, option_id: "paid" }, "bob");
        await request(path + "/answer", 409, { question_id: "04ae1f9b-83b6-4ba6-8554-a3344fb85a3c", option_id: "paid" });
        await request(path + "/answer", 400, { question_id: pending.id, option_id: "unknown" });
        await request(path + "/steer", 409, { text: "not a clarification answer" });
        await request(`/v1/sessions/${session.id}/tasks`, 409, { goal: "must not interleave" });
        await sleep(app.budgets.taskTimeoutMs + 60);
        assert.equal(task.status, "waiting_for_user");
        assert.equal(requests.length, 2);
      }
      const answer = engine === "mysql" ? { text: "请按支付时间算" } : { option_id: "paid" };
      const accepted = await request(path + "/answer", 202, { question_id: pending.id, ...answer });
      assert.equal(accepted.task.id, task.id);
      await request(path + "/answer", 409, { question_id: pending.id, option_id: "created" });
      await until(() => !!task.finished_at, 10_000);
      assert.equal(task.status, "succeeded", JSON.stringify(task.error));
      assert.equal(task.turns, 4, "turn counts span both Pi runs");
      assert.equal(task.queries_used, 1);
      if (engine === "postgres") assert.ok(task.waiting_ms! > app.budgets.taskTimeoutMs);
      assert.deepEqual(submittedSql, [paidSql]);
      assert.match(task.answer!, /按支付时间.*2 笔/);
      const result = await service.results.get(task.results[0]!);
      assert.equal(result?.sql, paidSql);
      assert.equal(result?.taskId, task.id);
      assert.deepEqual(result?.preview.map(row => row.map(Number)), [[2]]);
      assert.match(content(requests[2].messages.findLast((m: any) => m.role === "user")), /支付时间/);
      assert.deepEqual(service.broker.list(task.id).map(e => e.type).filter(t => t.startsWith("question_") || t === "task_finished"), ["question_asked", "question_answered", "task_finished"]);
      assert.equal(service.history.getTask(task.id, "alice").clarifications?.[0]?.answer?.text, engine === "mysql" ? answer.text : "按支付时间");

      if (engine === "mysql") {
        const followUp = session.submit("等我确认时间字段和月份", { maxTurns: 4 });
        await until(() => followUp.status === "waiting_for_user");
        const followUpPath = `/v1/tasks/${followUp.id}/answer`;
        const first = followUp.clarifications![0]!;
        await request(followUpPath, 202, { question_id: first.id, option_id: "created" });
        await until(() => followUp.status === "waiting_for_user" && followUp.clarifications?.length === 2);
        const second = followUp.clarifications![1]!;
        assert.equal(second.options, undefined);
        assert.equal(followUp.turns, 2);
        await request(followUpPath, 409, { question_id: first.id, option_id: "paid" });
        await request(followUpPath, 202, { question_id: second.id, text: "2026 年 1 月" });
        await until(() => !!followUp.finished_at);
        assert.equal(followUp.status, "succeeded");
        assert.deepEqual(submittedSql, [paidSql, createdSql]);
        assert.match(followUp.answer!, /按下单时间.*3 笔/);

        const iterative = session.submit(iterativeGoal, { maxTurns: 15 });
        for (let index = 0; index < 8; index++) {
          await until(() => !!iterative.finished_at || (iterative.status === "waiting_for_user" && iterative.clarifications?.length === index + 1));
          assert.equal(iterative.status, "waiting_for_user", JSON.stringify(iterative.error));
          assert.equal(iterative.queries_used, index === 0 ? 0 : 1);
          const pending = iterative.clarifications![index]!;
          assert.equal(pending.question, index === 0 ? question.question : moreQuestions[index - 1]);
          await request(`/v1/tasks/${iterative.id}/answer`, 202, {
            question_id: pending.id, ...(index === 0 ? { option_id: "paid" } : { text: "不计入" }),
          });
        }
        await until(() => !!iterative.finished_at);
        assert.equal(iterative.clarifications?.length, 8);
        assert.match(iterative.answer!, /无法给出正式数字/);
        assert.ok(service.broker.list(iterative.id).some(event => event.type === "tool_finished" &&
          event.data.tool === "ask_user" && event.data.error_code === "TASK_BUDGET_EXCEEDED"));

        const noRoom = session.submit("等我确认，但只剩一轮", { maxTurns: 2 });
        await until(() => !!noRoom.finished_at);
        assert.equal(noRoom.clarifications, undefined);
        assert.match(noRoom.answer!, /无法给出正式数字/);
      }

      if (engine === "postgres") {
        const direct = session.submit("明确按下单时间统计一月订单");
        await until(() => !!direct.finished_at);
        assert.equal(direct.status, "succeeded");
        assert.equal(direct.clarifications, undefined);
        assert.deepEqual(submittedSql, [paidSql, createdSql]);
        const cancelled = session.submit("等我确认");
        await until(() => cancelled.status === "waiting_for_user");
        await request(`/v1/tasks/${cancelled.id}/cancel`, 200, {});
        assert.equal(cancelled.status, "cancelled");
        await request(`/v1/tasks/${cancelled.id}/answer`, 409, { question_id: cancelled.clarifications![0]!.id, option_id: "paid" });
        assert.equal(session.snapshot().current_task_id, null);

        const expired = session.submit("等我确认");
        await until(() => expired.status === "waiting_for_user" || !!expired.finished_at);
        assert.equal(expired.status, "waiting_for_user");
        const expiredQuestion = expired.clarifications![0]!;
        await until(() => !!expired.finished_at, 6_000);
        assert.equal(expired.status, "incomplete");
        assert.equal(expired.error?.code, "CLARIFICATION_EXPIRED");
        await request(`/v1/tasks/${expired.id}/answer`, 410, { question_id: expiredQuestion.id, option_id: "paid" });
      }
    } finally {
      await close(httpServer);
      await service?.shutdown();
      await close(endpoint);
      DbSession.open = original;
      await dialect.close();
      await cleanup(app);
    }
  });
}

it("does not silently resume a pending analysis after a service restart", async () => {
  const app = await testConfig();
  try {
    const dir = join(app.dataDir, "history");
    const history = new HistoryStore(dir);
    const now = new Date().toISOString();
    const task: TaskRecord = { id: "task_restarted", session_id: "sess_restarted", goal, status: "waiting_for_user", created_at: now,
      turns: 1, queries_used: 0, execution_ms: 75, results: [], clarifications: [{ ...question, id: "04ae1f9b-83b6-4ba6-8554-a3344fb85a3c", asked_at: now, expires_at: new Date(Date.now() + 60_000).toISOString() }] };
    history.saveTask("alice", task);
    new EventBroker(100, history).publish(task.id, "question_asked", { ...task.clarifications![0] });
    const reopened = new HistoryStore(dir);
    const saved = reopened.getTask(task.id, "alice");
    assert.equal(saved.status, "incomplete");
    assert.equal(saved.error?.code, "SERVICE_RESTARTED");
    assert.deepEqual(saved.clarifications, task.clarifications);
    assert.deepEqual(reopened.listEvents(task.id).map(e => e.type), ["question_asked", "task_finished"]);
  } finally { await cleanup(app); }
});
