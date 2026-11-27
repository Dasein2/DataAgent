import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../web/workbench.css", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function sourceBetween(start: string, end: string): string {
  const begin = script!.indexOf(start);
  const finish = script!.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return script!.slice(begin, finish);
}

test("the compact header contains connection status and no duplicate workspace heading", () => {
  const header = html.match(/<header>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.match(header, /class="header-actions"[\s\S]*id="connBadge"[\s\S]*id="tabModel"[\s\S]*id="tabTools"[\s\S]*id="btnHealth"/);
  assert.doesNotMatch(html, /workspace-heading|数据分析工作台|连接数据，让每一个问题都有据可循/);
  assert.match(html, /<h2 class="chat-title-text" id="chatTitle"[^>]*>分析对话<\/h2>/);
  assert.equal((html.match(/id="chatTitle"/g) ?? []).length, 1);
});

test("the model configuration button stays label-only while session models remain in the composer", () => {
  const button = html.match(/<button[^>]*id="tabModel"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button);
  assert.match(button, /模型配置/);
  assert.doesNotMatch(button, /tab-tag|modelTabTag/);
  assert.doesNotMatch(script!, /modelTabTag/);
  assert.match(html, /id="modelChipName"/);
});

test("user messages align right with content-sized bubbles and bounded wrapping", () => {
  const user = css.match(/\.msg\.user\s*\{([^}]+)\}/)?.[1];
  const bubble = css.match(/^\.msg\.user \.body\s*\{([^}]+)\}/m)?.[1];
  assert.ok(user); assert.ok(bubble);
  assert.match(user, /align-self: flex-end/);
  assert.match(user, /align-items: flex-end/);
  assert.match(user, /width: fit-content/);
  assert.match(user, /max-width: min\(85%, 72ch\)/);
  assert.match(bubble, /width: fit-content/);
  assert.match(bubble, /max-width: 100%/);
  assert.match(bubble, /text-align: left/);
  assert.match(bubble, /overflow-wrap: anywhere/);
  assert.match(css, /\.msg\.user \.who\s*\{\s*text-align: right/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.msg\.user \{ max-width: 92%; \}/);
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

test("the tool pane follows the active session and ignores stale catalogue responses", async () => {
  const state = { sessionId: null as string | null, session: null as { status: string } | null, tools: [] };
  const elements: Record<string, { textContent?: string; innerHTML?: string }> = {};
  const pending: Array<{ path: string; resolve: (body: unknown) => void }> = [];
  const context = createContext({
    state, $: (id: string) => elements[id] ??= {}, escapeHtml: String, renderToolDetail() {},
    api: (path: string) => new Promise((resolve) => pending.push({ path, resolve })),
  });
  runInContext(sourceBetween("let toolRequestId =", "function renderToolDetail("), context);
  const catalogue = runInContext("loadTools()", context);
  state.sessionId = "sess_active";
  state.session = { status: "ready" };
  const session = runInContext("loadTools()", context);
  assert.deepEqual(pending.map(({ path }) => path), ["/v1/tools", "/v1/tools?session_id=sess_active"]);
  pending[1]!.resolve({ tools: [{ name: "result_read", readOnly: true }] });
  await session;
  pending[0]!.resolve({ tools: [{ name: "chart_archive" }, { name: "chart_revise" }] });
  await catalogue;
  assert.equal(elements.toolScope?.textContent, "当前会话工具");
  assert.equal(elements.toolCountSide?.textContent, "1");
  assert.match(elements.toolList!.innerHTML!, /result_read/);
  assert.doesNotMatch(elements.toolList!.innerHTML!, /chart_archive/);

  state.session = { status: "disconnected" };
  const history = runInContext("loadTools()", context);
  assert.equal(pending[2]?.path, "/v1/tools");
  assert.equal(elements.toolScope?.textContent, "服务工具目录");
  pending[2]!.resolve({ tools: [] });
  await history;
});

function historyHarness() {
  const state = { sessionId: null as string | null, sessions: [] as any[], taskId: null, hasConversation: false };
  const rendered: Array<{ who: string; options: any; innerHTML?: string; textContent?: string }> = [];
  const frames: Array<() => void> = [];
  let height = 0, scrollTop = 0;
  const messages = {
    get scrollHeight() { return height; }, clientHeight: 400,
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = Math.max(0, Math.min(value, height - 400)); },
  };
  const elements: Record<string, any> = { messages, taskPill: {}, btnCancel: {}, taskId: {} };
  const context = createContext({
    state, sessionViewVersion: 0, pendingSessionId: null,
    $: (id: string) => elements[id],
    clearTranscript() { height = 0; scrollTop = 0; rendered.length = 0; state.taskId = null; },
    document: { createElement: () => ({ className: "", innerHTML: "" }) },
    addMessage(who: string, options: any = {}) {
      const body = { who, options, innerHTML: "", replaceChildren() { this.innerHTML = ""; }, append(node: any) { this.innerHTML += node.innerHTML || ""; }, insertBefore(node: any) { this.innerHTML = (node.innerHTML || "") + this.innerHTML; } };
      rendered.push(body); height += 100; return body;
    },
    renderMarkdown: (text: string) => text,
    renderAnswer(node: any, source: string) { node.innerHTML = source; }, attachResultEvidence() {}, openResult() {},
    applySession() {}, renderAssets() {}, streamTask() {},
    renderArtifactInto() { return Promise.resolve(); },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  runInContext(sourceBetween("function showSession(", "async function openSession("), context);
  const show = (id: string) => {
    context.session = { session_id: id, status: "ready", current_task_id: null };
    context.tasks = Array.from({ length: 10 }, (_, i) => ({ id: "task_" + i, goal: "问题 " + i, answer: "回答 " + i }));
    // Legacy result metadata must never become extra assistant messages/buttons.
    context.results = [{ id: "res_old", label: "旧查询快捷入口" }];
    runInContext("showSession(session, tasks, results)", context);
  };
  return { state, rendered, frames, messages, show, grow: (amount: number) => { height += amount; } };
}

test("opening history shows only conversation turns and lands on the latest message after layout", () => {
  const h = historyHarness();
  h.show("sess_history");
  assert.equal(h.rendered.length, 20, "no extra assistant turn containing result shortcuts");
  assert.equal(h.rendered.at(-1)?.innerHTML, "回答 9");
  assert.equal(h.messages.scrollTop, h.messages.scrollHeight - h.messages.clientHeight);
  h.grow(200); h.frames.shift()!();
  assert.equal(h.messages.scrollTop, h.messages.scrollHeight - h.messages.clientHeight);
});

test("initial history scrolling does not override reading up or a newer session", () => {
  const h = historyHarness();
  h.show("sess_first");
  h.messages.scrollTop = 200;
  h.frames.shift()!();
  assert.equal(h.messages.scrollTop, 200);
  h.show("sess_old"); const staleFrame = h.frames.shift()!;
  h.show("sess_new"); h.messages.scrollTop = 300;
  staleFrame();
  assert.equal(h.messages.scrollTop, 300);
  h.frames.shift()!();
  assert.equal(h.messages.scrollTop, 300);
});

test("the asset menu creates an empty session with the saved profile without opening connection settings", async () => {
  const assets = await readFile(new URL("../web/assets.js", import.meta.url), "utf8");
  assert.match(assets, /label: "新建会话", run: \(\) => onCreateSession\(asset.profile\)/);
  assert.match(assets, /label: "连接设置", run: \(\) => onEdit\(asset.profile\)/);
  assert.match(script!, /onCreateSession: createSessionFromProfile/);
  const requests: Array<{ path: string; options: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const shown: unknown[][] = [], notices: unknown[][] = [];
  const state = { sessions: [] as Array<{ session_id: string; connection_profile_id: string }> };
  let historyLoads = 0, focused = 0;
  const context = createContext({
    state, sessionViewVersion: 0, pendingSessionId: null,
    profile: { name: "Doris", id: "profile-id", queryTimeoutMs: 180_000 },
    api: (path: string, options: unknown) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    $: (id: string) => { assert.equal(id, "goal", "the connection form is never opened or read"); return { focus() { focused++; } }; },
    setAnalysisStatus: (...args: unknown[]) => notices.push(args),
    showSession: (...args: unknown[]) => { shown.push(args); return ++context.sessionViewVersion; },
    loadHistory: () => { historyLoads++; },
  });
  runInContext(sourceBetween("let creatingProfileSession =", "function openConnectionEditor("), context);
  const click = () => runInContext("createSessionFromProfile(profile)", context);
  const first = click();
  await click();
  assert.equal(requests.length, 1, "ignore repeat clicks while connecting");
  assert.equal(requests[0]!.path, "/v1/sessions");
  assert.equal(JSON.stringify(requests[0]!.options), '{"method":"POST","body":{"profile":"Doris"}}');
  requests[0]!.resolve({ session: { session_id: "sess_created", status: "ready" } });
  await first;
  assert.equal(state.sessions[0]?.connection_profile_id, "profile-id");
  assert.equal(shown[0]?.[0], state.sessions[0]);
  assert.equal((shown[0]?.[1] as unknown[]).length, 0);
  assert.equal(focused, 1);
  assert.equal(historyLoads, 1);

  const failure = click();
  requests[1]!.reject(new Error("连接被拒绝"));
  await failure;
  assert.match(String(notices.at(-1)?.[0]), /新建会话失败.*连接设置/);
  assert.equal(notices.at(-1)?.[1], true);
  assert.equal(shown.length, 1, "failure does not clear or change the open session");

  const retry = click();
  context.sessionViewVersion++;
  requests[2]!.resolve({ session: { session_id: "sess_after_navigation", status: "ready" } });
  await retry;
  assert.equal(shown.length, 1, "a late result cannot switch away from a newer session");
  assert.equal(historyLoads, 2, "a late creation still refreshes the sidebar");
});

test("opening a session no longer fetches result shortcuts for the transcript", async () => {
  const paths: string[] = [], shown: unknown[][] = [];
  const context = createContext({
    sessionViewVersion: 0, pendingSessionId: null,
    state: { unreadSessions: new Set(), sessionId: null, sessionReady: false, taskId: null },
    $: () => ({}), setAnalysisStatus() {}, composer: { update() {} },
    api: async (path: string) => { paths.push(path); return path.endsWith("/tasks") ? { tasks: [] } : { session: { session_id: "sess_open" } }; },
    showSession: (...args: unknown[]) => shown.push(args),
  });
  runInContext(sourceBetween("async function openSession(", '$("btnReconnect").onclick'), context);
  await runInContext('openSession("sess_open")', context);
  assert.deepEqual(paths, ["/v1/sessions/sess_open", "/v1/sessions/sess_open/tasks"]);
  assert.equal(shown[0]?.length, 2);
});

test("late history charts follow the bottom without disturbing an older-message scroll position", async () => {
  const charts = await readFile(new URL("../web/charts.js", import.meta.url), "utf8");
  const source = charts.slice(charts.indexOf("  async function renderArtifactInto("), charts.indexOf("  function artifactTable("));
  for (const follow of [true, false]) {
    let height = 1000, scrollTop = follow ? 600 : 100;
    let resolve!: (value: unknown) => void;
    const messages = {
      get scrollHeight() { return height; }, clientHeight: 400,
      get scrollTop() { return scrollTop; }, set scrollTop(value: number) { scrollTop = value; },
    };
    const host = { isConnected: true, querySelector: () => null, appendChild() {}, closest: () => messages };
    const context = createContext({
      host, document: { createElement: () => ({ dataset: {}, replaceWith() { height += 300; } }) },
      api: () => new Promise((done) => { resolve = done; }), buildChartCard: () => ({}),
    });
    runInContext(source, context);
    const pending = runInContext('renderArtifactInto(host, "art_history")', context);
    resolve({ artifact: { id: "art_history" } }); await pending;
    assert.equal(scrollTop, follow ? 1300 : 100);
  }
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
