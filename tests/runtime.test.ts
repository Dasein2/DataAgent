import assert from "node:assert/strict";
import { it } from "node:test";
import { AnalysisSession } from "../src/agent/runtime.js";
import { EventBroker } from "../src/agent/events.js";
import { cleanup, testConfig, until } from "./support.js";

async function fixture(run: (emit: (event: any) => void, goal: string, agent: any) => Promise<void> | void) {
  const app = await testConfig();
  const broker = new EventBroker();
  let session: AnalysisSession;
  const stats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  const agent = {
    prompt: async (goal: string) => run((event) => (session as any).mapEvent(event), goal, agent),
    abort: async () => {}, dispose: () => {}, getSessionStats: () => stats,
  };
  const db = { snapshot: () => ({ queries: { used: 0 }, status: "ready" }), listResults: async () => [],
    touch: () => {}, close: async () => {}, cancel: async () => true };
  session = new (AnalysisSession as any)("sess_test", "owner", db, agent, broker, app, {});
  return { session, broker, agent, app, close: async () => { await session.close(); await cleanup(app); } };
}

function message(emit: (event: any) => void, stopReason: string, text = "", errorMessage?: string) {
  emit({ type: "message_end", message: { role: "assistant", stopReason, errorMessage,
    content: text ? [{ type: "text", text }] : [] } });
}

for (const [reason, status, code] of [
  ["error", "failed", "MODEL_ERROR"], ["length", "incomplete", "MODEL_OUTPUT_TRUNCATED"],
  ["stop", "incomplete", "TASK_INCOMPLETE"], ["aborted", "incomplete", "TASK_INTERRUPTED"],
] as const) {
  it(`reports ${reason} with no complete answer as ${status}`, async () => {
    const f = await fixture((emit) => {
      emit({ type: "turn_start" }); message(emit, reason, reason === "length" ? "partial answer" : "", "provider unavailable");
      emit({ type: "agent_settled", aborted: reason === "aborted" });
    });
    try {
      const task = f.session.submit("analyse");
      await until(() => !!task.finished_at);
      assert.equal(task.status, status);
      assert.equal(task.error?.code, code);
      if (reason === "length") assert.equal(task.answer, "partial answer");
    } finally { await f.close(); }
  });
}

it("allows a recovered model/tool failure to finish successfully", async () => {
  const f = await fixture((emit) => {
    emit({ type: "turn_start" }); message(emit, "error", "", "temporary provider failure");
    emit({ type: "tool_execution_end", toolName: "query_execute", isError: true });
    emit({ type: "turn_start" }); message(emit, "stop", "Verified result: 12 rows");
    emit({ type: "agent_settled", aborted: false });
  });
  try {
    const task = f.session.submit("analyse");
    await until(() => !!task.finished_at);
    assert.equal(task.status, "succeeded");
    assert.equal(task.error, undefined);
  } finally { await f.close(); }
});

it("retains each queued task's own max_turns", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (emit, goal) => {
    if (goal === "first") await gate;
    emit({ type: "turn_start" }); message(emit, "stop", "done"); emit({ type: "agent_settled" });
  });
  try {
    const first = f.session.submit("first", { maxTurns: 10 });
    const second = f.session.submit("second", { maxTurns: 1 });
    release();
    await until(() => !!second.finished_at);
    assert.equal(f.broker.list(first.id).find((e) => e.type === "task_started")?.data.max_turns, 10);
    assert.equal(f.broker.list(second.id).find((e) => e.type === "task_started")?.data.max_turns, 1);
  } finally { release(); await f.close(); }
});

it("fails queued work before calling the model if cancellation invalidated the connection", async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (emit) => {
    calls++; emit({ type: "turn_start" }); await gate;
    message(emit, "stop", "partial result"); emit({ type: "agent_settled" });
  });
  try {
    f.session.submit("first"); const queued = f.session.submit("second");
    (f.session.db as any).snapshot = () => ({ status: "unavailable", unavailable_reason: "Doris connection killed", queries: { used: 0 } });
    release(); await until(() => !!queued.finished_at);
    assert.equal(calls, 1); assert.equal(queued.status, "failed"); assert.equal(queued.error?.code, "SESSION_UNAVAILABLE");
  } finally { release(); await f.close(); }
});

it("classifies turn exhaustion separately from user cancellation", async () => {
  const f = await fixture((emit) => {
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] } });
    emit({ type: "turn_end" });
    emit({ type: "agent_settled", aborted: true });
  });
  try {
    const task = f.session.submit("analyse", { maxTurns: 1 });
    await until(() => !!task.finished_at);
    assert.equal(task.status, "incomplete");
    assert.equal(task.error?.code, "TASK_BUDGET_EXCEEDED");
  } finally { await f.close(); }
});

it("does not use an earlier progress message as a final answer", async () => {
  const f = await fixture((emit) => {
    emit({ type: "turn_start" }); message(emit, "toolUse", "I will query the table");
    message(emit, "stop", ""); emit({ type: "agent_settled" });
  });
  try {
    const task = f.session.submit("analyse");
    await until(() => !!task.finished_at);
    assert.equal(task.status, "incomplete");
  } finally { await f.close(); }
});

it("enforces the turn limit on retry continuations without tool calls", async () => {
  const f = await fixture((emit) => {
    emit({ type: "turn_start" }); message(emit, "error", "", "retryable"); emit({ type: "turn_end" });
    emit({ type: "auto_retry_start", attempt: 1 }); emit({ type: "turn_start" });
    message(emit, "stop", "late answer"); emit({ type: "agent_settled", aborted: true });
  });
  try {
    const task = f.session.submit("analyse", { maxTurns: 1 });
    await until(() => !!task.finished_at);
    assert.equal(task.status, "incomplete"); assert.equal(task.error?.code, "TASK_BUDGET_EXCEEDED");
  } finally { await f.close(); }
});

for (const cancel of [false, true]) {
  it(cancel ? "marks explicit active cancellation cancelled" : "marks task timeout failed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(async (emit) => {
      emit({ type: "turn_start" }); await gate;
      message(emit, "aborted", "partial"); emit({ type: "agent_settled", aborted: true });
    });
    f.agent.abort = async () => release();
    try {
      if (!cancel) f.app.budgets.taskTimeoutMs = 10;
      const task = f.session.submit("analyse");
      if (cancel) assert.equal(await f.session.cancelTask(task.id), true);
      await until(() => !!task.finished_at);
      assert.equal(task.status, cancel ? "cancelled" : "failed");
      assert.equal(task.error?.code, cancel ? "TASK_CANCELLED" : "TASK_TIMEOUT");
      assert.equal(task.answer, "partial");
    } finally { release(); await f.close(); }
  });
}

it("cancels only the requested queued task and preserves the active task", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (emit) => { await gate; emit({ type: "turn_start" }); message(emit, "stop", "done"); emit({ type: "agent_settled" }); });
  try {
    const active = f.session.submit("active");
    const queued = f.session.submit("queued");
    assert.equal(await f.session.cancelTask(queued.id), true);
    assert.equal(queued.status, "cancelled");
    release(); await until(() => !!active.finished_at);
    assert.equal(active.status, "succeeded");
    assert.equal(await f.session.cancelTask(active.id), false);
  } finally { release(); await f.close(); }
});
