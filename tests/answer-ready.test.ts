import assert from "node:assert/strict";
import { it } from "node:test";
import { AnalysisSession } from "../src/agent/runtime.js";
import { EventBroker } from "../src/agent/events.js";
import { cleanup, testConfig, until } from "./support.js";

it("publishes only a completed model answer before evidence bookkeeping, not intermediate prose or previews", async () => {
  const app = await testConfig(); app.budgets.taskTimeoutMs = 5_000;
  const broker = new EventBroker();
  let session: AnalysisSession, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  const agent = { prompt: async () => {
    const emit = (event: any) => (session as any).mapEvent(event);
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "先查数据" }, { type: "toolCall" }] } });
    assert.equal(broker.list((session as any).current.id).filter(e => e.type === "answer_ready").length, 0);
    emit({ type: "tool_execution_end", toolName: "query_execute", toolCallId: "a", result: { content: [{ type: "text", text: "2" }] } });
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "2026 年 1 月共 2 笔订单。" }] } });
    emit({ type: "agent_settled" });
  }, abort() {}, getSessionStats: () => stats, setActiveToolsByName() {}, dispose() {} };
  const db = { snapshot: () => ({ status: "ready", queries: { used: 0 } }), touch() {}, close: async () => {},
    listResults: async () => { await gate; return []; }, observeOperations: (_: unknown, run: () => Promise<void>) => run() };
  session = new (AnalysisSession as any)("sess_ready", "owner", db, agent, [], broker, app, {}, { listBySession: async () => [] }, "fixture", { files: [], prompt: "" });
  try {
    const task = session.submit("统计订单数");
    await until(() => broker.list(task.id).some(event => event.type === "answer_ready"));
    assert.equal(task.status, "running", "result/artifact bookkeeping has not completed");
    assert.equal(task.finished_at, undefined);
    const ready = broker.list(task.id).filter(event => event.type === "answer_ready");
    assert.equal(ready.length, 1); assert.equal(ready[0]!.data.answer, "2026 年 1 月共 2 笔订单。");
    release(); await until(() => Boolean(task.finished_at));
    assert.equal(task.status, "succeeded");
    const types = broker.list(task.id).map(event => event.type);
    assert.ok(types.indexOf("answer_ready") < types.indexOf("task_finished"));
  } finally { release(); await session.close(); await cleanup(app); }
});
