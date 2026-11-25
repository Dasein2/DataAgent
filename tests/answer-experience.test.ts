import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { splitAnswerEvidence } from "../web/answer-evidence.js";

class Element {
  className = ""; text = ""; innerHTML = ""; hidden = false; disabled = false; open = false;
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; children: Element[] = [];
  onclick?: () => Promise<void> | void;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.text = ""; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  querySelector(selector: string): Element | undefined { return this.children.find(child => "." + child.className === selector) || this.children.map(child => child.querySelector(selector)).find(Boolean); }
}
const doc = { createElement: (tag: string) => new Element(tag) };
async function progressHarness(task: any = { status: "submitting" }) {
  const source = await readFile(new URL("../web/task-progress.js", import.meta.url), "utf8");
  let now = 1_000, cancellations = 0;
  const context = createContext({ document: doc, formatActivityDuration: (ms: number) => Math.floor(ms / 1000) + "s", task,
    host: new Element("div"), now: () => now, onCancel: async () => { cancellations++; } });
  runInContext(source.replace(/^import .*;\n/m, "").replace(/export function/g, "function"), context);
  const card = runInContext("createTaskProgress(host, { task, now, onCancel })", context);
  return { card, advance(ms: number) { now += ms; card.tick(); }, cancellations: () => cancellations,
    event(type: string, data = {}, seq?: number) { card.observe({ type, data, seq, at: new Date(now).toISOString() }); } };
}

test("status card is immediate, uses real stages, freezes user wait and resumes cumulative execution time", async () => {
  const h = await progressHarness();
  assert.match(h.card.root.textContent, /正在提交/);
  h.card.bind({ id: "task_1", status: "queued" });
  h.event("task_started", { execution_ms: 0 }, 1); h.advance(2_000);
  h.event("tool_started", { call_id: "a", tool: "query_execute" }, 2);
  assert.match(h.card.root.textContent, /正在查询数据/); assert.doesNotMatch(h.card.root.textContent, /query_execute|%/);
  h.advance(16_000); assert.match(h.card.root.textContent, /查询仍在执行/);
  h.event("tool_finished", { call_id: "a" }, 3); assert.match(h.card.root.textContent, /正在核对/);
  h.event("question_asked", { execution_ms: 18_000 }, 4);
  assert.equal(h.card.root.dataset.state, "waiting");
  h.advance(90_000); assert.match(h.card.root.textContent, /18s.*已暂停计时/);
  h.event("question_answered", {}, 5); h.advance(4_000);
  h.event("task_started", { resumed: true, execution_ms: 18_000 }, 6); h.advance(3_000);
  assert.match(h.card.root.textContent, /21s/);
  h.event("task_finished", { status: "succeeded", execution_ms: 21_000 }, 7);
  h.advance(50_000); assert.match(h.card.root.textContent, /21s/);
  assert.equal(h.card.root.dataset.state, "succeeded");
  assert.equal(h.card.root.querySelector(".task-progress-title")?.attrs["aria-live"], "polite");
});

test("a rejected submission keeps its message and stops the clock across timer ticks", async () => {
  const h = await progressHarness();
  h.advance(1_000); h.card.failSubmission(); h.advance(30_000);
  assert.equal(h.card.root.dataset.state, "submission_failed");
  assert.match(h.card.root.textContent, /任务未提交成功.*1s.*原问题已保留/);
});

test("network recovery preserves waiting state, cancellation is explicit and terminal state wins", async () => {
  const h = await progressHarness({ status: "running" });
  h.event("question_asked", { execution_ms: 2_000 }, 1);
  h.card.connection("reconnecting"); assert.match(h.card.root.textContent, /连接中断不代表分析失败/);
  h.card.connection("connected"); assert.equal(h.card.root.dataset.state, "waiting");
  h.card.connection("unavailable"); assert.equal(h.card.root.dataset.state, "unavailable");
  assert.equal(h.card.root.children[0].children.at(-1).hidden, false);
  h.card.connection("connected");
  const cancel = h.card.root.children[0].children[3];
  await cancel.onclick(); await cancel.onclick(); assert.equal(h.cancellations(), 1);
  assert.equal(h.card.root.dataset.state, "cancelling");
  h.event("task_finished", { status: "cancelled", duration_ms: 2_000 }, 2);
  h.card.connection("reconnecting"); assert.equal(h.card.root.dataset.state, "cancelled");
});

