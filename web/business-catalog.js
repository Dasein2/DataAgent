const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };

export function initBusinessCatalog({ api, state, panel, changed }) {
  const section = el("details"); section.className = "business-catalog"; section.hidden = true;
  const summary = el("summary", "已发布业务口径与灰度");
  const content = el("div"), notice = el("p"); notice.className = "muted"; notice.setAttribute("role", "status");
  section.append(summary, notice, content); panel.prepend(section);
  const path = id => `/v1/sessions/${encodeURIComponent(id)}/business-catalog`;
  let revision = 0, previous, busy = false;

  async function load() {
    const id = state.sessionId, stamp = ++revision;
    if (!id || section.hidden || !section.open) return;
    const current = () => state.sessionId === id && revision === stamp;
    notice.textContent = "读取已发布版本…";
    try {
      const data = await api(path(id));
      if (!current()) return;
      content.replaceChildren();
      notice.textContent = data.enabled ? "试点已启用" : "探索模式（无正式核验）";
      const versions = el("select"); versions.setAttribute("aria-label", "选择业务定义版本");
      for (const v of data.versions) { const o = el("option", `${v.domain} · ${v.reviewer ? '已签认' : '草稿'} · ${v.at}`); o.value = v.id; versions.append(o); }
      if (data.active) versions.value = data.active;
      const details = el("pre"); details.className = "sql-code";
      function action(label, fn) {
        const b = el("button", label); b.className = "ghost"; b.type = "button";
        b.onclick = async () => {
          if (!current() || busy) return;
          busy = true; b.disabled = true;
          try { await fn(); }
          catch (error) { if (current()) notice.textContent = error.message; }
          finally { b.disabled = false; busy = false; }
        };
        return b;
      }
      const inspect = action("查看口径和核验证据", async () => {
        if (!versions.value) return;
        const v = await api(`${path(id)}/${versions.value}`);
        if (current()) details.textContent = JSON.stringify(v.catalog, null, 2);
      });
      if (data.versions.length) content.append(versions, inspect, details);
      if (!state.account || state.account.role === "admin") {
        const edit = el("textarea"); edit.rows = 6; edit.placeholder = "粘贴业务目录 JSON；保存草稿不会执行业务 SELECT"; edit.setAttribute("aria-label", "业务目录 JSON");
        const reviewer = el("input"); reviewer.placeholder = "签认的数据负责人"; reviewer.setAttribute("aria-label", "签认的数据负责人");
        const form = el("details"); form.append(el("summary", "提交草稿／签认发布"), el("p", "先对照样例和独立参考值，再签认。发布新版默认关闭灰度。"), edit,
          action("保存草稿", async () => { await api(path(id), { method: "POST", body: JSON.parse(edit.value) }); await load(); }), reviewer,
          action("签认所选版本", async () => { if (!versions.value || !reviewer.value.trim()) throw new Error("请选择版本并填写实际签认人"); await api(`${path(id)}/${versions.value}/publish`, { method: "POST", body: { reviewer: reviewer.value } }); await changed(); }));
        content.append(form);
        if (data.active) content.append(action(data.enabled ? "回切探索模式" : "启用本连接试点", async () => { await api(`/v1/sessions/${id}/business-pilot`, { method: "PUT", body: { enabled: !data.enabled } }); await changed(); }));
      }
    } catch (error) { if (current()) notice.textContent = error.message; }
  }
  section.addEventListener("toggle", () => { if (section.open) void load(); });
  return { sessionChanged(force = false) {
    const visible = Boolean(state.sessionReady && state.session?.business_pilot);
    const key = visible ? `${state.sessionId}:${state.session.business_pilot.enabled}` : null;
    section.hidden = !visible;
    if (!force && key === previous) return;
    previous = key; revision++; content.replaceChildren(); notice.textContent = "";
    if (visible && section.open) void load();
  } };
}
