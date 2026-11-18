const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function initWorkbench({ api, state, openResult, buildChartCard, loadHistory }) {
  let request = 0,
    histories = [],
    results = [],
    artifacts = [];
  const context = el("aside", "context-panel");
  context.id = "analysisContext";
  context.setAttribute("aria-label", "分析上下文");
  const tabs = el("div", "context-tabs");
  const sections = {};
  for (const [key, title] of [
    ["catalog", "目录"],
    ["results", "结果"],
    ["charts", "图表"],
    ["session", "上下文"],
  ]) {
    const button = el("button", "ghost", title);
    button.setAttribute("aria-controls", "context-" + key);
    button.setAttribute("aria-pressed", String(key === "catalog"));
    const section = el("section", "context-content");
    section.id = "context-" + key;
    section.hidden = key !== "catalog";
    sections[key] = section;
    button.onclick = () => {
      for (const [k, s] of Object.entries(sections)) s.hidden = k !== key;
      for (const b of tabs.children) b.setAttribute("aria-pressed", String(b === button));
    };
    tabs.append(button);
  }
  context.append(tabs, ...Object.values(sections));
  document.querySelector("main").append(context);
  const budget = el("div", "budget-strip");
  budget.setAttribute("role", "status");
  document.querySelector("#taskbar").after(budget);
  const history = el("section", "panel history-panel");
  history.append(el("h2", "", "分析记录"));
  const search = el("input");
  search.placeholder = "搜索会话 / 数据库";
  search.setAttribute("aria-label", "搜索历史会话");
  const historyList = el("div", "history-list");
  history.append(search, historyList);
  document.querySelector(".sidebar").prepend(history);
  const catalogSearch = el("input");
  catalogSearch.placeholder = "搜索表、字段和注释";
  catalogSearch.setAttribute("aria-label", "搜索数据目录");
  const catalogStatus = el("p", "muted", "连接后查看目录。历史结果可离线浏览。");
  const catalog = el("div", "catalog-tree");
  const refresh = el("button", "ghost", "刷新目录");
  sections.catalog.append(catalogSearch, refresh, catalogStatus, catalog);
  const sessionDetails = el("div", "session-context"),
    datasets = el("div", "result-list"),
    snapshots = el("div", "result-list"),
    timeline = el("div", "evidence-timeline");
  const usageNote = el("p", "muted", "Token / 上下文使用量将在模型响应后更新。");
  sections.session.append(
    sessionDetails,
    usageNote,
    el("h3", "", "工作区数据集"),
    datasets,
    el("h3", "", "本地快照"),
    snapshots,
    el("h3", "", "本次执行记录"),
    timeline,
  );
  const resultList = el("div", "result-list");
  sections.results.append(el("h3", "", "已保存结果"), resultList);
  const dashboard = el("button", "ghost", "打开图表工作台");
  const chartList = el("div", "result-list");
  sections.charts.append(dashboard, chartList);
  let debounce;
  const browseCatalog = async (force = false) => {
    if (!state.sessionId || !state.sessionReady) {
      catalog.replaceChildren();
      return;
    }
    const id = state.sessionId,
      token = ++request;
    catalogStatus.textContent = "读取目录…";
    try {
      const r = await api(
        `/v1/sessions/${id}/catalog?columns=true&search=${encodeURIComponent(catalogSearch.value)}${force ? "&refresh=true" : ""}`,
      );
      if (token !== request || state.sessionId !== id) return;
      catalog.replaceChildren();
      catalogStatus.textContent = `显示 ${r.objects.length} 个候选对象（最多 200）。元数据按会话缓存。`;
      const groups = new Map();
      for (const object of r.objects) {
        if (!groups.has(object.schema)) {
          const d = el("details");
          d.open = true;
          d.append(el("summary", "", object.schema));
          groups.set(object.schema, d);
          catalog.append(d);
        }
        const b = el("button", "catalog-object", object.name);
        b.title = [
          object.kind,
          object.rowEstimate == null ? "行数未知" : "~" + object.rowEstimate.toLocaleString() + " 行",
          object.comment,
        ]
          .filter(Boolean)
          .join(" · ");
        b.onclick = () => describe(object);
        groups.get(object.schema).append(b);
      }
    } catch (e) {
      if (token === request) catalogStatus.textContent = e.message;
    }
  };
  refresh.onclick = () => void browseCatalog(true);
  catalogSearch.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void browseCatalog(), 350);
  };
  async function describe(object) {
    const id = state.sessionId;
    try {
      const d = await api(
        `/v1/sessions/${id}/object?schema=${encodeURIComponent(object.schema)}&name=${encodeURIComponent(object.name)}`,
      );
      if (state.sessionId !== id) return;
      const dialog = el("dialog", "object-dialog");
      const h = el("h2", "", object.schema + "." + object.name);
      const close = el("button", "ghost", "关闭");
      close.onclick = () => dialog.close();
      const note = el(
        "p",
        "muted",
        [
          object.comment,
          "主键: " + (d.primaryKey.join(", ") || "未声明"),
          "估算行数: " + (object.rowEstimate ?? "未知"),
          "分区键: " + (d.partitionKey ?? "未知/未分区"),
        ]
          .filter(Boolean)
          .join(" · "),
      );
      const table = el("table", "data-grid");
      for (const c of d.columns) {
        const row = el("tr");
        row.append(
          el("th", "", c.name),
          el("td", "mono", c.type),
          el("td", "", c.nullable ? "可空" : "NOT NULL"),
          el("td", "", c.comment ?? ""),
        );
        table.append(row);
      }
      const ask = el("button", "primary", "针对这张表提问");
      ask.onclick = () => {
        document.querySelector("#goal").value = `请分析 ${object.schema}.${object.name}：`;
        dialog.close();
        document.querySelector("#goal").focus();
      };
      dialog.append(h, close, note, table, ask);
      document.body.append(dialog);
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      dialog.showModal();
    } catch (e) {
      catalogStatus.textContent = e.message;
    }
  }
  function drawHistory() {
    historyList.replaceChildren();
    for (const s of histories.filter((s) =>
      [s.title, s.database, s.session_id].join(" ").toLowerCase().includes(search.value.toLowerCase()),
    )) {
      const b = el("button", "history-item" + (s.session_id === state.sessionId ? " selected" : ""));
      b.append(
        el("strong", "", s.title || s.tasks?.[0]?.goal?.slice(0, 50) || s.database),
        el("small", "muted", `${s.database} · ${s.status} · ${(s.last_used_at ?? s.created_at ?? "").slice(0, 10)}`),
      );
      b.onclick = () => {
        const select = document.querySelector("#historySelect");
        select.value = s.session_id;
        select.dispatchEvent(new Event("change"));
        document.querySelector("#btnHistory").click();
      };
      historyList.append(b);
    }
    if (!histories.length) historyList.append(el("p", "muted", "尚无分析记录"));
  }
  search.oninput = drawHistory;
  async function updateHistory(items) {
    histories = items;
    drawHistory();
  }
  async function refreshContext() {
    const id = state.sessionId;
    drawHistory();
    if (!id) {
      results = [];
      artifacts = [];
      resultList.replaceChildren(el("p", "muted", "建立会话或读取历史后查看结果"));
      chartList.replaceChildren();
      return;
    }
    try {
      const [r, a] = await Promise.all([api(`/v1/sessions/${id}/results`), api(`/v1/sessions/${id}/artifacts`)]);
      if (state.sessionId !== id) return;
      results = r.results;
      artifacts = a.artifacts;
      resultList.replaceChildren();
      chartList.replaceChildren();
      for (const m of results) {
        const b = el("button", "result-item");
        b.append(
          el("strong", "", m.label || m.id.slice(0, 14)),
          el(
            "small",
            m.truncated !== "none" ? "warning-text" : "muted",
            `${m.rowCount.toLocaleString()} 行 · ${m.durationMs} ms${m.truncated !== "none" ? " · 不完整" : ""}${m.lineage ? " · 本地派生" : ""}`,
          ),
        );
        b.onclick = () => openResult(m.id);
        resultList.append(b);
      }
      for (const a of artifacts) {
        const b = el("button", "result-item", a.title || a.type);
        b.onclick = () => showDashboard(a.id);
        chartList.append(b);
      }
      if (!results.length) resultList.append(el("p", "muted", "查询结果将在这里出现"));
      if (!artifacts.length) chartList.append(el("p", "muted", "图表会保存为可追溯的证据"));
      const snapshotResponse = await api(`/v1/sessions/${id}/snapshots`);
      if (state.sessionId !== id) return;
      snapshots.replaceChildren();
      for (const s of snapshotResponse.snapshots) {
        const line = el("div", "snapshot-item");
        const b = el("button", "result-item", s.name);
        b.title = s.created_at;
        b.onclick = () => openResult(s.result_id);
        const unpin = el("button", "ghost", "取消固定");
        unpin.onclick = async () => {
          try {
            await api(`/v1/sessions/${id}/snapshots/${s.id}`, {
              method: "DELETE",
            });
            void refreshContext();
          } catch (e) {
            unpin.textContent = e.message;
          }
        };
        line.append(b, unpin);
        snapshots.append(line);
      }
      if (!snapshotResponse.snapshots.length) snapshots.append(el("p", "muted", "结果工作台中可固定完整本地结果"));
      datasets.replaceChildren(
        el("p", "muted", state.sessionReady ? "读取工作区…" : "工作区状态需恢复数据库连接后确认"),
      );
      if (state.sessionReady) {
        const d = await api(`/v1/sessions/${id}/datasets`);
        if (state.sessionId !== id) return;
        datasets.replaceChildren();
        for (const item of d.datasets)
          datasets.append(
            el("p", "mono", `${item.name} · ${item.kind} · ${item.status}${item.exists ? "" : " · 不存在"}`),
          );
        if (!d.datasets.length) datasets.append(el("p", "muted", "无工作区数据集（图表与本地分析不需要工作区）"));
      }
    } catch (e) {
      resultList.textContent = e.message;
    }
  }
  async function showDashboard(highlight) {
    const dialog = el("dialog", "dashboard-dialog");
    const head = el("header");
    head.append(el("h2", "", "图表工作台"));
    const close = el("button", "ghost", "关闭 Esc");
    close.onclick = () => dialog.close();
    head.append(close);
    const grid = el("div", "dashboard-grid");
    dialog.append(head, grid);
    document.body.append(dialog);
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        document.dispatchEvent(new Event("charts-dispose-check"));
      },
      { once: true },
    );
    dialog.showModal();
    for (const a of artifacts) {
      try {
        const r = await api(`/v1/artifacts/${a.id}`);
        if (!dialog.open) return;
        const card = buildChartCard(r.artifact);
        if (a.id === highlight) card.classList.add("highlight");
        grid.append(card);
      } catch (e) {
        grid.append(el("p", "warning-text", e.message));
      }
    }
  }
  dashboard.onclick = () => void showDashboard();
  let budgetState = {},
    usageLabel = "";
  function updateUsage(value = {}) {
    const tokens = ["input", "output", "cacheRead", "cacheWrite"].reduce((n, key) => n + (Number(value[key]) || 0), 0);
    usageLabel = tokens ? " · Tokens " + tokens.toLocaleString() : "";
    usageNote.textContent = `累计 Tokens ${tokens.toLocaleString()}${value.cost != null ? " · 成本 " + value.cost : ""} · 上下文 ${value.context_usage == null ? "暂不可用" : JSON.stringify(value.context_usage).slice(0, 500)}`;
    updateBudget({});
  }
  function updateBudget(value) {
    budgetState = { ...budgetState, ...value };
    const q = budgetState.queries_remaining,
      t = budgetState.turns_remaining;
    budget.textContent = `源数据只读${q != null ? " · 剩余查询 " + q : ""}${t != null ? " · 剩余轮次 " + t : ""}${usageLabel} · 查询时间不等于数据更新时间`;
    budget.classList.toggle("low", q != null && q <= 5);
  }
  let displayedSession = null;
  function sessionChanged() {
    request++;
    catalogSearch.value = "";
    if (displayedSession !== state.sessionId) {
      timeline.replaceChildren();
      displayedSession = state.sessionId;
      budgetState = {};
      usageLabel = "";
      usageNote.textContent = "Token / 上下文使用量将在模型响应后更新。";
      updateBudget({});
    }
    const s = state.session,
      c = s?.capabilities ?? {};
    sessionDetails.replaceChildren();
    if (s) {
      for (const [key, value] of [
        ["连接", `${s.engine} / ${s.database}`],
        ["状态", s.status],
        ["源数据权限", `${c.sourceAccess ?? "只读"} · ${c.readOnlyProof ?? "未知"}`],
        ["时区", c.timezone ?? "未指定；请在 SQL 中明确转换"],
        ["工作区", c.workspaceName ?? "未配置"],
        ["查询预算", s.queries ? `${s.queries.used} / ${s.queries.limit}` : "—"],
      ]) {
        const row = el("div", "context-kv");
        row.append(el("span", "muted", key), el("span", "", String(value)));
        sessionDetails.append(row);
      }
      for (const note of [...(c.notes ?? []), ...(c.workspaceNote ? [c.workspaceNote] : [])])
        sessionDetails.append(el("p", "muted", note));
    }
    void browseCatalog();
    void refreshContext();
    if (state.session?.queries)
      updateBudget({
        queries_remaining: state.session.queries.limit - state.session.queries.used,
      });
  }
  function toolEvent(type, data) {
    if (type !== "tool_started" && type !== "tool_finished") return;
    let row = [...timeline.children].find((n) => n.dataset.call === data.call_id);
    if (!row) {
      row = el("button", "timeline-item");
      row.dataset.call = data.call_id;
      row.onclick = () => {
        const card = [...document.querySelectorAll(".tool[data-call]")].find((n) => n.dataset.call === data.call_id);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      timeline.prepend(row);
    }
    row.textContent =
      (data.tool ?? row.dataset.name ?? "工具") +
      (type === "tool_started" ? " · 执行中" : ` · ${data.is_error ? "失败" : "完成"} · ${data.duration_ms ?? "—"} ms`);
    if (data.tool) row.dataset.name = data.tool;
    while (timeline.children.length > 60) timeline.lastChild.remove();
  }
  const command = el("dialog", "command-dialog");
  command.setAttribute("aria-label", "命令面板");
  const input = el("input");
  input.placeholder = "搜索会话、结果，或输入命令";
  input.setAttribute("aria-label", "搜索命令");
  const choices = el("div", "command-list");
  command.append(input, choices);
  document.body.append(command);
  let commands = [];
  function showChoices() {
    choices.replaceChildren();
    for (const c of commands.filter((c) => c.name.toLowerCase().includes(input.value.toLowerCase())).slice(0, 20)) {
      const b = el("button", "command-item", c.name);
      b.onclick = () => {
        command.close();
        c.run();
      };
      choices.append(b);
    }
  }
  function openCommands() {
    commands = [
      { name: "聚焦提问", run: () => document.querySelector("#goal").focus() },
      { name: "打开图表工作台", run: () => void showDashboard() },
      { name: "刷新数据目录", run: () => void browseCatalog(true) },
      {
        name: "模型配置",
        run: () => document.querySelector("#tabModel").click(),
      },
      ...results.map((r) => ({
        name: "结果 · " + (r.label || r.id),
        run: () => openResult(r.id),
      })),
      ...histories.map((s) => ({
        name: "会话 · " + (s.title || s.database),
        run: () => {
          document.querySelector("#historySelect").value = s.session_id;
          document.querySelector("#btnHistory").click();
        },
      })),
    ];
    input.value = "";
    showChoices();
    command.showModal();
    input.focus();
  }
  input.oninput = showChoices;
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      choices.querySelector("button")?.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choices.querySelector("button")?.click();
    }
  };
  choices.onkeydown = (e) => {
    const items = [...choices.querySelectorAll("button")],
      i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (!command.open) openCommands();
    }
  });
  document.querySelector("#btnCommands")?.addEventListener("click", openCommands);
  document.querySelector("#btnTheme")?.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    localStorage.setItem("data-agent-theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
  });
  if (localStorage.getItem("data-agent-theme") === "dark") document.documentElement.classList.add("dark");
  updateBudget({});
  return {
    sessionChanged,
    refreshContext,
    updateHistory,
    updateBudget,
    updateUsage,
    toolEvent,
  };
}
