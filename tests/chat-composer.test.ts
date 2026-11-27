import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, Script } from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../web/chat-composer.js", import.meta.url), "utf8");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
const composer = createContext();
runInContext(source.replace(/export (?=(?:async )?function)/g, ""), composer);
const warning = (agent: unknown, target: unknown) => {
  composer.agent = agent; composer.target = target;
  return runInContext("contextSwitchWarning(agent, target)", composer);
};

test("context switch compares current occupancy, handles unknown usage and warns at 80%", () => {
  assert.equal(warning({ context_window: 128000, context_usage: { tokens: 10000 } }, { context_window: 256000 }), null);
  assert.equal(warning({ context_window: 128000, context_usage: { tokens: 9000 } }, { context_window: 128000 }), null);
  assert.match(warning({ context_window: 128000, context_usage: { tokens: 50080 } }, { context_window: 16000 }), /313\.0%[\s\S]*超过目标容量/);
  assert.match(warning({ context_window: 128000, context_usage: { tokens: 105000 } }, { context_window: 128000 }), /接近上限/);
  assert.match(warning({ context_window: 128000, context_usage: { tokens: null } }, { context_window: 16000 }), /暂不可准确估算/);
  assert.match(warning({ context_window: 128000, context_usage: { tokens: 2000 } }, { context_window: 64000 }), /后续可能更早触发历史压缩/);
  assert.equal(warning({ context_window: 128000, context_usage: null }, {}), null);
});

test("context meter shows Pi occupancy and treats post-compaction usage as unknown, not zero", () => {
  const progress = { hidden: false, value: 0, max: 0, setAttribute() {} };
  const label = { textContent: "" }, status = { textContent: "" };
  const root = { hidden: false, title: "", dataset: { nearLimit: "" }, querySelector: (selector: string) => ({
    progress, ".context-meter-value": label, ".context-meter-status": status,
  })[selector] };
  const render = (agent: unknown) => {
    composer.meter = root; composer.agent = agent;
    runInContext("renderContextMeter(meter, agent)", composer);
  };
  render(null);
  assert.equal(root.hidden, true);
  render({ context_window: 1_000_000, context_usage: { tokens: 148_000 } });
  assert.equal(root.hidden, false);
  assert.equal(label.textContent, "148K / 1M");
  assert.equal(progress.value, 148_000);
  assert.equal(progress.max, 1_000_000);
  render({ context_window: 64_000, context_compacting: true, context_usage: { tokens: 65_000 } });
  assert.equal(root.dataset.nearLimit, "true");
  assert.equal(progress.value, 64_000);
  assert.equal(status.textContent, "压缩中…");
  render({ context_usage: { tokens: null, contextWindow: 64_000 } });
  assert.equal(progress.hidden, true);
  assert.equal(label.textContent, "— / 64K");
  assert.equal(status.textContent, "");
  render({ context_usage: { tokens: 9_000, contextWindow: 64_000 } });
  assert.equal(progress.hidden, false);
  assert.equal(label.textContent, "9K / 64K");
  assert.equal(root.dataset.nearLimit, "false");
});

function markdownHarness() {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const context = createContext({ escapeHtml, document: { addEventListener() {} }, $: () => ({ addEventListener() {} }) });
  const inline = script.slice(script.indexOf("function renderInline("), script.indexOf('$("messages").addEventListener("click"'));
  const markdown = script.slice(script.indexOf("function renderMarkdown("), script.indexOf('$("btnSend").onclick'));
  runInContext(inline + markdown, context);
  return (text: string, streaming = false) => {
    context.input = text; context.streaming = streaming;
    return runInContext("renderMarkdown(input, { streaming })", context) as string;
  };
}

test("streaming markdown renders headings/tables/bold and incomplete SQL without unsafe HTML", () => {
  const render = markdownHarness();
  const partial = render('# 收入\n\n**总额**\n\n| 月 | 值 |\n| --- | --- |\n| 一 | 100 |\n\n```sql\nSELECT \'<script>\';', true);
  assert.match(partial, /<h3>收入<\/h3>/); assert.match(partial, /<strong>总额<\/strong>/);
  assert.match(partial, /<table>/); assert.match(partial, /code-block streaming/);
  assert.match(partial, /&lt;script&gt;/); assert.doesNotMatch(partial, /<script>/);
  assert.match(partial, /复制 SQL/);
  assert.match(render('```sql\nSELECT 1;\n```'), /SELECT 1;\n<\/code>/);
  assert.doesNotMatch(render('```sql\nSELECT 1;\n```', true), /code-block streaming/);
  assert.match(render('~~~c++\nstd::cout << 1;\n~~~'), /data-lang="c\+\+"/);
  assert.match(render('````text\na ``` b\n````'), /a ``` b/);
  assert.match(render('```sql\nSELECT 1;', false), /<pre><code>SELECT 1;<\/code>/);
});

test("stream rendering batches deltas, cancels stale frames and preserves scroll/fold state", () => {
  let pending: (() => void) | undefined, renders = 0, htmlValue = "", folded = 0;
  const node: any = { contains: () => false, classList: { add() {} },
    querySelectorAll: () => [{ classList: { contains: () => true }, querySelector: () => null }] };
  Object.defineProperty(node, "innerHTML", { set(value) { renders++; htmlValue = value; } });
  const state = { textNode: node, segmentText: "first" };
  const box = { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 };
  const context = createContext({ state, $: () => box, document: { addEventListener() {} },
    window: { getSelection: () => ({ isCollapsed: true }) },
    requestAnimationFrame: (fn: () => void) => { pending = fn; return 1; },
    cancelAnimationFrame: () => { pending = undefined; }, setTimeout, clearTimeout,
    renderMarkdown: (text: string) => text, setSqlOpen: () => { folded++; },
  });
  runInContext(script.slice(script.indexOf("function isNearBottom("), script.indexOf("/** Finalize the active text segment")), context);
  runInContext("scheduleStreamRender(); scheduleStreamRender();", context);
  assert.equal(renders, 0); state.segmentText += " second"; pending!();
  assert.equal(renders, 1); assert.equal(htmlValue, "first second"); assert.equal(folded, 1);
  assert.equal(box.scrollTop, 0, "reading old messages never forces bottom scrolling");
  box.scrollTop = 1500;
  runInContext("scheduleStreamRender()", context); pending!();
  assert.equal(box.scrollTop, 2000);
  runInContext("scheduleStreamRender(); cancelStreamRender();", context);
  assert.equal(pending, undefined, "switching session cannot draw an old frame into the new transcript");
});

test("composer parses and retains IME guards, draft-only editing, new-message submission and session-scoped catalogue", () => {
  new Script(source.replace(/export (?=(?:async )?function)/g, ""));
  assert.match(source, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(source, /goal\.value = text/);
  assert.doesNotMatch(source, /api\([^\n]*(?:\/steer|\/cancel)|method: "PATCH"/);
  assert.match(source, /\/v1\/sessions\/\$\{encodeURIComponent\(state.sessionId\)\}\/models/);
  assert.match(script, /addMessage\("user", \{ text: goal \}\)/);
  assert.match(script, /userBody\.closest\("\.msg"\)\.dataset\.taskId = data\.task\.id/);
  for (const id of ["goal", "btnSend", "btnCancel", "btnModelChip", "composerEditing", "modelConfirm"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  }
});
