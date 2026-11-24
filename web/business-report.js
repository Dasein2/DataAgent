const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (label, click, cls = "ghost") => { const b = el("button", label, cls); b.type = "button"; b.onclick = click; return b; };
const signed = value => value === null ? "—" : value.startsWith("-") ? "−" + value.slice(1) : value === "0" ? "0" : "+" + value;

export function businessTrendOption({ days, comparison, index, type, zoom, animation }) {
  const point = days[index];
  const current = days.map(d => d.current ? Number(d.current.value.value) : null);
  return {
    animation, tooltip: { trigger: "axis" }, legend: { top: 0 }, grid: { left: 59, right: 19, top: 37, bottom: days.length > 7 ? 65 : 38 },
    xAxis: { type: "category", data: days.map(d => d.day), axisLabel: { formatter: v => v.slice(5) } }, yAxis: { type: "value" },
    dataZoom: days.length > 7 ? [{ type: "slider", bottom: 8, ...zoom }, { type: "inside", ...zoom }] : [],
    series: [{ id: "current", name: "本期", type, color: "#256e64", showSymbol: true, symbolSize: 10, data: current,
      markPoint: { silent: true, data: point?.current ? [{ coord: [point.day, current[index]], symbolSize: 24 }] : [] } },
      ...(comparison ? [{ id: "comparison", name: "对比期", type: "line", lineStyle: { type: "dashed" }, data: days.map(d => d.comparison ? Number(d.comparison.value.value) : null) }] : [])],
  };
}

