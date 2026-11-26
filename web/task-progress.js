import { formatActivityDuration } from "./task-activity.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "incomplete", "submission_failed"]);
const labels = { succeeded: "分析完成", failed: "分析失败", cancelled: "已取消", incomplete: "分析未完成", submission_failed: "任务未提交成功" };
const discovery = new Set(["session_info", "catalog_search", "catalog_overview", "object_describe", "data_profile"]);
const local = new Set(["result_read", "result_compute", "result_transform", "snapshot_list"]);
export function toolProgressLabel(tool) {
  if (discovery.has(tool)) return "正在了解相关数据";
  if (tool === "query_explain") return "正在检查查询成本";
  if (tool === "query_execute") return "正在查询数据";
  if (local.has(tool)) return "正在核对和计算结果";
  if (tool === "chart_create" || tool === "chart_revise") return "正在生成图表";
  if (tool === "ask_user") return "正在整理需要确认的问题";
  return "正在处理分析任务";
}

/** A truthful view of observed events, never a percentage or a claim that intermediate data is final. */
export function createTaskProgress(host, { task = {}, now = Date.now, onCancel = () => {}, onRetry = () => {} } = {}) {
  const make = (tag, cls) => { const node = document.createElement(tag); node.className = cls; return node; };
  const root = make("section", "task-progress");
  root.setAttribute("aria-label", "分析进度");
  const head = make("div", "task-progress-head");
  const dot = make("span", "task-progress-dot"); dot.setAttribute("aria-hidden", "true");
  const title = make("strong", "task-progress-title"); title.setAttribute("role", "status"); title.setAttribute("aria-live", "polite");
  const clock = make("span", "task-progress-time"); clock.setAttribute("aria-live", "off");
  const cancel = make("button", "ghost"); cancel.type = "button"; cancel.textContent = "取消分析";
  const retry = make("button", "ghost"); retry.type = "button"; retry.textContent = "恢复进度"; retry.onclick = onRetry;
  const note = make("p", "task-progress-note");
  head.append(dot, title, clock, cancel, retry); root.append(head, note); host.append(root);
  let status = task.status || "submitting", connection = "connected", cancelling = false, cancelError = "";
  let executionMs = task.execution_ms ?? 0;
  // Replaying events supplies accurate active-run anchors. A snapshot alone is a lower bound.
  let since = ["submitting", "running"].includes(status) ? now() : null;
  let stage = status === "submitting" ? "正在提交…" : status === "queued" ? "排队等待分析" : "正在分析";
  let activeSince = null;
  const active = new Map();
  const seen = new Set();
  function elapsed() { return executionMs + (since === null ? 0 : Math.max(0, now() - since)); }
  function draw() {
    const finished = terminal.has(status), waiting = status === "waiting_for_user";
    root.dataset.state = finished ? status : cancelling ? "cancelling" : connection !== "connected" ? connection : waiting ? "waiting" : "running";
    const label = finished ? labels[status] : cancelling ? "正在取消分析…" : connection === "unavailable" ? "进度连接不可用" : connection === "reconnecting" ? "进度连接中断，正在恢复" : waiting ? "等你选择" : stage;
    // Timer ticks should not re-announce an unchanged stage to assistive technology.
    if (title.textContent !== label) title.textContent = label;
    clock.textContent = "已用 " + formatActivityDuration(elapsed()) + (waiting ? " · 已暂停计时" : "");
    cancel.hidden = finished || status === "submitting";
    cancel.disabled = cancelling;
    retry.hidden = finished || connection !== "unavailable";
    note.textContent = finished ? status === "submission_failed" ? "原问题已保留，可重试发送。" : status === "succeeded" ? "答案与依据见下方。" : status === "cancelled" ? "任务已停止，已保存的依据仍可查看。" : "请查看下方说明及已取得的依据。"
      : cancelError || (
      connection !== "connected" ? "连接中断不代表分析失败；正在保留本次任务，恢复后继续显示进度。"
      : waiting ? "请选择下方选项，或输入补充与纠正；回答后继续同一任务。"
      : activeSince !== null && now() - activeSince >= 15_000 ? "查询仍在执行；耗时不代表完成比例，你可以取消分析。"
      : status === "submitting" ? "正在创建任务，请勿重复发送。"
      : status === "queued" ? "任务已接收，等待开始。"
      : active.size ? "完成后将继续核对统计口径和结果。" : "只分析本次问题所需内容；执行细节可展开查看。");
  }
  cancel.onclick = async () => {
    if (cancelling || terminal.has(status)) return;
    cancelling = true; cancelError = ""; draw();
    try { await onCancel(); }
    catch { cancelling = false; cancelError = "取消请求未确认，请重试；任务状态将继续同步。"; draw(); }
  };
  draw();
  return {
    root, tick: draw,
    bind(next) { task = { ...task, ...next }; status = next.status || "queued"; executionMs = next.execution_ms ?? 0; since = status === "running" ? now() : null; stage = status === "queued" ? "排队等待分析" : "正在分析"; draw(); },
    connection(value) { connection = value; draw(); },
    snapshot(next) {
      if (terminal.has(status)) return;
      if (next.status === "waiting_for_user") { executionMs = next.execution_ms ?? elapsed(); since = null; status = next.status; active.clear(); activeSince = null; }
      else if (status === "waiting_for_user" && ["running", "queued"].includes(next.status)) {
        status = next.status; executionMs = next.execution_ms ?? executionMs; since = status === "running" ? now() : null; stage = "正在继续分析";
      }
      draw();
    },
    observe(event) {
      if (terminal.has(status)) return;
      if (Number.isInteger(event.seq)) { if (seen.has(event.seq)) return; seen.add(event.seq); }
      const data = event.data || {}, at = Date.parse(event.at || "");
      if (event.type === "task_started") {
        executionMs = data.execution_ms ?? (data.resumed ? executionMs : 0);
        status = "running"; since = Number.isFinite(at) ? at : now(); stage = "正在分析";
      } else if (event.type === "question_asked") {
        executionMs = data.execution_ms ?? elapsed(); since = null; status = "waiting_for_user"; active.clear(); activeSince = null;
      } else if (event.type === "question_answered") {
        status = "queued"; stage = "正在继续分析";
      } else if (event.type === "tool_started") {
        active.set(data.call_id, { tool: data.tool, at: Number.isFinite(at) ? at : now() }); stage = toolProgressLabel(data.tool);
        activeSince = [...active.values()].find(call => call.tool === "query_execute")?.at ?? null;
      } else if (event.type === "tool_finished") {
        active.delete(data.call_id);
        activeSince = [...active.values()].find(call => call.tool === "query_execute")?.at ?? null;
        if (!active.size) stage = data.is_error ? "正在处理查询问题" : "数据已返回，正在核对结果";
        else stage = toolProgressLabel([...active.values()].at(-1).tool);
      } else if (event.type === "retry") stage = "遇到临时问题，正在重试";
      else if (event.type === "answer_ready") stage = "答案已就绪";
      else if (event.type === "task_finished") {
        executionMs = data.execution_ms ?? data.duration_ms ?? elapsed(); since = null;
        status = data.status || "incomplete"; active.clear(); activeSince = null;
      }
      draw();
    },
    failSubmission() { status = "submission_failed"; executionMs = elapsed(); since = null; draw(); },
  };
}
