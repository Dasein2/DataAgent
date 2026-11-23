import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { taskActivity } from "../src/agent/task-activity.js";
import type { TaskRecord } from "../src/agent/runtime.js";
import type { TaskEvent } from "../src/agent/events.js";

const task: TaskRecord = { id: "task_activity", session_id: "sess_activity", goal: "Analyze", status: "succeeded",
  created_at: "2026-11-23T00:00:00Z", started_at: "2026-11-23T00:01:00Z", finished_at: "2026-11-23T00:25:24Z",
  turns: 3, queries_used: 1, results: [], answer: "Final report" };
const ev = (type: string, data: unknown, seq = 1) => ({ type, data, seq, task_id: task.id, id: task.id + ":" + seq, at: task.started_at } as TaskEvent);

test("activity compacts deltas, counts tool calls/results/retries once, and excludes final answer and reasoning", () => {
  const events = [ev("task_started", {}), ev("message_delta", { text: "Let me " }), ev("reasoning_delta", { text: "hidden" }),
    ev("message_delta", { text: "inspect" }), ev("tool_started", { call_id: "a", tool: "query_execute" }),
    ev("tool_started", { call_id: "a", tool: "query_execute" }),
    ev("tool_finished", { call_id: "a", is_error: true, summary: "timeout" }),
    ev("tool_finished", { call_id: "a", is_error: true }), ev("retry", { attempt: 1, error: "connection" }),
    ev("message_delta", { text: "Final " }), ev("message_delta", { text: "report" }), ev("usage", {}), ev("task_finished", {})];
  const result = taskActivity(task, events);
  assert.deepEqual(result.summary, { messages: 3, tool_calls: 1, errors: 1, retries: 1, duration_ms: 1_464_000, available: true });
  assert.deepEqual(result.events.map((e) => e.type), ["message_delta", "tool_started", "tool_finished", "retry"]);
  assert.equal(result.events[0]?.data.text, "Let me inspect");
  assert.ok(!JSON.stringify(result).includes("hidden"));
  assert.equal(events[1]?.data.text, "Let me ", "compaction never mutates stored history");
});

test("same text before tools is not mistaken for the final report; missing history stays explicit", () => {
  const result = taskActivity(task, [ev("message_delta", { text: task.answer }), ev("tool_started", { call_id: "b" }), ev("tool_finished", { call_id: "b" })]);
  assert.equal(result.summary.messages, 2);
  assert.equal(result.events[0]?.data.text, task.answer);
  const empty = taskActivity({ ...task, started_at: undefined, finished_at: undefined }, []);
  assert.equal(empty.summary.available, false);
  assert.equal(empty.summary.duration_ms, undefined);
});