export function createBusinessReports({ api, ensureEcharts, openRef, state, refreshContext }) {
  async function render(host, id) {
    if ([...host.querySelectorAll("[data-business-result]")].some(n => n.dataset.businessResult === id)) return;
    const card = el("section", undefined, "business-report");
    card.dataset.businessResult = id;
    card.append(el("p", "正在读取已保存的分析结果…", "muted"));
    // Put the result before the transcript/activity; the chat stays available for follow-ups.
    host.prepend(card);
    try { mount(card, await api(`/v1/results/${encodeURIComponent(id)}/business-report`)); }
    catch (error) { card.replaceChildren(el("p", `无法读取结果：${error.message}`)); }
  }

  function mount(card, report) {
    const { metric, days, dimension, request } = report;
    const sessionId = state.sessionId;
    const dateRange = w => `${w.start} 至 ${w.end}（不含）`;
    const status = { verified: "✓ 已核验", limited: "◐ 限定范围", unconfirmed: "⚠ 待确认" }[report.status];
    const heading = el("h2", metric.label);
    const context = el("p", `${status} · ${dateRange(request.window)} · ${report.timezone}${request.comparison ? ` · 对比 ${dateRange(request.comparison)}` : ""}`, "muted");
    const definition = el("details");
    definition.append(el("summary", "指标口径与执行范围"), el("p", metric.definition), el("p", `负责人：${metric.owner} · 签认：${report.reviewer} · 版本：${report.version}`),
      el("p", `完整覆盖至：${report.complete_through ?? "待核验"} · 执行时间：${report.executed_at ?? "—"} · 结果：${report.result_id}`),
      el("p", report.tables.map(t => `${t.schema}.${t.name}（${t.grain}；键：${t.keys.join("、")}）`).join("；")));
    if (report.relations.length) {
      const list = el("ul");
      for (const r of report.relations) list.append(el("li", `${r.from} (${r.fromFields.join("、")}) → ${r.to} (${r.toFields.join("、")}) · ${r.purpose} · ${r.cardinality}；依据：${r.source}${r.check ? `（${dateRange(r.check.window)}，${r.check.inputRows} → ${r.check.outputRows} 行，重复 ${r.check.duplicateKeys}，未匹配 ${r.check.unmatchedRows}）` : ""}`));
      definition.append(el("p", "涉及的表关系"), list);
    }
    const headline = el("p", undefined, "business-headline");
    const reasons = el("p", report.reasons.join("；"), "muted");
    const select = el("select"); select.setAttribute("aria-label", "选择观察日期");
    for (const d of days) { const opt = el("option", d.day); opt.value = d.day; select.append(opt); }
    const controls = el("div", undefined, "business-actions");
    const layout = el("div", undefined, "business-figures");
    const trend = el("div", undefined, "business-trend"); trend.setAttribute("aria-label", "趋势图：也可用日期选择器操作");
    const channels = el("div", undefined, "business-channels");
    const supplement = el("div", undefined, "business-supplement");
    const hasTrend = request.grain === "day" && days.length > 1 && days.some(d => d.current || d.comparison);
    let type = "line", chart, index = Math.max(0, days.findLastIndex(d => d.current)), selectedChannel;
    select.selectedIndex = index;
    if (request.grain === "day" && days.length > 1) controls.append(select);
    if (hasTrend) layout.append(trend);
    layout.append(channels);
    card.replaceChildren(heading, context, headline, controls, layout, reasons, definition, supplement);
    const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cell = (label, datum, unit = metric.unit) => datum ? button(`${label}${datum.value} ${unit}`, () => openRef(datum.ref)) : el("span", `${label}—`);
    function breakdown(label, current, previous, change, currentDay, previousDay, deductions = []) {
      const dlg = el("dialog", undefined, "object-dialog business-evidence");
      dlg.setAttribute("aria-label", `${label}数值来源`);
      const head = el("header"); head.append(el("h2", label), button("关闭", () => dlg.close()));
      dlg.append(head);
      const values = el("div", undefined, "business-operands");
      for (const [day, entry] of [[currentDay, current], [previousDay, previous]]) {
        if (!day) continue;
        const side = el("section"); side.append(el("strong", day), cell("", entry?.value));
        if (entry?.numerator) side.append(cell(deductions.length || entry.deduction_count !== null ? "支付：" : "分子：", entry.numerator, deductions.length || entry.deduction_count !== null ? metric.unit : ""));
        if (entry?.denominator) side.append(cell(entry.deduction_count !== null ? "退款：" : "分母：", entry.denominator, entry.deduction_count !== null ? metric.unit : ""));
        values.append(side);
      }
      dlg.append(values);
      if (change !== null && current?.value && previous?.value) dlg.append(el("p", `${current.value.value} − ${previous.value.value} = ${change.replace(/^-/, "−")} ${report.measure === "ratio" && report.ratio_multiplier === 100 ? "个百分点" : metric.unit}`, "business-headline"));
      else if (current?.numerator && current?.denominator && current.deduction_count !== null) dlg.append(el("p", `${current.numerator.value} − ${current.denominator.value} = ${current.value.value} ${metric.unit}`, "business-headline"));
      deductions.forEach((datum, i) => dlg.append(cell(`退款 ${datum.label ?? i + 1}：`, datum)));
      dlg.append(el("p", "差额反映增减构成，不能单独证明原因。点操作数查看结果行、SQL 和执行时间。", "muted"));
      document.body.append(dlg); dlg.addEventListener("close", () => dlg.remove(), { once: true }); dlg.showModal();
    }

    function update() {
      const d = days[index];
      if (!d) return;
      const deltaUnit = report.measure === "ratio" && report.ratio_multiplier === 100 ? "个百分点" : metric.unit;
      const delta = d.change === null ? "" : `，${request.comparison ? "较对比期" : "较前日"}${d.change === "0" ? "持平" : `${d.change.startsWith("-") ? "减少" : "增加"} ${d.change.replace(/^-/, "")} ${deltaUnit}`}${d.comparison_zero ? "（基期为 0，不计算相对变化率）" : ""}`;
      headline.replaceChildren(d.current ? button(`${d.current.value.value} ${metric.unit}${delta}`, () => breakdown(metric.label, d.current, d.comparison, d.change, d.day, d.comparison_day, d.deductions), "ghost business-total")
        : el("span", report.empty ? "该范围未返回数据（不等于零）" : "该日期没有可展示的总数"));
      channels.replaceChildren();
      if (dimension) channels.append(el("h3", `${dimension.label}${d.breakdown_comparable ? "增减" : "明细"}`));
      if (dimension && !dimension.additive) channels.append(el("p", "各组不可加总；点分组查看数值及可用的分子、分母。", "muted"));
      if (dimension && !d.channels.length) channels.append(el("p", "该日期无已保存分组。", "muted"));
      if (d.breakdown_comparable) channels.append(el("p", `统一刻度：±${report.max_change} ${metric.unit}；中线为 0`, "muted"));
      for (const c of d.channels) {
        const b = button(undefined, () => {
          selectedChannel = c.key;
          for (const peer of channels.querySelectorAll(".business-channel")) peer.setAttribute("aria-pressed", String(peer === b));
          breakdown(c.label, c.current, c.comparison, c.change, d.day, d.comparison_day);
        }, "business-channel");
        b.setAttribute("aria-pressed", String(selectedChannel === c.key));
        b.append(el("span", c.label));
        if (d.breakdown_comparable) {
          const axis = el("span", undefined, "business-axis");
          const bar = el("span", undefined, "business-bar" + (Number(c.change) < 0 ? " negative" : ""));
          bar.style.width = `${report.max_change ? Math.min(50, 50 * Math.abs(Number(c.change)) / report.max_change) : 0}%`;
          axis.append(bar); b.append(axis, el("strong", `${signed(c.change)} ${metric.unit}`));
        } else b.append(el("strong", `${c.current?.value?.value ?? "—"} / ${c.comparison?.value?.value ?? "—"} ${metric.unit}`));
        channels.append(b);
      }
      if (chart) chart.setOption({ animationDurationUpdate: reduced() ? 0 : 240, series: [{ id: "current", markPoint: { data: d.current ? [{ coord: [d.day, Number(d.current.value.value)], symbolSize: 24 }] : [] } }] });
    }
    select.onchange = () => { index = select.selectedIndex; selectedChannel = undefined; update(); };
    update();

    if (hasTrend) {
      void ensureEcharts().then(echarts => {
        if (!card.isConnected) return;
        chart = echarts.init(trend, null, { renderer: "svg" });
        const optionForView = (animation, zoom) => businessTrendOption({ days, comparison: request.comparison, type, index, zoom, animation });
        const currentZoom = () => {
          const range = chart.getOption().dataZoom?.[0];
          return range && { start: range.start, end: range.end };
        };
        chart.setOption(optionForView(!reduced()));
        chart.on("click", p => { if (p.componentType !== "series") return; index = p.dataIndex; select.selectedIndex = index; selectedChannel = undefined; update(); });
        update();
        const toggle = button("切换为柱状图", () => {
          type = type === "line" ? "bar" : "line";
          toggle.textContent = type === "line" ? "切换为柱状图" : "切换为折线图";
          // ECharts creates a new series model for a new type, so resend the data too.
          chart.setOption(optionForView(!reduced(), currentZoom()), true);
        });
        controls.append(toggle);
        const exportStatus = el("span", "", "muted"); exportStatus.setAttribute("role", "status");
        for (const format of ["svg", "png"]) controls.append(button(`导出趋势 ${format.toUpperCase()}`, () => {
          // Rebuild from saved data + current UI state, not ECharts' transitional getOption model.
          const width = trend.clientWidth, height = trend.clientHeight;
          const holder = el("div"); holder.style.cssText = "position:fixed;left:-9999px;top:0"; document.body.append(holder);
          let copy;
          try {
            const option = optionForView(false, currentZoom());
            copy = format === "svg" ? echarts.init(null, null, { renderer: "svg", ssr: true, width, height }) : echarts.init(holder, null, { renderer: "canvas", width, height });
            copy.setOption({ ...option, backgroundColor: "#fff" }, true);
            const a = el("a"); a.download = `${report.result_id}.${format}`;
            a.href = format === "svg" ? `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(copy.renderToSVGString())}` : copy.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff" });
            a.click(); exportStatus.textContent = "";
          } catch (error) { exportStatus.textContent = `导出失败：${error.message}`; }
          finally { copy?.dispose(); holder.remove(); }
        }));
        controls.append(exportStatus);
        const resize = new ResizeObserver(() => chart.resize()); resize.observe(trend);
        const remove = new MutationObserver(() => { if (card.isConnected) return; remove.disconnect(); resize.disconnect(); chart.dispose(); });
        remove.observe(document.body, { subtree: true, childList: true });
      }).catch(error => { trend.textContent = error.message; });
    }

    if (!dimension || !request.comparison || report.status !== "verified") {
      const form = el("form"); const message = el("p", undefined, "muted"); message.setAttribute("role", "status");
      const dimensionSelect = el("select"); dimensionSelect.setAttribute("aria-label", "补查维度"); dimensionSelect.append(el("option", "保留原维度")); dimensionSelect.options[0].value = "";
      const start = el("input"), end = el("input"); start.type = end.type = "date";
      const startLabel = el("label", "对比期起始 "), endLabel = el("label", "对比期结束（不含） "); startLabel.append(start); endLabel.append(end);
      const send = el("button", "确认补查（读取源库）"); send.type = "submit";
      const panel = el("details"); panel.append(el("summary", dimension ? "补查对比期或重查" : "补查渠道或对比期"), form);
      form.append(el("p", "仅确认后才重查。不覆盖原结果。"), dimensionSelect, startLabel, endLabel, send, message);
      for (const d of report.available_dimensions ?? []) { const opt = el("option", d.label); opt.value = d.id; dimensionSelect.append(opt); }
      form.onsubmit = async event => {
        event.preventDefault();
        if (!state.sessionReady || state.sessionId !== sessionId || !state.session?.business_pilot?.enabled) { message.textContent = "请在原连接重连并启用业务试点后补查"; return; }
        if (Boolean(start.value) !== Boolean(end.value)) { message.textContent = "请选择完整对比期"; return; }
        send.disabled = true; message.textContent = "正在执行补查…";
        try {
          const next = await api(`/v1/sessions/${sessionId}/business-analysis`, { method: "POST", body: { version: report.version, request: { ...request, dimension: dimensionSelect.value || request.dimension, comparison: start.value ? { start: start.value, end: end.value } : request.comparison } } });
          const child = el("section", undefined, "business-report"); child.dataset.businessResult = next.result_id; card.after(child); mount(child, next); message.textContent = `已生成 ${next.result_id}`; child.querySelector("h2").tabIndex = -1; child.querySelector("h2").focus(); void refreshContext();
        } catch (error) { message.textContent = error.message; }
        finally { send.disabled = false; }
      };
      supplement.append(panel);
    }
  }
  return render;
}
