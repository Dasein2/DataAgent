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
  let hits = [], highlighted = 0, match;
  const pg = () => state.session?.engine === "postgres";
  const currentScope = () => scope || state.session?.default_scope || (!pg() && state.session?.database) || "";
  const url = suffix => `/v1/sessions/${encodeURIComponent(session)}/catalog/${suffix}`;
  function closeMenus() {
    ++serial; clearTimeout(timer); picker.hidden = mention.hidden = true;
    toggle.setAttribute("aria-expanded", "false"); goal.removeAttribute("aria-activedescendant");
    hits = []; match = null;
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
    if (!at || at.start !== match?.start || at.end !== match?.end || at.query !== match.query) { closeMenus(); return; }
    const q = pg() ? '"' : '`';
    const token = '@' + [table.schema, table.name].map(s => q + s.replaceAll(q, q + q) + q).join('.');
    tables = tables.filter(t => goal.value.includes(t.token));
    if (!tables.some(t => t.token === token)) {
      if (tables.length >= 20) { status(mention, "每条消息最多引用 20 张表"); return; }
      tables.push({ schema: table.schema, name: table.name, token });
    }
    goal.setRangeText(token + " ", at.start, at.end, "end"); closeMenus(); goal.focus(); goal.dispatchEvent(new Event("input"));
  }
  function markActive() {
    [...mention.querySelectorAll("button")].forEach((node, i) => node.setAttribute("aria-selected", String(i === highlighted)));
    const target = byId(`tableOption${highlighted}`);
    if (target) { goal.setAttribute("aria-activedescendant", target.id); target.scrollIntoView({ block: "nearest" }); }
  }
  function findTables() {
    closeMenus();
    if (blocked || goal.selectionStart !== goal.selectionEnd) return;
    match = mentionAtCursor(goal.value, goal.selectionStart); if (!match) return;
    mention.hidden = false; const ticket = serial, query = match.query;
    const schema = currentScope();
    if (!schema) { status(mention, "请先选择目标库或 Schema"); return; }
    status(mention, "正在查找数据表…");
    timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ schema, type: "table", search: query, limit: "30" });
        const data = await api(url("objects?" + params)); if (ticket !== serial) return;
        hits = data.objects; highlighted = 0;
        if (!hits.length) { status(mention, "当前库没有匹配的数据表"); return; }
        mention.replaceChildren(...hits.map((table, i) => {
          const b = row(table.name, i === 0, () => pick(table)); b.id = `tableOption${i}`; b.title = `${table.schema}.${table.name}`; return b;
        }));
        goal.setAttribute("aria-activedescendant", "tableOption0");
      } catch (error) { if (ticket === serial) status(mention, error.message); }
    }, 130);
  }
  goal.addEventListener("input", e => { if (!e.isComposing) findTables(); });
  goal.addEventListener("click", findTables);
  goal.addEventListener("compositionend", findTables);
  goal.addEventListener("keyup", e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) findTables(); });
  goal.addEventListener("keydown", e => {
    if (mention.hidden || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); closeMenus(); }
    if (e.key === "Tab") { closeMenus(); return; }
    if (["ArrowDown", "ArrowUp"].includes(e.key) && hits.length) {
      e.preventDefault(); highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length; markActive();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); if (hits[highlighted]) pick(hits[highlighted]); else closeMenus(); }
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
