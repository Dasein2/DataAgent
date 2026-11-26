// Per-session composer selections. The server resolves references using the active connection.
export function mentionAtCursor(value, cursor) {
  const match = /(?:^|[^\w@])@([\p{L}\p{M}\p{N}_$-]{0,120})$/u.exec(value.slice(0, cursor));
  return match && { start: cursor - match[1].length - 1, end: cursor, query: match[1] };
}

export function initComposerContext({ api, state }) {
  const byId = id => document.getElementById(id);
  const goal = byId("goal"), toggle = byId("scopeToggle"), picker = byId("scopePicker");
  const search = byId("scopeSearch"), choices = byId("scopeChoices"), mention = byId("tablePicker");
  const quoteBar = byId("replyPreview"), excerpt = byId("replyExcerpt");
  const drafts = new Map();
  let session, scope, quote, tables = [], scopes = [], blocked = true, serial = 0, timer;
  let hits = [], highlighted = 0, match, page;
  const pg = () => state.session?.engine === "postgres";
  const currentScope = () => scope || state.session?.default_scope || (!pg() && state.session?.database) || "";
  const url = suffix => `/v1/sessions/${encodeURIComponent(session)}/catalog/${suffix}`;
  function closeMenus() {
    ++serial; clearTimeout(timer); picker.hidden = mention.hidden = true;
    page?.controller.abort(); page = null;
    toggle.setAttribute("aria-expanded", "false"); goal.removeAttribute("aria-activedescendant");
    hits = []; highlighted = 0; match = null;
  }
  function label() {
    byId("scopeName").textContent = currentScope() || (pg() ? "选择 Schema" : "选择数据库");
    toggle.title = pg() ? "选择当前连接的目标 Schema" : "选择当前连接的目标数据库";
    quoteBar.hidden = !quote || Boolean(state.clarificationInput);
    excerpt.textContent = quote?.text || ""; excerpt.title = excerpt.textContent;
  }
  function setQuote(id, text) {
    quote = id ? { id, text: text.trim().replace(/\s+/g, " ").slice(0, 180) } : undefined;
    label(); goal.focus();
  }
  byId("clearReply").onclick = () => setQuote();
  function update(disabled) {
    if (session !== state.sessionId) {
      if (session) drafts.set(session, { scope, quote, tables });
      session = state.sessionId;
      ({ scope, quote, tables = [] } = drafts.get(session) || {});
      scopes = []; closeMenus();
    }
    blocked = disabled; toggle.disabled = disabled;
    if (disabled) closeMenus();
    label();
  }
  function status(list, text) {
    const node = document.createElement("p"); node.className = "context-note"; node.textContent = text;
    list.replaceChildren(node);
  }
  function row(text, selected, choose) {
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(selected)); b.textContent = text; b.title = text;
    b.onmousedown = event => event.preventDefault(); b.onclick = choose; return b;
  }
  function renderScopes() {
    const visible = scopes.filter(name => name.toLowerCase().includes(search.value.toLowerCase()));
    choices.replaceChildren(...visible.map(name => row(name, name === currentScope(), () => {
      scope = name; closeMenus(); label(); goal.focus();
    })));
    if (!visible.length) status(choices, "没有匹配的库或 Schema");
  }
  toggle.onclick = async () => {
    const open = picker.hidden; closeMenus(); if (!open || blocked) return;
    picker.hidden = false; toggle.setAttribute("aria-expanded", "true"); search.value = ""; search.focus();
    const ticket = serial; status(choices, "正在读取…");
    try {
      const data = await api(url("scopes")); if (ticket !== serial) return;
      scopes = data.scopes; scope ||= data.default_scope; label(); renderScopes();
    } catch (error) { if (ticket === serial) status(choices, error.message); }
  };
  search.oninput = renderScopes;
  picker.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { closeMenus(); toggle.focus(); return; }
    const rows = [...choices.querySelectorAll("button")];
    if (event.key === "Enter" && document.activeElement === search) { event.preventDefault(); rows[0]?.click(); }
    if (rows.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); const i = rows.indexOf(document.activeElement);
      rows[i < 0 ? event.key === "ArrowDown" ? 0 : rows.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
    }
  };
  function pick(table) {
    const at = mentionAtCursor(goal.value, goal.selectionStart);
    if (!page || !activePage(page) || !at) { closeMenus(); return; }
    const q = pg() ? '"' : '`';
    const token = '@' + [table.schema, table.name].map(s => q + s.replaceAll(q, q + q) + q).join('.');
    tables = tables.filter(t => goal.value.includes(t.token));
    if (!tables.some(t => t.token === token)) {
      if (tables.length >= 20) {
        page.controller.abort(); page = null;
        hits = [];
        goal.removeAttribute("aria-activedescendant");
        status(mention, "每条消息最多引用 20 张表");
        return;
      }
      tables.push({ schema: table.schema, name: table.name, token });
    }
    goal.setRangeText(token + " ", at.start, at.end, "end"); closeMenus(); goal.focus(); goal.dispatchEvent(new Event("input"));
  }
  function markActive({ scroll = true } = {}) {
    mention.querySelectorAll("button").forEach((node, i) => node.setAttribute("aria-selected", String(i === highlighted)));
    const target = byId(`tableOption${highlighted}`);
    if (target) {
      goal.setAttribute("aria-activedescendant", target.id);
      if (scroll) target.scrollIntoView({ block: "nearest" });
    } else goal.removeAttribute("aria-activedescendant");
  }
  function activePage(p) {
    if (p !== page || blocked || mention.hidden || p.session !== state.sessionId || p.schema !== currentScope()) return false;
    const at = mentionAtCursor(goal.value, goal.selectionStart);
    return Boolean(at && match && goal.selectionStart === goal.selectionEnd &&
      at.start === match.start && at.end === match.end && at.query === match.query);
  }
  function pageFooter(p) {
    if (p.nextOffset === null) {
      p.footer?.remove(); p.footer = null;
    } else {
      // Keep the same button during the request so its click still bubbles inside the picker.
      if (!p.footer) {
        p.footer = row("", false, () => void loadMentionPage(p, true));
        p.footer.className = "context-more";
        mention.append(p.footer);
      }
      const more = p.footer;
      more.id = `tableOption${hits.length}`;
      more.textContent = p.loading ? "正在加载…" : p.error ? "加载失败，点击重试" : `加载更多（已加载 ${hits.length} 张）`;
      more.disabled = p.loading;
      more.title = p.error || "继续读取当前库的匹配表；也可在 @ 后输入表名搜索";
      more.setAttribute("aria-busy", String(p.loading));
    }
    markActive({ scroll: false });
  }
  async function loadMentionPage(p, keyboard = false) {
    if (!activePage(p) || p.loading || p.nextOffset === null) return;
    const offset = p.nextOffset, previousLength = hits.length;
    p.loading = true; p.error = "";
    if (hits.length || p.footer) pageFooter(p);
    try {
      const params = new URLSearchParams({ schema: p.schema, type: "table", search: p.query, limit: "30", offset: String(offset) });
      const data = await api(url("objects?" + params), { signal: p.controller.signal });
      if (!activePage(p)) return;
      if (data.nextOffset !== null && (!Number.isInteger(data.nextOffset) || data.nextOffset <= offset))
        throw new Error("目录分页结果无效，请重试");
      const seen = new Set(hits.map(t => JSON.stringify([t.schema, t.name])));
      const added = [];
      for (const table of data.objects) {
        const key = JSON.stringify([table.schema, table.name]);
        if (table.schema === p.schema && !seen.has(key)) { seen.add(key); added.push(table); }
      }
      const scrollTop = mention.scrollTop;
      if (!hits.length) mention.replaceChildren();
      p.footer?.remove(); p.footer = null;
      for (const table of added) {
        const button = row(table.name, hits.length === highlighted, () => pick(table));
        button.id = `tableOption${hits.length}`; button.title = `${table.schema}.${table.name}`;
        hits.push(table); mention.append(button);
      }
      p.nextOffset = data.nextOffset;
      if (!hits.length && p.nextOffset === null) status(mention, "当前库没有匹配的数据表");
      // Append instead of rebuilding previous rows, keeping the user's scroll and highlight.
      mention.scrollTop = scrollTop;
      if (keyboard && added.length) highlighted = previousLength;
      else if (p.nextOffset === null) highlighted = Math.min(highlighted, Math.max(0, hits.length - 1));
    } catch (error) {
      if (!activePage(p)) return;
      p.error = error.message;
      if (!hits.length) {
        p.footer = null;
        status(mention, `搜索失败：${p.error}`);
      }
    } finally {
      if (activePage(p)) {
        p.loading = false; pageFooter(p);
        if (keyboard && hits.length > previousLength) markActive();
      }
    }
  }
  function findTables() {
    closeMenus();
    if (blocked || goal.selectionStart !== goal.selectionEnd) return;
    match = mentionAtCursor(goal.value, goal.selectionStart); if (!match) return;
    mention.hidden = false; mention.scrollTop = 0;
    const schema = currentScope();
    if (!schema) { status(mention, "请先选择目标库或 Schema"); return; }
    status(mention, "正在查找数据表…");
    const p = page = { session, schema, query: match.query, nextOffset: 0,
      loading: false, error: "", footer: null, controller: new AbortController() };
    timer = setTimeout(() => void loadMentionPage(p), 130);
  }
  mention.addEventListener("scroll", () => {
    if (page && !page.error && !page.loading && mention.scrollHeight > mention.clientHeight &&
        mention.scrollTop + mention.clientHeight >= mention.scrollHeight - 24) void loadMentionPage(page);
  }, { passive: true });
  goal.addEventListener("input", e => { if (e.isComposing) closeMenus(); else findTables(); });
  goal.addEventListener("click", findTables);
  goal.addEventListener("compositionend", findTables);
  goal.addEventListener("keyup", e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) findTables(); });
  goal.addEventListener("keydown", e => {
    if (mention.hidden || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); closeMenus(); }
    if (e.key === "Tab") { closeMenus(); return; }
    const count = hits.length + (page?.footer ? 1 : 0);
    if (["ArrowDown", "ArrowUp"].includes(e.key) && count) {
      e.preventDefault(); highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + count) % count; markActive();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (hits[highlighted]) pick(hits[highlighted]);
      else if (page?.footer) void loadMentionPage(page, true);
    }
  });
  document.addEventListener("click", e => { if (!e.target.closest("#scopeControl, #goal, #tablePicker")) closeMenus(); });
  return { update, setQuote,
    request() {
      const selected = tables.filter(t => goal.value.includes(t.token)).map(({ schema, name }) => ({ schema, name }));
      const value = { ...(quote && { reply_to: quote.id }), ...(currentScope() && { target_scope: currentScope() }), ...(selected.length && { tables: selected }) };
      return Object.keys(value).length ? value : undefined;
    },
    take() { const saved = { quote, tables }; quote = undefined; tables = []; closeMenus(); label(); return saved; },
    restore(saved) { quote = saved.quote; tables = saved.tables; label(); },
  };
}
