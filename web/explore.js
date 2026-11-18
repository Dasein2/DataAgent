const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const cell = (value) =>
  value === null || value === undefined
    ? "NULL"
    : value === ""
      ? '""'
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

/** Bounded server pages, never mistake page-local sorting/filtering for a full-result operation. */
export function createExplorer({ api, downloadFile, refreshContext = () => {} }) {
  let dialog,
    sequence = 0;
  return async function openResult(id) {
    sequence++;
    dialog?.close();
    dialog?.remove();
    const previousFocus = document.activeElement;
    dialog = el("dialog", "explorer");
    dialog.setAttribute("aria-label", "查询结果工作台");
    const current = dialog;
    const header = el("header", "explore-head");
    header.append(el("div", "explore-title", "结果工作台"), el("code", "muted", id));
    const close = el("button", "ghost", "关闭 Esc");
    close.onclick = () => current.close();
    header.append(close);
    const meta = el("div", "explore-meta");
    const warning = el("div", "quality-banner");
    warning.hidden = true;
    const tools = el("div", "explore-tools");
    const prev = el("button", "ghost", "← 上一页"),
      next = el("button", "ghost", "下一页 →");
    const position = el("span", "mono");
    const limit = el("select");
    limit.setAttribute("aria-label", "每页行数");
    [50, 100, 200, 500].forEach((v) => {
      const o = el("option", "", String(v) + " 行 / 页");
      o.value = String(v);
      limit.append(o);
    });
    limit.value = "100";
    const jump = el("input");
    jump.type = "number";
    jump.min = "1";
    jump.placeholder = "跳至行";
    jump.setAttribute("aria-label", "跳至第几行");
    const go = el("button", "ghost", "跳转");
    const filter = el("input");
    filter.placeholder = "过滤当前页（不影响完整结果）";
    filter.setAttribute("aria-label", "过滤当前页");
    const csv = el("button", "ghost", "下载 CSV"),
      stats = el("button", "ghost", "列统计"),
      pin = el("button", "ghost", "固定本地快照");
    tools.append(prev, next, position, limit, jump, go, filter, stats, pin, csv);
    const source = el("details", "source-sql");
    source.append(el("summary", "", "完整 SQL · 查询时间 ≠ 数据更新时间"));
    const pre = el("pre", "sql-code");
    source.append(pre);
    const copy = el("button", "ghost", "复制 SQL");
    source.append(copy);
    const summary = el("div", "result-statistics");
    summary.hidden = true;
    const columnControls = el("details", "column-controls");
    columnControls.append(el("summary", "", "显示字段（仅展示，不修改已保存结果）"));
    const columnChoices = el("div", "column-choices");
    columnControls.append(columnChoices);
    const viewport = el("div", "explore-viewport");
    viewport.tabIndex = 0;
    viewport.setAttribute("aria-label", "结果数据，可横向滚动");
    const local = el("details", "source-sql");
    local.append(el("summary", "", "本地 SQL 分析 · 不再查询源库"));
    local.append(
      el(
        "p",
        "muted",
        "使用 PostgreSQL SELECT 查询表 data。支持聚合、排序、TopN、窗口函数；产生带来源链的新结果。只接受完整且在本地行数/字节上限内的输入。",
      ),
    );
    const editor = el("textarea");
    editor.value = "SELECT * FROM data LIMIT 100";
    editor.rows = 3;
    editor.setAttribute("aria-label", "本地分析 SQL");
    const run = el("button", "primary", "执行本地分析");
    local.append(editor, run);
    const status = el("p", "muted");
    status.setAttribute("role", "status");
    current.append(header, meta, warning, tools, columnControls, source, summary, viewport, local, status);
    document.body.append(current);
    current.addEventListener(
      "close",
      () => {
        current.remove();
        if (dialog === current) {
          sequence++;
          dialog = undefined;
          if (previousFocus?.isConnected) previousFocus.focus?.();
        }
      },
      { once: true },
    );
    current.showModal();
    close.focus();
    let page,
      offset = 0,
      sortIndex = -1,
      descending = false;
    const hiddenColumns = new Set();
    const render = () => {
      if (!page) return;
      const rows = page.rows.filter(
        (r) => !filter.value || r.some((v) => cell(v).toLowerCase().includes(filter.value.toLowerCase())),
      );
      if (sortIndex >= 0)
        rows.sort(
          (a, b) =>
            cell(a[sortIndex]).localeCompare(cell(b[sortIndex]), undefined, {
              numeric: true,
            }) * (descending ? -1 : 1),
        );
      const table = el("table", "data-grid");
      const thead = el("thead"),
        tr = el("tr");
      tr.append(el("th", "row-number", "#"));
      page.columns.forEach((c, i) => {
        if (hiddenColumns.has(i)) return;
        const th = el("th");
        const b = el("button", "column-sort", c.name + (sortIndex === i ? (descending ? " ↓" : " ↑") : ""));
        b.title = "仅对当前页排序；完整排序请使用本地 SQL 或源 SQL";
        b.onclick = () => {
          descending = sortIndex === i ? !descending : false;
          sortIndex = i;
          render();
        };
        th.append(b, el("small", "muted", c.type));
        th.style.resize = "horizontal";
        th.style.overflow = "auto";
        tr.append(th);
      });
      thead.append(tr);
      table.append(thead);
      const body = el("tbody");
      rows.forEach((r) => {
        const tr = el("tr");
        tr.append(el("td", "row-number", String(page.offset + page.rows.indexOf(r) + 1)));
        r.forEach((v, i) => {
          if (hiddenColumns.has(i)) return;
          const td = el(
            "td",
            v == null
              ? "null-cell"
              : typeof v === "number" || (typeof v === "string" && /^[+-]?\d+(\.\d+)?$/.test(v))
                ? "numeric-cell"
                : "",
            cell(v),
          );
          td.title = cell(v);
          tr.append(td);
        });
        body.append(tr);
      });
      table.append(body);
      viewport.replaceChildren(table);
      status.textContent = `当前页 ${rows.length} / ${page.rows.length} 行。页面过滤/排序只作用于当前页；NULL 与空字符串分别显示。`;
    };
    const load = async () => {
      const token = ++sequence;
      prev.disabled = next.disabled = true;
      viewport.setAttribute("aria-busy", "true");
      status.textContent = "读取已保存结果…";
      try {
        const p = await api(`/v1/results/${encodeURIComponent(id)}?offset=${offset}&limit=${limit.value}`);
        if (token !== sequence || !current.open) return;
        page = p;
        sortIndex = -1;
        filter.value = "";
        if (!columnChoices.childElementCount)
          p.columns.forEach((c, i) => {
            const label = el("label", "checkbox-label"),
              check = el("input");
            check.type = "checkbox";
            check.checked = true;
            check.onchange = () => {
              check.checked ? hiddenColumns.delete(i) : hiddenColumns.add(i);
              render();
            };
            label.append(check, document.createTextNode(c.name));
            columnChoices.append(label);
          });
        position.textContent = `${p.offset + (p.rows.length ? 1 : 0)}–${p.offset + p.rows.length} / ${p.rowCount.toLocaleString()}`;
        meta.textContent = `${p.rowCount.toLocaleString()} 行 · ${p.columns.length} 列 · ${p.durationMs ?? "—"} ms · ${((p.bytes ?? 0) / 1024).toFixed(1)} KB · 执行于 ${p.createdAt} · 时区 ${p.timezone ?? "未指定"}`;
        pre.textContent = p.sql ?? "";
        copy.onclick = () =>
          navigator.clipboard.writeText(p.sql ?? "").catch(() => {
            status.textContent = "复制失败，请手动选择 SQL";
          });
        warning.hidden = p.truncated === "none";
        warning.textContent = `不完整结果：因 ${p.truncated} 上限被截断。分页、CSV、本地统计都无法恢复未保存的数据；请缩小范围或先聚合再查询。`;
        csv.textContent = p.truncated === "none" ? "下载完整 CSV" : "下载 CSV（不完整）";
        if (p.lineage) meta.textContent += ` · 派生自 ${p.lineage.parent_result_id}`;
        prev.disabled = p.offset === 0;
        next.disabled = p.nextOffset == null;
        pin.disabled = p.truncated !== "none";
        render();
        viewport.scrollTop = 0;
      } catch (error) {
        if (token === sequence) status.textContent = error.message;
      } finally {
        if (token === sequence) viewport.removeAttribute("aria-busy");
      }
    };
    prev.onclick = () => {
      offset = Math.max(0, offset - Number(limit.value));
      void load();
    };
    next.onclick = () => {
      if (page?.nextOffset != null) {
        offset = page.nextOffset;
        void load();
      }
    };
    limit.onchange = () => {
      offset = 0;
      void load();
    };
    go.onclick = () => {
      const row = Number(jump.value);
      if (page && Number.isInteger(row) && row >= 1 && row <= page.rowCount) {
        offset = row - 1;
        void load();
      } else status.textContent = "请输入结果范围内的行号";
    };
    jump.onkeydown = (e) => {
      if (e.key === "Enter") go.click();
    };
    filter.oninput = render;
    csv.onclick = () =>
      downloadFile(`/v1/results/${id}/data.csv`, id + ".csv").catch((e) => {
        status.textContent = e.message;
      });
    stats.onclick = async () => {
      if (!summary.hidden) {
        summary.hidden = true;
        return;
      }
      summary.hidden = false;
      summary.textContent = "计算已保存行的统计…";
      try {
        const s = await api(`/v1/results/${id}/summary`);
        if (!current.open) return;
        summary.replaceChildren(el("p", "muted", s.scope));
        const t = el("table", "data-grid");
        const h = el("tr");
        ["字段", "空值率", "去重数 / 下界", "数值范围（近似）"].forEach((v) => h.append(el("th", "", v)));
        t.append(h);
        for (const c of s.columns) {
          const r = el("tr");
          [
            c.name,
            (100 * (c.null_rate ?? 0)).toFixed(1) + "%",
            String(c.distinct) + (c.distinct_is_lower_bound ? "+" : ""),
            c.min_approx == null ? "—" : `${c.min_approx} – ${c.max_approx}`,
          ].forEach((v) => r.append(el("td", "", v)));
          t.append(r);
        }
        summary.append(t);
      } catch (e) {
        summary.textContent = e.message;
      }
    };
    pin.onclick = async () => {
      const name = prompt("本地快照名称", id);
      if (!name) return;
      try {
        await api(`/v1/sessions/${page.sessionId ?? ""}/snapshots`, {
          method: "POST",
          body: { result_id: id, name },
        });
        status.textContent = "快照已固定";
        void refreshContext();
      } catch (e) {
        status.textContent = e.message;
      }
    };
    run.onclick = async () => {
      run.disabled = true;
      status.textContent = "在隔离本地分析进程中执行…";
      try {
        const r = await api(`/v1/results/${id}/transform`, {
          method: "POST",
          body: { sql: editor.value },
        });
        void refreshContext();
        await openResult(r.result.id);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        run.disabled = false;
      }
    };
    await load();
  };
}
