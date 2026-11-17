import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function sourceBetween(start: string, end: string): string {
  const begin = script!.indexOf(start);
  const finish = script!.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return script!.slice(begin, finish);
}

test("the compact header contains connection status and no duplicate workspace heading", () => {
  const header = html.match(/<body>\s*(<header>[\s\S]*?<\/header>)/)?.[1];
  assert.ok(header);
  assert.match(header, /class="header-actions"[\s\S]*id="connBadge"[\s\S]*id="tabModel"[\s\S]*id="tabTools"[\s\S]*id="btnHealth"/);
  assert.doesNotMatch(html, /workspace-heading|数据分析工作台|连接数据，让每一个问题都有据可循/);
  assert.match(html, /<h2 class="chat-title-text" id="chatTitle"[^>]*>分析对话<\/h2>/);
  assert.equal((html.match(/id="chatTitle"/g) ?? []).length, 1);
});

test("connection status updates preserve the ellipsis wrapper and full hover text", () => {
  const badge = { dataset: {} as Record<string, string>, title: "" };
  const label = { textContent: "" };
  const context = createContext({ $: (id: string) => id === "connBadge" ? badge : label });
  runInContext(sourceBetween("function setConnectionBadge(", "function applySession("), context);
  runInContext('setConnectionBadge({ engine: "doris", database: "analytics", status: "ready" })', context);
  assert.equal(badge.dataset.ready, "true");
  assert.equal(label.textContent, "doris · analytics · 已连接");
  assert.equal(badge.title, label.textContent);

  runInContext('setConnectionBadge({ engine: "doris", database: "analytics", status: "disconnected" })', context);
  assert.equal(badge.dataset.ready, "false");
  assert.equal(label.textContent, "doris · analytics · 已断开");
  runInContext("setConnectionBadge(null)", context);
  assert.equal(label.textContent, "未连接");
  assert.equal(badge.title, "未连接");
});

function titleHarness() {
  const state = { sessionId: null as string | null, hasConversation: false, title: null, session: null };
  const elements: Record<string, any> = {
    chatTitle: { dataset: {}, textContent: "", title: "" },
    btnTitle: { dataset: {}, disabled: true, textContent: "", title: "" },
  };
  const statuses: any[] = [];
  const context = createContext({
    state, $: (id: string) => elements[id],
    clearTimeout() {}, setTimeout: () => 1,
    setStatus: (...args: any[]) => statuses.push(args),
    applySession() {}, loadHistory() {},
  });
  runInContext(sourceBetween("function setChatTitle(", '$("btnRefresh").onclick'), context);
  return { state, elements, statuses, context };
}

test("chat title is the single heading and naming is disabled until there is a conversation", () => {
  const { state, elements, context } = titleHarness();
  runInContext('setChatTitle(null); setTitleButtonSource("idle")', context);
  assert.equal(elements.chatTitle.textContent, "分析对话");
  assert.equal(elements.btnTitle.disabled, true);
  state.sessionId = "sess_ui";
  runInContext('setTitleButtonSource("idle")', context);
  assert.equal(elements.btnTitle.disabled, true);
  assert.match(elements.btnTitle.title, /请先发送消息/);
  state.hasConversation = true;
  runInContext('setChatTitle("月度趋势分析"); setTitleButtonSource("idle")', context);
  assert.equal(elements.btnTitle.disabled, false);
  assert.equal(elements.chatTitle.textContent, "月度趋势分析");
  assert.equal(elements.chatTitle.title, "月度趋势分析");
  runInContext('setTitleButtonSource("naming")', context);
  assert.equal(elements.btnTitle.disabled, true);
  assert.equal(elements.btnTitle.textContent, "正在生成…");
});

test("a failed title request for an old session does not change the new session's controls", async () => {
  const { state, elements, statuses, context } = titleHarness();
  state.sessionId = "sess_old";
  state.hasConversation = true;
  let reject!: (reason: Error) => void;
  context.api = () => new Promise((_, fail) => { reject = fail; });
  const pending = runInContext('$("btnTitle").onclick()', context);
  state.sessionId = "sess_new";
  state.hasConversation = false;
  runInContext('setChatTitle(null); setTitleButtonSource("idle")', context);
  reject(new Error("old request failed"));
  await pending;
  assert.equal(elements.btnTitle.dataset.state, "idle");
  assert.equal(elements.btnTitle.disabled, true);
  assert.equal(elements.chatTitle.textContent, "分析对话");
  assert.equal(statuses.length, 0);
});
