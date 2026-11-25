export function formatActivityDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m " + (seconds % 60) + "s";
}

/** One fold per question. All text is assigned through textContent, never interpolated as HTML. */
export function createTaskActivity(host, { task = {}, load, onEvents = () => {}, now = Date.now } = {}) {
  const root = document.createElement("details");
  root.className = "task-process";
  root.dataset.taskId = task.id || "";
  const head = document.createElement("summary");
  head.className = "task-process-head";
  const label = document.createElement("span");
  const status = document.createElement("span");
  status.className = "task-process-status";
  head.append(label, status);
  const body = document.createElement("div");
  body.className = "task-process-body";
  root.append(head, body);
  host.append(root);
  const terminal = new Set(["succeeded", "failed", "cancelled", "incomplete"]);
  let finished = terminal.has(task.status);
  let waiting = false, executionMs = 0, runningSince = 0;
  let counts = { messages: 0, tool_calls: 0, errors: 0, retries: 0, ...task.activity };
  let started = Date.parse(task.started_at || task.created_at || "") || now();
  let duration = counts.duration_ms;
  if (duration == null && task.finished_at) duration = Math.max(0, Date.parse(task.finished_at) - started);
  let textMessage = false, textOpen = false, loading = false, loaded = !load;
  const calls = new Set(), results = new Set();
  root.open = false;

  function draw() {
    const time = duration ?? (finished ? undefined : waiting ? executionMs : runningSince ? executionMs + Math.max(0, now() - runningSince) : now() - started);
    label.textContent = "执行过程 · " + counts.messages + " 条消息 · " + counts.tool_calls + " 次工具调用 · 耗时 " + formatActivityDuration(time);
    const hints = [];
    if (!finished) hints.push(waiting ? "等待回答" : "执行中");
    if (counts.errors) hints.push(counts.errors + " 次工具错误");
    if (counts.retries) hints.push(counts.retries + " 次重试");
    status.textContent = hints.join(" · ");
    root.dataset.status = finished ? task.status || "finished" : waiting ? "waiting_for_user" : "running";
  }
  draw();

  async function loadDetails() {
    if (!load || loaded || loading || !root.open) return;
    loading = true;
    body.textContent = "正在加载执行过程…";
    try {
      const result = await load();
      if (!root.isConnected) return;
      body.replaceChildren();
      onEvents(result.events || [], body);
      counts = { ...counts, ...result.summary };
      duration = counts.duration_ms ?? duration;
      if (!body.childNodes.length) body.textContent = "没有可展示的中间消息（历史可能已清理）。";
      loaded = true;
      draw();
    } catch {
      if (!root.isConnected) return;
      body.textContent = "执行过程加载失败。";
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "ghost"; retry.textContent = "重试加载";
      retry.onclick = () => void loadDetails();
      body.append(retry);
    } finally { loading = false; }
  }
  root.addEventListener("toggle", () => { if (root.open) void loadDetails(); });

  return {
    root, body,
    tick() { if (!finished) draw(); },
    observe(event) {
      if (finished) return;
      const data = event.data || {};
      if (event.type === "task_started" && event.at) {
        if (data.resumed) runningSince = Date.parse(event.at) || now();
        else started = Date.parse(event.at) || started;
      } else if (event.type === "question_asked") {
        waiting = true; executionMs = data.execution_ms ?? Math.max(0, now() - started);
      } else if (event.type === "question_answered") {
        waiting = false; runningSince = Date.parse(event.at) || now();
      }
      if (event.type === "message_delta" && String(data.text || "").trim()) {
        if (!textOpen) { counts.messages++; textMessage = textOpen = true; }
      } else if (["tool_started", "turn_started", "usage", "retry", "notice"].includes(event.type)) {
        textOpen = false;
        if (event.type === "tool_started" && !calls.has(data.call_id)) { calls.add(data.call_id); counts.tool_calls++; textMessage = false; }
        if (event.type === "tool_finished" && !results.has(data.call_id)) { results.add(data.call_id); counts.messages++; if (data.is_error) counts.errors++; }
        if (event.type === "retry" || event.type === "notice") { counts.messages++; if (event.type === "retry") counts.retries++; }
      } else if (event.type === "tool_finished" && !results.has(data.call_id)) {
        results.add(data.call_id); counts.messages++; if (data.is_error) counts.errors++;
      }
      draw();
    },
    finish(result, { answerOutside = false } = {}) {
      if (finished) return;
      if (answerOutside && textMessage) counts.messages = Math.max(0, counts.messages - 1);
      task = { ...task, ...result };
      const end = Date.parse(result.finished_at || "");
      duration = Number.isFinite(result.execution_ms) ? result.execution_ms : Number.isFinite(result.duration_ms) ? result.duration_ms : Number.isFinite(end) ? Math.max(0, end - started) : Math.max(0, now() - started);
      if (result.activity) counts = { ...counts, ...result.activity };
      finished = true;
      root.open = false;
      // Plain answers without tools or intermediate messages need no empty disclosure.
      root.hidden = !load && !body.childNodes.length;
      draw();
    },
  };
}