test("replayed events are idempotent and polling repairs an unanswered question without counting wait", async () => {
  const h = await progressHarness({ status: "running", execution_ms: 100 });
  h.event("task_started", { execution_ms: 0 }, 1); h.advance(1_000);
  h.event("task_started", { execution_ms: 0 }, 1); // duplicate cannot reset time
  h.advance(1_000); assert.match(h.card.root.textContent, /2s/);
  h.card.snapshot({ status: "waiting_for_user", execution_ms: 2_000 }); h.advance(20_000);
  assert.match(h.card.root.textContent, /2s.*已暂停计时/);
  h.card.snapshot({ status: "running", execution_ms: 2_000 }); h.advance(1_000);
  assert.match(h.card.root.textContent, /3s/);
});

test("SQL moves to evidence without swallowing caveats or other fenced code", () => {
  const parts = splitAnswerEvidence("共 2 单。\n```SQL\nSELECT '<script>' AS value;\n```\n注意：缺少一天。\n~~~python\nprint(2)\n~~~");
  assert.match(parts.answer, /共 2 单[\s\S]*缺少一天[\s\S]*python/);
  assert.equal(parts.sql.length, 1); assert.match(parts.sql[0], /SELECT/);
  assert.doesNotMatch(parts.answer, /SELECT/);
  assert.equal(splitAnswerEvidence("````text\n```sql\nnot SQL\n```\n````").sql.length, 0);
  assert.equal(splitAnswerEvidence("```\nWITH x AS (SELECT 1) SELECT * FROM x;\n```").sql.length, 1);
  assert.equal(splitAnswerEvidence("```sql\nSELECT 1").sql.length, 1);
});

test("answer evidence is collapsed, source text is escaped by the renderer and result links deduplicate", async () => {
  const source = await readFile(new URL("../web/answer-evidence.js", import.meta.url), "utf8");
  const host = new Element("div"), answer = new Element("div"), opened: string[] = [];
  const context = createContext({ document: doc, host, answer, openResult: (id: string) => opened.push(id),
    renderMarkdown: (text: string) => text.replaceAll("<", "&lt;") });
  runInContext(source.replace(/export function/g, "function"), context);
  runInContext('renderAnswer(answer, "共 2 单。\\n```sql\\nSELECT \'<script>\';\\n```", { renderMarkdown, status: "incomplete" })', context);
  assert.match(answer.textContent, /未完成的分析/);
  const details = answer.querySelector(".answer-sql")!;
  assert.equal(details.open, false); assert.match(details.children[1]!.innerHTML, /&lt;script>/);
  runInContext('attachResultEvidence(host, ["res_a", "res_a", "res_b"], openResult); attachResultEvidence(host, ["res_a"], openResult)', context);
  assert.equal(host.children.length, 1); assert.equal(host.children[0]!.open, false);
  assert.match(host.textContent, /2 份结果/); host.children[0]!.children[2]!.onclick!();
  assert.deepEqual(opened, ["res_a"]);
});

test("analysis prompt requires proportional work, stop rules and keeps correctness checks", async () => {
  const source = await readFile(new URL("../src/agent/prompts.ts", import.meta.url), "utf8");
  for (const text of ["Stop using tools once", "JOIN cardinality", "Single value:", "Why-question:", "SQL and tool traces", "no quota of questions", "Do not paste SQL", "full report is appropriate only when requested"]) assert.ok(source.includes(text), text);
});