class Element {
  tag: string; className = ""; dataset: any = {}; children: Element[] = []; parent?: Element;
  hidden = false; open = false; text = ""; isConnected = true; listeners: Record<string, Function> = {};
  onclick?: Function;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
  appendChild(node: Element) { this.append(node); return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.parent = undefined; }
  classList = { add() {}, remove() {} };
  get childNodes() { return this.children; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(text: string) { this.text = text; this.children = []; }
  replaceChildren(...nodes: Element[]) { this.text = ""; this.children = []; this.append(...nodes); }
  addEventListener(name: string, callback: Function) { this.listeners[name] = callback; }
}
async function harness() {
  const source = await readFile(new URL("../web/task-activity.js", import.meta.url), "utf8");
  const context = createContext({ document: { createElement: (tag: string) => new Element(tag) } });
  runInContext(source.replace(/export function/g, "function"), context);
  const host = new Element("div"); context.host = host;
  return { context, host, create(options: any) { context.options = options; return runInContext("createTaskActivity(host, options)", context); } };
}

test("running disclosure groups one task, finishes collapsed and keeps error/retry counts", async () => {
  const { create } = await harness();
  const panel = create({ task: { id: task.id, started_at: task.started_at }, now: () => Date.parse(task.finished_at!) });
  assert.equal(panel.root.open, true);
  panel.body.append(new Element("div"));
  for (const e of [ev("message_delta", { text: "working" }), ev("message_delta", { text: "…" }),
    ev("tool_started", { call_id: "a" }), ev("tool_started", { call_id: "a" }),
    ev("tool_finished", { call_id: "a", is_error: true }), ev("retry", { attempt: 1 }),
    ev("message_delta", { text: "report" })]) panel.observe(e);
  panel.finish({ status: "succeeded", duration_ms: 1_464_000 }, { answerOutside: true });
  assert.equal(panel.root.open, false);
  assert.match(panel.root.textContent, /3 条消息 · 1 次工具调用 · 耗时 24m 24s/);
  assert.match(panel.root.textContent, /1 次工具错误 · 1 次重试/);
  panel.finish({ status: "succeeded" }, { answerOutside: true });
  assert.match(panel.root.textContent, /3 条消息/, "polling repair never subtracts twice");
});

test("historical process loads only on expand, reuses DOM, and allows retry after load failure", async () => {
  const { create } = await harness();
  let requests = 0, renders = 0;
  const panel = create({ task: { ...task, activity: { messages: 4, tool_calls: 3 } },
    load: async () => { requests++; if (requests === 1) throw Error("offline"); return { events: [ev("retry", {})], summary: { messages: 5, tool_calls: 3 } }; },
    onEvents: (_events: unknown[], host: Element) => { renders++; host.append(new Element("pre")); },
  });
  assert.equal(panel.root.open, false); assert.equal(requests, 0);
  panel.root.open = true;
  panel.root.listeners.toggle(); await new Promise((r) => setTimeout(r, 0));
  assert.match(panel.body.textContent, /加载失败/);
  panel.body.children[0]!.onclick!(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests, 2); assert.equal(renders, 1);
  panel.root.listeners.toggle(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests, 2);
  assert.match(panel.root.textContent, /5 条消息 · 3 次工具调用/);
});


for (const status of ["succeeded", "failed", "cancelled", "incomplete"]) {
  test("terminal " + status + " keeps final answer and task error outside one process fold", async () => {
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
    const answer = "Final report";
    const host = new Element("div"), processBody = new Element("div"), text = new Element("div");
    const fold = new Element("details"); fold.append(processBody); host.append(fold); processBody.append(text);
    let closed = false, copied = "";
    const elements: Record<string, any> = {};
    const state = { assistantEl: host, activity: { observe() {}, finish() { closed = true; } }, taskId: "task_live",
      trailingText: true, lastSegmentText: answer, lastTextNode: text, sessionReady: true };
    const context = createContext({ state, document: { createElement: (tag: string) => new Element(tag) },
      $: (id: string) => elements[id] ??= { textContent: "", dataset: {}, click() {} },
      workbench: { refreshContext: async () => {}, updateUsage() {} },
      composer: { setSource(_body: Element, source: string) { copied = source; }, update() {} },
      ensureAssistant() {}, closeSegment() {}, isNearBottom: () => false, renderMarkdown: (s: string) => s,
      statusNote: (s: string) => { const note = new Element("div"); note.textContent = s; return note; },
      renderArtifactInto() {},
    });
    runInContext(script.slice(script.indexOf("function handleEvent("), script.indexOf("/** Agent-level status")), context);
    context.event = { type: "task_finished", data: { status, answer, error: status === "succeeded" ? null : { code: "TASK_" + status.toUpperCase(), message: "fixture" } } };
    runInContext("handleEvent(event)", context);
    assert.equal(text.parent, host, "moves the final streamed node outside rather than duplicating it");
    assert.equal(processBody.childNodes.length, 0);
    assert.equal(host.childNodes.filter((n) => n.className === "text final").length, 1);
    assert.equal(closed, true); assert.equal(state.taskId, null); assert.equal(copied, answer);
    if (status !== "succeeded") assert.match(host.textContent, /TASK_/);
  });
}

test("duration formatting does not invent elapsed time; plain answers hide an empty process", async () => {
  const { context, create } = await harness();
  for (const [ms, text] of [[undefined, "—"], [0, "0s"], [60001, "1m 0s"], [3661000, "1h 1m 1s"]] as const) {
    context.ms = ms; assert.equal(runInContext("formatActivityDuration(ms)", context), text);
  }
  const panel = create({ task: { id: "task_plain" } });
  panel.observe(ev("message_delta", { text: "plain" }));
  panel.finish({ status: "succeeded" }, { answerOutside: true });
  assert.equal(panel.root.hidden, true);
});
