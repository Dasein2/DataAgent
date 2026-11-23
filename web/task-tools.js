/** Shared by live streaming and on-demand historical process replay. */
export function createProcessRenderer({ escapeHtml, renderMarkdown, openResult, statusNote }) {
  return function renderProcessEvent(event, host) {
    const data = event.data || {};
    if (event.type === "message_delta") {
      const node = document.createElement("div"); node.className = "text";
      node.innerHTML = renderMarkdown(String(data.text || "")); host.append(node);
      return;
    }
    if (event.type === "retry" || event.type === "notice") {
      const text = event.type === "retry" ? "retry #" + data.attempt + ": " + data.error
        : data.code + (data.max_turns ? " (max " + data.max_turns + " turns)" : "") + (data.text ? ": " + data.text : "");
      host.append(statusNote(text, "warn")); return;
    }
    if (event.type === "tool_started") {
      if ([...host.querySelectorAll(".tool")].some((el) => el.dataset.call === data.call_id)) return;
      const el = document.createElement("div"); el.dataset.call = data.call_id;
      el.className = "tool has-head";
      const args = data.args || {};
      const detail = String(args.sql || args.name || args.search || args.result_id || "");
      const full = detail.replace(/\s+/g, " ");
      const preview = full.length > 180 ? full.slice(0, 180) + "…" : full;
      el.innerHTML = '<button type="button" class="tool-head" aria-expanded="false">' +
        '<span class="chev" aria-hidden="true">▸</span><span class="name">' + escapeHtml(String(data.tool)) + '</span>' +
        '<span class="preview">' + escapeHtml(preview) + '</span><span class="meta">running…</span></button>' +
        '<div class="tool-body" hidden>' + (detail ? '<pre class="tool-sql">' + escapeHtml(detail.slice(0, 1200)) +
          (detail.length > 1200 ? "\n…（已截断，共 " + detail.length + " 字符）" : "") + '</pre>' : '') + '</div>';
      host.append(el); return;
    }
    if (event.type !== "tool_finished") return;
    const el = [...host.querySelectorAll(".tool")].find((el) => el.dataset.call === data.call_id);
    if (!el || el.dataset.finished) return;
    el.dataset.finished = "true";
    el.classList.toggle("error", Boolean(data.is_error));
    el.querySelector(".meta").textContent = (data.is_error ? "error" : "ok") + (data.duration_ms != null ? " · " + data.duration_ms + "ms" : "");
    const body = el.querySelector(".tool-body");
    if (data.summary) {
      const pre = document.createElement("pre"); pre.className = "tool-output";
      pre.textContent = String(data.summary).slice(0, 800); body.append(pre);
    }
    const resultId = data.details?.result_id;
    if (resultId) {
      const button = document.createElement("button"); button.type = "button"; button.className = "ghost";
      button.textContent = "查看结果 " + resultId; button.onclick = () => openResult(resultId); body.append(button);
    }
    if (data.is_error) {
      el.classList.add("open"); body.hidden = false;
      el.querySelector(".tool-head").setAttribute("aria-expanded", "true");
      el.querySelector(".chev").textContent = "▾";
    }
  };
}
