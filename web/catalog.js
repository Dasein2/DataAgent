const make = (tag, cls, value) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
};
const button = (label, cls = "ghost") => {
  const node = make("button", cls, label);
  node.type = "button";
  return node;
};
const kinds = {
  table: ["▦", "表"], view: ["▤", "视图"], materialized_view: ["▣", "物化视图"],
  foreign_table: ["▧", "外部表"], sequence: ["≡", "序列"],
};
const objectKey = ({ schema, name }) => JSON.stringify([schema, name]);
const pageState = () => ({ objects: [], nextOffset: 0, loading: false, error: "" });

export function qualifiedTableName(engine, schema, name) {
  const quote = engine === "postgres" ? '"' : "`";
  return [schema, name].map((value) => quote + value.replaceAll(quote, quote + quote) + quote).join(".");
}

export function initCatalog({ api, state, panel, reveal }) {
  const heading = make("div", "catalog-heading");
  const title = make("h3", "", "数据库目录");
  const refresh = button("↻", "ghost catalog-refresh");
  refresh.title = "刷新目录";
  refresh.setAttribute("aria-label", "刷新目录");
  heading.append(title, refresh);
  const source = make("p", "catalog-source");
  const tools = make("div", "catalog-toolbar");
  const search = make("input", "catalog-search");
  search.type = "search";
  search.placeholder = "搜索库、表名或表注释";
  search.setAttribute("aria-label", "搜索数据目录");
  search.maxLength = 120;
  const filter = make("select", "catalog-kind");
  filter.setAttribute("aria-label", "对象类型");
  for (const [value, label] of [["", "全部"], ["table", "表"], ["view", "视图"]]) {
    const option = make("option", "", label);
    option.value = value;
    filter.append(option);
  }
  tools.append(search, filter);
  const fieldToggle = button("搜主库字段", "ghost catalog-fields");
  fieldToggle.title = "按主库的字段名或字段注释搜索；较慢，不影响默认的表名搜索";
  fieldToggle.setAttribute("aria-pressed", "false");
  const status = make("p", "catalog-status");
  status.setAttribute("role", "status");
  const body = make("div", "catalog-scroll");
  const tree = make("div", "catalog-tree"), results = make("div", "catalog-results");
  results.hidden = true;
  body.append(tree, results);
  panel.append(heading, source, tools, fieldToggle, status, body);

  const drawer = make("dialog", "catalog-drawer");
  drawer.setAttribute("aria-labelledby", "catalog-object-title");
  const header = make("header", "catalog-detail-header");
  const detailHeading = make("div", "catalog-detail-heading");
  const path = make("p", "catalog-detail-path");
  const objectTitle = make("h2");
  objectTitle.id = "catalog-object-title";
  detailHeading.append(path, objectTitle);
  const close = button("关闭");
  header.append(detailHeading, close);
  const actions = make("div", "catalog-detail-actions");
  const copy = button("复制完整表名"), ask = button("针对这张表提问", "primary");
  actions.append(copy, ask);
  const detailStatus = make("p", "catalog-status");
  detailStatus.setAttribute("role", "status");
  const detailTabs = make("div", "catalog-detail-tabs");
  const detailBody = make("div", "catalog-detail-body");
  drawer.append(header, actions, detailStatus, detailTabs, detailBody);
  document.querySelector("#chat").append(drawer);

  // Bounded, in-memory snapshots only. A historical session never inherits another session's data.
  const snapshots = new Map();
  let identity, key, ready = false, view, connection, run = new AbortController();
  let selected, detailRun, detailReturn, debounce, query = "", found = pageState(), treeScroll = 0, deep = false;
  let loadingScopes = false, scopeError = "", refreshPages = false;
  const groups = new Map();
  const searchKey = (offset) => JSON.stringify([deep ? primaryScope() : null, view.type, query, offset]);
  const canBrowse = () => ready || Boolean(view?.loadedAt);
  const primaryScope = () => view?.primary || state.session?.default_scope || "";
  const searchMessage = () => deep ? `正在搜索 ${primaryScope()} 的字段…` : "正在搜索可访问的库、表名和表注释…";
  const scopeLabel = () => state.session?.engine === "postgres" ? "Schema" : "数据库";
  const url = (suffix, params) => `/v1/sessions/${encodeURIComponent(state.sessionId)}/${suffix}${params ? "?" + new URLSearchParams(params) : ""}`;
  const persistScroll = () => { if (view && !query) view.scroll = body.scrollTop; };
  body.addEventListener("scroll", persistScroll);

  function updateStatus() {
    refresh.disabled = !ready || loadingScopes;
    search.disabled = !ready;
    filter.disabled = !ready;
    fieldToggle.disabled = !ready || !primaryScope();
    const session = state.session;
    source.textContent = session ? `${session.capabilities?.engineLabel || session.engine} · ${session.database}` : "未连接数据库";
    source.title = session ? [session.database, session.host].filter(Boolean).join(" @ ") : "";
    let text = "";
    if (!ready) text = !state.sessionId ? "连接数据库后浏览表和视图。" : view?.loadedAt
      ? `目录快照 · ${new Date(view.loadedAt).toLocaleString()}。恢复分析后可刷新和搜索。`
      : "此会话已断开。恢复分析后可查看目录。";
    else if (scopeError && !query) text = `无法读取目录：${scopeError}`;
    else if (query) {
      if (found.error) text = `搜索失败：${found.error}`;
      else if (found.loading && !found.objects.length) text = searchMessage();
      else if (!found.objects.length) text = "没有匹配的对象。";
      else text = `${found.nextOffset !== null ? "已显示" : "找到"} ${found.objects.length} 个匹配对象`;
    } else if (loadingScopes) text = "读取目录…";
    else if (view?.loadedAt && !view.scopes.length) text = `未发现可访问的${scopeLabel()}。`;
    status.textContent = text;
  }

  function objectRow(object, fromSearch = false) {
    const qualified = `${object.schema}.${object.name}`;
    const [icon, kind] = kinds[object.kind] || ["◇", "对象"];
    const row = button(undefined, "catalog-object");
    row.dataset.object = objectKey(object);
    row.setAttribute("aria-pressed", String(selected === row.dataset.object));
    row.setAttribute("aria-label", `${qualified} · ${kind}`);
    row.title = [qualified, kind, object.comment].filter(Boolean).join(" · ");
    const glyph = make("span", "catalog-icon", icon);
    glyph.setAttribute("aria-hidden", "true");
    const labels = make("span", "catalog-object-labels");
    labels.append(make("span", "catalog-object-name", object.name));
    if (fromSearch) {
      const match = object.columnMatch;
      const reason = { name: "表名", schema: scopeLabel(), comment: "表注释", column: "字段或字段注释" }[object.match];
      const detail = match ? `字段：${match.name}${match.count > 1 ? `（共 ${match.count} 个）` : ""}` :
        object.match === "comment" && object.comment ? `注释：${object.comment}` : reason ? `命中${reason}` : "";
      labels.append(make("small", "catalog-object-meta", object.schema));
      if (detail) {
        labels.append(make("small", "catalog-object-meta catalog-hit", detail));
        row.title += " · " + detail;
      }
    }
    row.append(glyph, labels);
    row.onclick = () => openObject(object, row, fromSearch && object.match === "column" ? query : "");
    return row;
  }

  function renderPage(container, page, load, fromSearch = false) {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.object;
    const previousLength = container.querySelectorAll(".catalog-object").length;
    const rows = page.objects.map((object) => objectRow(object, fromSearch));
    container.replaceChildren(...rows);
    if (page.error && !fromSearch) container.append(make("p", "catalog-branch-note", page.error));
    if (page.loading) container.append(make("p", "catalog-branch-note", "加载中…"));
    else if (ready && page.nextOffset !== null && (page.objects.length || page.error)) {
      const more = button(page.error ? "重试" : "加载更多", "catalog-more");
      more.onclick = load;
      container.append(more);
    } else if (!fromSearch && !page.objects.length) {
      container.append(make("p", "catalog-branch-note", ready ? "没有此类型的对象。" : "未缓存此分组。"));
    }
    if (focusKey) rows.find((row) => row.dataset.object === focusKey)?.focus({ preventScroll: true });
    if (focused?.classList.contains("catalog-more")) {
      (rows[previousLength] || container.querySelector(".catalog-more") || container)?.focus({ preventScroll: true });
    }
  }

  async function loadPage(page, params, render, { refresh: force = false, mode = run.signal, cacheKey } = {}) {
    if (!ready || page.loading || page.nextOffset === null || mode.aborted) return;
    page.loading = true;
    page.error = "";
    updateStatus();
    const clicked = document.activeElement?.classList.contains("catalog-more") ? document.activeElement : null;
    clicked?.setAttribute("aria-busy", "true");
    // Keep the focused "load more" button in place while fetching.
    if (!clicked || !page.objects.length) render();
    const offset = page.nextOffset;
    try {
      const cache = view.searchPages;
      const cached = !force && cacheKey && cache.get(cacheKey);
      const hit = cached && cached.until > Date.now();
      const reply = hit ? cached.reply : await api(url("catalog/objects", { ...params, offset, ...(force ? { refresh: "true" } : {}) }), { signal: mode });
      if (mode.aborted) return;
      if (cacheKey && !hit) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { reply, until: Date.now() + 60_000 });
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      }
      const existing = new Set(page.objects.map(objectKey));
      page.objects.push(...reply.objects.filter((object) => !existing.has(objectKey(object))));
      page.nextOffset = reply.nextOffset;
    } catch (error) {
      if (!mode.aborted) page.error = error.message;
    } finally {
      if (!mode.aborted) {
        page.loading = false;
        clicked?.removeAttribute("aria-busy");
        render();
        updateStatus();
      }
    }
  }

  function loadScope(name, force = false) {
    if (!groups.has(name) || !ready) return;
    const page = view.pages.get(name) || pageState();
    view.pages.set(name, page);
    return loadPage(page, { schema: name, ...(view.type ? { type: view.type } : {}) },
      () => groups.get(name)?.render(), { refresh: force });
  }

  function renderTree({ load = true } = {}) {
    const y = view.scroll;
    groups.clear();
    tree.replaceChildren();
    for (const name of view.scopes) {
      const branch = make("details", "catalog-group");
      branch.open = view.open.has(name);
      const summary = make("summary", "catalog-group-label");
      summary.title = name;
      const icon = make("span", "catalog-icon", "▱");
      icon.setAttribute("aria-hidden", "true");
      summary.append(icon, make("span", "catalog-scope-name", name));
      const count = view.tableCounts?.[name];
      const primaryLabel = name === view.primary ? (state.session?.engine === "postgres" ? "默认" : "主库") : "";
      if (Number.isSafeInteger(count) && count >= 0) {
        const value = count.toLocaleString("zh-CN");
        const badge = make("span", "catalog-scope-count", value);
        badge.title = value + " 张可见表（不含视图）";
        summary.append(badge);
        summary.setAttribute("aria-label", [name, badge.title, primaryLabel].filter(Boolean).join(" · "));
      }
      if (primaryLabel) summary.append(make("span", "catalog-primary", primaryLabel));
      const children = make("div", "catalog-branch");
      children.tabIndex = -1;
      const render = () => renderPage(children, view.pages.get(name) || pageState(), () => void loadScope(name, refreshPages));
      branch.append(summary, children);
      branch.ontoggle = () => {
        if (groups.get(name)?.branch !== branch) return;
        if (branch.open) {
          view.open.add(name);
          if (!loadingScopes && !view.pages.has(name)) void loadScope(name, refreshPages);
        } else view.open.delete(name);
      };
      groups.set(name, { branch, render });
      tree.append(branch);
      render();
    }
    if (!query) {
      body.scrollTop = y;
      view.scroll = y;
    }
    if (load && ready && !query) for (const name of view.open) if (!view.pages.has(name)) void loadScope(name, refreshPages);
  }

  async function loadScopes(force = false) {
    const signal = run.signal;
    scopeError = "";
    loadingScopes = true;
    updateStatus();
    try {
      const reply = await api(url("catalog/scopes", force ? { refresh: "true" } : undefined), { signal });
      if (signal.aborted) return;
      const previous = view.loadedAt;
      view.primary = reply.default_scope;
      view.tableCounts = reply.table_counts;
      view.scopes = [...reply.scopes].sort((a, b) => a === b ? 0 : a === view.primary ? -1 : b === view.primary ? 1 : a.localeCompare(b));
      if (!previous && view.scopes.length) view.open.add(view.scopes[0]);
      for (const name of view.open) if (!view.scopes.includes(name)) view.open.delete(name);
      view.loadedAt = Date.now();
      renderTree();
    } catch (error) {
      if (!signal.aborted) scopeError = error.message;
    } finally {
      if (!signal.aborted) {
        loadingScopes = false;
        updateStatus();
      }
    }
  }

  function loadSearch(force = false) {
    const page = found;
    const schema = deep ? primaryScope() : null;
    if (deep && !schema) return; // Never turn a scoped field search into a cross-database scan.
    const params = { search: query, match: deep ? "all" : "objects",
      ...(schema ? { schema } : {}), ...(view.type ? { type: view.type } : {}) };
    return loadPage(page, params, () => {
      if (page === found) renderPage(results, page, () => void loadSearch(), true);
    }, { refresh: force, mode: searchRun.signal, cacheKey: searchKey(page.nextOffset) });
  }

  let searchRun = new AbortController();
  function setQuery(value, force = false) {
    clearTimeout(debounce);
    searchRun.abort();
    searchRun = new AbortController();
    const previous = query;
    if (!previous && value) treeScroll = body.scrollTop;
    query = value;
    found = pageState();
    results.replaceChildren();
    results.hidden = !query;
    tree.hidden = Boolean(query);
    if (!query) {
      if (previous) {
        body.scrollTop = treeScroll;
        if (!loadingScopes) for (const name of view.open) if (!view.pages.has(name)) void loadScope(name, refreshPages);
      }
      updateStatus();
      return;
    }
    body.scrollTop = 0;
    status.textContent = searchMessage();
    if (force || view.searchPages.get(searchKey(0))?.until > Date.now()) void loadSearch(force);
    else debounce = setTimeout(() => void loadSearch(), deep ? 360 : 180);
  }

  function interrupt() {
    run.abort();
    run = new AbortController();
    clearTimeout(debounce);
    searchRun.abort();
    if (view) for (const [name, page] of view.pages) {
      if (page.loading && !page.objects.length) view.pages.delete(name);
      else page.loading = false;
    }
  }

  function sessionChanged() {
    const owner = JSON.stringify([state.account?.username, state.token]);
    const nextKey = state.sessionId && state.session ? JSON.stringify([state.sessionId, state.session.engine, state.session.database, state.session.host]) : null;
    const nextReady = Boolean(nextKey && state.sessionReady);
    const nextConnection = nextReady ? state.session.created_at : null;
    if (identity === owner && key === nextKey && ready === nextReady && connection === nextConnection) return;
    if (identity !== owner) snapshots.clear();
    else if (query && view) view.scroll = treeScroll;
    else persistScroll();
    interrupt();
    closeObject(false);
    identity = owner;
    key = nextKey;
    ready = nextReady;
    connection = nextConnection;
    view = key ? snapshots.get(key) : null;
    if (key && !view) {
      view = { type: "", scopes: [], tableCounts: null, primary: "", open: new Set(), pages: new Map(), searchPages: new Map(), details: new Map(), scroll: 0, loadedAt: 0, connectedAt: nextConnection };
      snapshots.set(key, view);
      if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
    }
    if (ready && view.connectedAt !== nextConnection) {
      view.connectedAt = nextConnection;
      view.tableCounts = null;
      view.pages.clear();
      view.searchPages.clear();
      view.details.clear();
    }
    query = "";
    search.value = "";
    deep = false;
    fieldToggle.setAttribute("aria-pressed", "false");
    search.placeholder = "搜索库、表名或表注释";
    filter.value = view?.type ?? "";
    results.replaceChildren();
    results.hidden = true;
    tree.hidden = false;
    tree.replaceChildren();
    groups.clear();
    body.scrollTop = 0;
    loadingScopes = false;
    scopeError = "";
    refreshPages = false;
    if (view?.loadedAt) renderTree({ load: false });
    updateStatus();
    if (ready) void loadScopes();
  }

  refresh.onclick = () => {
    if (!ready) return;
    const y = query ? treeScroll : body.scrollTop;
    interrupt();
    closeObject(false);
    view.pages.clear();
    view.searchPages.clear();
    view.details.clear();
    view.scroll = y;
    refreshPages = true;
    void loadScopes(true);
    renderTree({ load: false });
    if (query) setQuery(query, true);
  };
  search.oninput = () => setQuery(search.value.trim());
  fieldToggle.onclick = () => {
    if (!ready || !primaryScope()) return;
    deep = !deep;
    fieldToggle.setAttribute("aria-pressed", String(deep));
    search.placeholder = deep ? "搜索主库的表、字段或注释" : "搜索库、表名或表注释";
    setQuery(search.value.trim());
    search.focus();
  };
  filter.onchange = () => {
    if (!ready || view.type === filter.value) return;
    const reloadScopes = loadingScopes || !view.loadedAt;
    interrupt();
    closeObject(false);
    view.type = filter.value;
    view.pages.clear();
    view.scroll = treeScroll = 0;
    renderTree();
    if (query) setQuery(query);
    if (reloadScopes) void loadScopes(refreshPages);
    else updateStatus();
  };

  function highlight() {
    for (const row of body.querySelectorAll(".catalog-object")) row.setAttribute("aria-pressed", String(row.dataset.object === selected));
  }

  function closeObject(restoreFocus = true) {
    detailRun?.abort();
    if (drawer.open) drawer.close();
    if (restoreFocus && detailReturn?.isConnected && !panel.hidden) detailReturn.focus({ preventScroll: true });
    detailReturn = null;
    selected = null;
    highlight();
  }
  close.onclick = () => closeObject();
  drawer.addEventListener("cancel", (event) => { event.preventDefault(); closeObject(); });

  async function openObject(object, origin, fieldMatch) {
    if (!canBrowse()) return;
    detailRun?.abort();
    detailRun = new AbortController();
    const signal = detailRun.signal;
    selected = objectKey(object);
    detailReturn = origin;
    highlight();
    const fullName = qualifiedTableName(state.session.engine, object.schema, object.name);
    path.textContent = `${state.session.engine === "postgres" ? `${state.session.database} / ` : ""}${object.schema} · ${(kinds[object.kind] || [null, "对象"])[1]}`;
    objectTitle.textContent = object.name;
    copy.textContent = "复制完整表名";
    detailStatus.textContent = "";
    detailTabs.replaceChildren();
    detailBody.replaceChildren(make("p", "catalog-detail-empty", "读取对象详情…"));
    ask.disabled = !ready || object.kind === "sequence";
    ask.onclick = () => {
      const goal = document.querySelector("#goal");
      const prefix = `请分析 ${fullName}：`;
      goal.value = goal.value ? `${prefix}\n${goal.value}` : prefix;
      closeObject(false);
      goal.focus();
    };
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(fullName); if (!signal.aborted) copy.textContent = "已复制"; }
      catch { if (!signal.aborted) detailStatus.textContent = `请手动复制：${fullName}`; }
    };
    if (!drawer.open) drawer.show();
    close.focus({ preventScroll: true });
    try {
      let data = view.details.get(selected);
      if (ready && !data) {
        data = await api(url("object", { schema: object.schema, name: object.name, ...(refreshPages ? { refresh: "true" } : {}) }), { signal });
        if (signal.aborted) return;
        view.details.set(selected, data);
        if (view.details.size > 30) view.details.delete(view.details.keys().next().value);
      }
      if (!data) {
        detailBody.replaceChildren(make("p", "catalog-detail-empty", "此对象没有缓存详情。恢复分析后可查看实时字段。"));
        return;
      }
      renderDetail(data, fieldMatch);
    } catch (error) {
      if (!signal.aborted) detailBody.replaceChildren(make("p", "catalog-detail-empty", `无法读取对象详情：${error.message}`));
    }
  }

  function renderDetail(data, fieldMatch) {
    let fieldFilter = fieldMatch;
    const tabs = [["fields", `字段 · ${data.columns.length}`], ["links", "关联"], ["overview", "概览"]];
    for (const [key, label] of tabs) {
      const tab = button(label, "catalog-detail-tab");
      tab.onclick = () => selectTab(key);
      tab.dataset.tab = key;
      detailTabs.append(tab);
    }
    function selectTab(key) {
      detailBody.replaceChildren();
      detailBody.scrollTop = 0;
      for (const tab of detailTabs.children) tab.setAttribute("aria-pressed", String(tab.dataset.tab === key));
      if (key === "links") {
        detailBody.append(make("h3", "", "已声明的外键（出向）"));
        if (!data.foreignKeys.length) {
          const note = state.session.capabilities?.engineProfile?.foreignKeys === false
            ? "当前引擎不提供外键元数据。字段同名不代表可以直接 JOIN。"
            : "未读到已声明的外键。字段同名不代表可以直接 JOIN。";
          detailBody.append(make("p", "muted", note));
        }
        for (const fk of data.foreignKeys) {
          const line = make("div", "catalog-link");
          line.append(make("strong", "", fk.name), make("code", "", `${fk.columns.join(", ")} → ${fk.references}${fk.referencedColumns?.length ? ` (${fk.referencedColumns.join(", ")})` : ""}`));
          detailBody.append(line);
        }
      } else if (key === "overview") {
        for (const [label, value] of [
          ["对象说明", data.object.comment || "未填写"], ["行数估算", data.object.rowEstimate?.toLocaleString() ?? "未提供"],
          ["主键", data.primaryKey.join("、") || "未声明"], ["分区键", data.partitionKey || "未提供"],
          ["索引", data.indexes.map((item) => `${item.name} (${item.columns.join(", ")})`).join("\n") || "未提供"],
        ]) {
          const row = make("div", "catalog-overview-row");
          row.append(make("span", "muted", label), make("span", "", value));
          detailBody.append(row);
        }
      } else {
        const fields = make("input", "catalog-field-search");
        fields.type = "search";
        fields.placeholder = "筛选字段名、类型或注释";
        fields.setAttribute("aria-label", "筛选字段");
        fields.value = fieldFilter;
        const tableWrap = make("div", "catalog-field-wrap");
        const table = make("table", "data-grid catalog-field-table");
        const head = table.createTHead().insertRow();
        for (const label of ["字段", "类型", "键", "可空", "注释"]) head.append(make("th", "", label));
        const rows = table.createTBody();
        const primary = new Set(data.primaryKey), foreign = new Set(data.foreignKeys.flatMap((fk) => fk.columns));
        tableWrap.append(table);
        const empty = make("p", "catalog-detail-empty");
        detailBody.append(fields, tableWrap, empty);
        fields.oninput = () => {
          fieldFilter = fields.value;
          const needle = fieldFilter.trim().toLowerCase();
          const matched = data.columns.filter((col) => {
            const values = fieldMatch && fieldFilter === fieldMatch ? [col.name, col.comment] : [col.name, col.type, col.comment];
            return values.some((value) => value?.toLowerCase().includes(needle));
          });
          rows.replaceChildren();
          empty.textContent = matched.length ? "" : "没有匹配的字段。";
          tableWrap.hidden = !matched.length;
          for (const col of matched) {
            const row = rows.insertRow();
            const field = make("th", "mono", col.name);
            field.scope = "row";
            row.append(field, make("td", "mono", col.type), make("td", "catalog-field-keys", [primary.has(col.name) && "PK", foreign.has(col.name) && "FK"].filter(Boolean).join(" · ") || "—"),
              make("td", "", col.nullable ? "是" : "否"), make("td", "", col.comment || "—"));
          }
        };
        fields.oninput();
      }
    }
    selectTab("fields");
  }

  body.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const items = [...body.querySelectorAll("summary, .catalog-object, .catalog-more")].filter((node) => node.getClientRects().length);
    const index = items.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    items[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key === "Escape" && drawer.open && !document.querySelector("dialog[open]:modal")) {
      event.preventDefault();
      closeObject();
    } else if (event.key === "Escape" && event.target === search && search.value) {
      event.preventDefault();
      search.value = "";
      setQuery("");
    } else if (event.key === "/" && ready && !drawer.open && !document.querySelector("dialog[open]") &&
      !event.target.closest?.("input, textarea, select, [contenteditable]")) {
      event.preventDefault();
      reveal();
      search.focus();
    }
  });
  return { sessionChanged, close: () => closeObject(false) };
}
