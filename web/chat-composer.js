// Chat-only controls. Operator configuration remains in model-manager.js.
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Tokens are current context occupancy, never cumulative session/task usage. */
export function contextSwitchWarning(agent = {}, target = {}) {
  const usage = agent.context_usage;
  const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
  const current = Number(agent.context_window || usage?.contextWindow) || null;
  const limit = Number(target.context_window) || null;
  const smaller = current && limit && limit < current;
  const percent = tokens !== null && limit ? tokens / limit * 100 : null;
  if (!smaller && !(percent !== null && percent >= 80)) return null;
  const format = (n) => n === null ? "未知" : n.toLocaleString();
  return `当前模型上下文容量：${format(current)} tokens\n目标模型上下文容量：${format(limit)} tokens\n当前上下文用量：${format(tokens)} tokens${percent === null ? "（暂不可准确估算）" : `（目标容量的 ${percent.toFixed(1)}%）`}\n\n` +
    (percent !== null && percent >= 100 ? "当前上下文已达到或超过目标容量，下一次请求可能自动压缩历史或失败。" :
      percent !== null && percent >= 80 ? "切换后上下文接近上限，加上新问题及输出预留，可能触发历史压缩。" :
        "目标模型的上下文容量较小，后续可能更早触发历史压缩。") +
    "\n用量为最近的上下文估算，不是累计 Tokens；切换不会删除原始对话。";
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP / denied clipboard */ }
  const previous = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = el("textarea", "clipboard-fallback");
  input.value = text;
  document.body.append(input);
  try {
    input.focus(); input.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请手动选择文字复制");
  } finally {
    input.remove(); previous?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

export function initChatComposer({ api, state, applySession, onError }) {
  const $ = (id) => document.getElementById(id);
  const goal = $("goal"), messages = $("messages"), chip = $("btnModelChip");
  const sources = new WeakMap();
  const drafts = new Map();
  let displayedSession;
  let editing = false, previousDraft = "", switching = false, submitting = false, opening = 0;
  let catalog = [], scope = "enabled", stars = new Set();
  try { stars = new Set(JSON.parse(localStorage.getItem("data-agent-model-prefs") || "[]")); } catch { /* optional storage */ }
  const key = (provider, model) => JSON.stringify([provider, model]);
  const popover = $("modelPopover"), search = $("modelSearch"), list = $("modelChoices");
  const dialog = $("modelConfirm");
  const confirmText = $("modelConfirmText");
  const confirmOk = $("btnModelConfirm");
  const closePicker = () => { opening++; popover.hidden = true; chip.setAttribute("aria-expanded", "false"); };
  function resize() {
    goal.style.height = "auto";
    goal.style.height = Math.min(200, Math.max(32, goal.scrollHeight)) + "px";
  }
  function clearEditing(restore = false) {
    if (restore && editing) goal.value = previousDraft;
    editing = false; previousDraft = "";
    $("composerEditing").hidden = true;
    resize();
  }
  function update() {
    chip.disabled = !state.sessionId || !state.sessionReady || Boolean(state.taskId) || switching || submitting;
    chip.title = state.taskId ? "分析运行中，结束后可切换模型" : !state.sessionReady ? "恢复数据库连接后可切换模型" : "切换当前会话模型，不影响其他会话或全局默认";
    const agent = state.session?.agent;
    $("modelChipName").textContent = switching ? "切换中…" : agent?.model || "选择模型";
    $("modelChipProvider").textContent = agent?.provider || "";
    $("modelThinking").textContent = agent?.thinking_level ? "思考 · " + agent.thinking_level : "";
    const usage = agent?.context_usage;
    $("modelContext").textContent = typeof usage?.tokens === "number" ? `上下文 ${usage.tokens.toLocaleString()} / ${(agent.context_window || usage.contextWindow || 0).toLocaleString()}` : "上下文用量待更新";
    messages.classList.toggle("task-running", Boolean(state.taskId));
    $("btnSend").hidden = Boolean(state.taskId);
    $("btnCancel").hidden = !state.taskId;
    $("btnSteer").hidden = !state.taskId || Boolean(state.pendingQuestion);
    $("btnCancel").textContent = state.pendingQuestion ? "取消分析" : "■ 停止";
    if (switching) $("btnSend").disabled = true;
  }
  function sessionChanged() {
    if (displayedSession !== state.sessionId) {
      if (displayedSession) drafts.set(displayedSession, { value: goal.value, editing, previousDraft });
      displayedSession = state.sessionId;
      const draft = drafts.get(displayedSession);
      goal.value = draft?.value || "";
      editing = draft?.editing || false;
      previousDraft = draft?.previousDraft || "";
      $("composerEditing").hidden = !editing;
      closePicker();
      if (dialog.open) dialog.close("cancel");
      resize();
    }
    update();
  }
  function attachMessage(body, who, options = {}) {
    if (options.text !== undefined) { sources.set(body, options.text); body.textContent = options.text; }
    const wrap = body.closest(".msg");
    if (options.taskId) wrap.dataset.taskId = options.taskId;
    const actions = el("div", "msg-actions");
    actions.setAttribute("aria-label", "消息操作");
    const copy = el("button", "ghost", "复制"); copy.type = "button"; copy.dataset.messageAction = "copy";
    actions.append(copy);
    if (who === "user") {
      const edit = el("button", "ghost", "编辑重发"); edit.type = "button"; edit.dataset.messageAction = "edit";
      edit.title = "将原文放入输入框，发送时追加为新消息";
      actions.append(edit);
    }
    wrap.append(actions);
  }
  messages.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-message-action], .code-copy");
    if (!button) return;
    const body = button.closest(".msg")?.querySelector(":scope > .body");
    const text = button.matches(".code-copy") ? button.closest(".code-block").querySelector("pre code").textContent : sources.get(body) ?? body.textContent;
    if (button.dataset.messageAction === "edit") {
      // Running work is unaffected: only the draft changes, never steer/cancel/rewrite.
      if (goal.value && goal.value !== text && !window.confirm("输入框已有草稿，是否用这条消息替换？取消编辑时可以恢复原草稿。")) return;
      if (!editing) previousDraft = goal.value;
      editing = true; goal.value = text;
      $("composerEditing").hidden = false;
      resize(); goal.focus(); goal.setSelectionRange(goal.value.length, goal.value.length);
    } else {
      const label = button.textContent;
      try { await copyText(text); button.textContent = "已复制"; }
      catch (error) { button.textContent = "复制失败"; onError(error.message); }
      setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1600);
    }
  });
  $("btnEditCancel").onclick = () => { clearEditing(true); goal.focus(); };
  goal.addEventListener("input", resize);
  goal.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) { event.preventDefault(); $("btnSend").click(); }
    if (event.key === "Escape" && editing) { event.preventDefault(); clearEditing(true); }
  });
  // Existing quick prompts/catalog insertion write .value directly.
  goal.addEventListener("focus", resize);
  function renderChoices() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const agent = state.session?.agent || {};
    for (const channel of catalog) {
      const models = channel.models.filter((model) => (scope === "all" || model.enabled || stars.has(key(channel.id, model.id))) &&
        `${channel.name} ${channel.id} ${model.name} ${model.id}`.toLowerCase().includes(query));
      if (!models.length) continue;
      list.append(el("div", "model-group", channel.name + (channel.ready ? "" : " · 待配置凭证")));
      models.sort((a, b) => Number(stars.has(key(channel.id, b.id))) - Number(stars.has(key(channel.id, a.id))));
      for (const model of models) {
        const row = el("div", "model-option-row");
        const selected = agent.provider === channel.id && agent.model === model.id;
        row.classList.toggle("selected", selected);
        const option = el("button", "model-option", (selected ? "✓ " : "") + (model.name || model.id));
        option.type = "button";
        option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(selected));
        option.disabled = !channel.ready;
        option.title = `${channel.id} / ${model.id} · 上下文 ${model.context_window?.toLocaleString() || "未知"}${channel.ready ? "" : " · 请先在模型管理配置凭证"}`;
        option.onclick = () => void choose(channel.id, model);
        const star = el("button", "model-star", stars.has(key(channel.id, model.id)) ? "★" : "☆");
        star.type = "button"; star.title = "收藏模型";
        star.setAttribute("aria-label", "收藏 " + model.id); star.setAttribute("aria-pressed", String(stars.has(key(channel.id, model.id))));
        star.onclick = () => {
          const id = key(channel.id, model.id);
          if (stars.has(id)) stars.delete(id); else stars.add(id);
          try { localStorage.setItem("data-agent-model-prefs", JSON.stringify([...stars])); } catch { /* optional */ }
          renderChoices();
        };
        row.append(option, star); list.append(row);
      }
    }
    if (!list.children.length) list.append(el("p", "muted", "没有匹配的模型"));
  }
  function confirmSwitch(message) {
    confirmText.textContent = message;
    dialog.returnValue = "cancel";
    dialog.showModal();
    return new Promise((resolve) => { dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); });
  }
  confirmOk.onclick = () => dialog.close("confirm");
  $("btnModelConfirmCancel").onclick = () => dialog.close("cancel");
  async function choose(provider, model) {
    const id = state.sessionId;
    if (switching || submitting || state.taskId || !state.sessionReady || !id) return;
    if (state.session?.agent?.provider === provider && state.session?.agent?.model === model.id) { closePicker(); return; }
    closePicker(); switching = true; update();
    try {
      // Refresh occupancy before comparison (another task/tab may have changed it).
      const { session } = await api(`/v1/sessions/${encodeURIComponent(id)}`);
      if (state.sessionId !== id) return;
      const warning = contextSwitchWarning(session.agent, model);
      if (warning && !(await confirmSwitch(warning))) return;
      if (state.sessionId !== id) return;
      const result = await api(`/v1/sessions/${encodeURIComponent(id)}/model`, { method: "POST", body: { provider, modelId: model.id } });
      if (state.sessionId === id) applySession(result.session);
    } catch (error) { if (state.sessionId === id) onError("模型切换失败：" + error.message); }
    finally { switching = false; $("btnSend").disabled = !state.sessionReady || Boolean(state.taskId); update(); }
  }
  chip.onclick = async () => {
    if (!popover.hidden) { closePicker(); return; }
    const version = ++opening;
    popover.hidden = false; chip.setAttribute("aria-expanded", "true");
    search.value = ""; list.replaceChildren(el("p", "muted", "读取模型…")); search.focus();
    try {
      const data = await api(`/v1/sessions/${encodeURIComponent(state.sessionId)}/models`);
      if (version !== opening) return;
      catalog = data.channels; renderChoices();
    } catch (error) { if (version === opening) list.replaceChildren(el("p", "warning-text", error.message)); }
  };
  search.oninput = renderChoices;
  for (const button of popover.querySelectorAll("[data-model-scope]")) button.onclick = () => {
    scope = button.dataset.modelScope;
    for (const tab of popover.querySelectorAll("[data-model-scope]")) tab.setAttribute("aria-pressed", String(tab === button));
    renderChoices(); search.focus();
  };
  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closePicker(); chip.focus(); return; }
    const items = [...list.querySelectorAll('[role="option"]:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (event.key === "Enter" && document.activeElement === search) { event.preventDefault(); items[0].click(); }
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".model-picker")) closePicker(); });
  update(); resize();
  return {
    update, sessionChanged, resize, attachMessage,
    setSubmitting(value) { submitting = value; update(); },
    setSource(body, source) { sources.set(body, source); },
    appendSource(body, text) { sources.set(body, (sources.get(body) || "") + text); },
    sent() { clearEditing(); goal.value = ""; resize(); },
  };
}
