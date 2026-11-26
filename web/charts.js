function categoryAxis(option, axis) {
  const config = Array.isArray(option[axis]) ? option[axis][0] : option[axis];
  return config?.type === "category" && Array.isArray(config.data) ? config : null;
}

/** Add a viewport to a stored figure, without changing its data, scales or category order. */
export function chartViewport(option, width, height, dark = false) {
  const grid = option.grid;
  if (!grid || Array.isArray(grid) || option.dataZoom) return option;
  const x = categoryAxis(option, "xAxis");
  const y = categoryAxis(option, "yAxis");
  const denseScatter = option.series?.some((series) => series.type === "scatter" && series.data?.length > 80);
  const xSlot = (x?.data ?? []).reduce(
    (slot, label) => Math.min(108, Math.max(slot, String(label).length * 9 + 8)),
    44,
  );
  const sliderBottomSpace = 30;
  const sliderRightSpace = 26;
  const yLabelWidth = y ? 88 : 42;
  const ySlot = 22;
  const xCapacity = (hasYSlider) => Math.max(2, Math.floor(
    (width - grid.left - grid.right - yLabelWidth - (hasYSlider ? sliderRightSpace : 0)) / xSlot,
  ));
  const yCapacity = (hasXSlider) => Math.max(2, Math.floor(
    (height - grid.top - grid.bottom - ySlot - (hasXSlider ? sliderBottomSpace : 0)) / ySlot,
  ));
  const xCount = x?.data.length ?? 0;
  const yCount = y?.data.length ?? 0;
  const hasY = denseScatter || yCount > yCapacity(xCount > xCapacity(false));
  const hasX = denseScatter || xCount > xCapacity(hasY);
  if (!hasX && !hasY) return option;

  const bottom = option.visualMap ? 48 : option.legend ? 32 : 8;
  const view = {
    ...option,
    grid: {
      ...grid,
      bottom: grid.bottom + (hasX ? sliderBottomSpace : 0),
      right: grid.right + (hasY ? sliderRightSpace : 0),
    },
    dataZoom: [],
  };
  for (const [axis, category, active, capacity] of [
    ["xAxis", x, hasX, xCapacity(hasY)],
    ["yAxis", y, hasY, yCapacity(hasX)],
  ]) {
    if (!active) continue;
    const horizontal = axis === "xAxis";
    view.dataZoom.push({
      id: "viewport-" + axis,
      type: "slider",
      [axis + "Index"]: 0,
      orient: horizontal ? "horizontal" : "vertical",
      ...(horizontal ? { bottom, height: 18 } : { right: 8, width: 18 }),
      // Clip in the renderer, not by filtering series; panning must not rescale the opposite axis.
      filterMode: "none",
      showDataShadow: false,
      showDetail: false,
      brushSelect: false,
      borderColor: dark ? "#647685" : "#a1acae",
      backgroundColor: dark ? "#202a33" : "#eeefec",
      fillerColor: dark ? "rgba(121, 172, 177, 0.55)" : "rgba(98, 143, 145, 0.38)",
      ...(category
        ? { startValue: 0, endValue: Math.min(category.data.length, capacity) - 1, minValueSpan: 1 }
        : { start: 0, end: 100 }),
    });
  }
  for (const [key, axis, labelWidth] of [["xAxis", x, xSlot - 8], ["yAxis", y, yLabelWidth]]) {
    if (!axis) continue;
    const config = { ...axis, axisLabel: { ...axis.axisLabel, width: labelWidth, overflow: "truncate" } };
    view[key] = Array.isArray(option[key]) ? [config, ...option[key].slice(1)] : config;
  }
  // Keep the reserved legend row bounded even with many series.
  if (hasX && option.legend && !Array.isArray(option.legend)) view.legend = { ...option.legend, type: "scroll" };
  return view;
}

/** Change presentation only: keep saved cell coordinates, values and colour scale intact. */
export function heatmapDisplay(option, { full = false, showValues } = {}) {
  const x = categoryAxis(option, "xAxis"), y = categoryAxis(option, "yAxis");
  if (!x || !y || !option.series?.some(s => s.type === "heatmap")) return { option };
  const series = option.series.map(s => s.type !== "heatmap" ? s : {
    ...s,
    label: {
      ...s.label,
      show: showValues ?? s.label?.show ?? false,
      position: "inside",
      fontSize: 11,
      color: "#111827",
      textBorderColor: "#fff",
      textBorderWidth: 2,
    },
  });
  if (!full) return { option: { ...option, series } };

  const labelWidth = (data, min, max) => data.reduce((width, label) => {
    const text = String(label);
    const wide = text.replace(/[\x00-\x7F]/g, "").length;
    return Math.max(width, Math.min(max, (text.length - wide) * 7 + wide * 12 + 12));
  }, min);
  const xSlot = labelWidth(x.data, 48, 152);
  const yWidth = labelWidth(y.data, 72, 220);
  const grid = { left: yWidth + 38, right: 24, top: option.title ? 56 : 32, bottom: 88, containLabel: false };
  const axisWithLabels = (axis, saved, width) => {
    const config = { ...axis, axisLabel: { ...axis.axisLabel, interval: 0, width, overflow: "truncate" } };
    return Array.isArray(saved) ? [config, ...saved.slice(1)] : config;
  };
  const { dataZoom: _zoom, ...base } = option;
  return {
    option: { ...base, grid, series,
      xAxis: axisWithLabels({ ...x, nameGap: 32 }, option.xAxis, xSlot - 8),
      yAxis: axisWithLabels({ ...y, nameGap: yWidth + 16 }, option.yAxis, yWidth),
    },
    width: grid.left + grid.right + x.data.length * xSlot,
    height: Math.max(300, grid.top + grid.bottom + y.data.length * 24),
  };
}

/** Chart UI is a rendering of immutable server artifacts. No client aggregation. */
export function createCharts({ api, state, authHeaders, escapeHtml, cellToString, openRef, refreshContext }) {
  const $ = (id) => document.getElementById(id);
  const echartsLoader = { promise: null };
  function ensureEcharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (echartsLoader.promise) return echartsLoader.promise;
    echartsLoader.promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/echarts.min.js";
      script.onload = () => resolve(window.echarts);
      script.onerror = () => {
        echartsLoader.promise = null;
        script.remove();
        reject(new Error("ECharts 加载失败（/vendor/echarts.min.js）"));
      };
      document.head.appendChild(script);
    });
    return echartsLoader.promise;
  }

  async function downloadFile(path, fallbackName) {
    const headers = authHeaders?.() ?? (state.token ? { authorization: "Bearer " + state.token } : {});
    const res = await fetch(path, { headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    // The server names the file (it carries the artifact id and title); fall back to our guess.
    const disposition = res.headers.get("content-disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]) : fallbackName;
    const blob = await res.blob();
    saveBlob(blob, name);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function artifactTitle(artifact) {
    const spec = artifact.spec || {};
    if (spec.title) return spec.title;
    const summary = artifact.summary || {};
    return (summary.type || spec.type || "chart") + " · " + String((spec.result_id || "").slice(0, 12));
  }

  async function renderArtifactInto(host, artifactId) {
    if (host.querySelector('[data-artifact="' + artifactId + '"]')) return;
    const holder = document.createElement("div");
    holder.className = "cc-note";
    holder.dataset.artifact = artifactId;
    holder.textContent = "加载图表 " + artifactId + "…";
    host.appendChild(holder);
    try {
      const { artifact } = await api("/v1/artifacts/" + artifactId);
      if (!host.isConnected) return;
      const messages = host.closest("#messages");
      const follow = messages && messages.scrollHeight - messages.clientHeight - messages.scrollTop < 80;
      holder.replaceWith(buildChartCard(artifact));
      // History charts arrive asynchronously: stay at the newest turn only if the user
      // is still at the bottom, rather than pulling them away from earlier messages.
      if (follow) messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      holder.textContent = "图表加载失败: " + (error.message || String(error));
    }
  }

  function artifactTable(artifact) {
    const data = artifact.data || { columns: [], rows: [] };
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr>" + data.columns.map((column) => "<th>" + escapeHtml(column.name) + "</th>").join("") + "</tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of data.rows || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = row.map((cell) => "<td>" + escapeHtml(cellToString(cell)) + "</td>").join("");
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function buildChartCard(artifact) {
    const spec = artifact.spec || {};
    const summary = artifact.summary || {};
    const compiled = artifact.compiled || {};
    const card = document.createElement("div");
    card.className = "chart-card";
    card.dataset.artifact = artifact.id;

    const head = document.createElement("div");
    head.className = "cc-head";
    const meta = [artifact.id, summary.shape, summary.cells != null ? summary.cells + " points" : null]
      .filter(Boolean)
      .join(" · ");
    head.innerHTML =
      '<span class="cc-title">' +
      escapeHtml(artifactTitle(artifact)) +
      "</span>" +
      '<span class="cc-meta">' +
      escapeHtml(meta) +
      "</span>";
    card.appendChild(head);

    const option = compiled.option || {};
    const isHeatmap = spec.type === "heatmap" && Boolean(categoryAxis(option, "xAxis") && categoryAxis(option, "yAxis"));
    const plot = document.createElement("div");
    plot.className = "cc-plot";
    const plotHost = isHeatmap ? document.createElement("div") : card;
    if (isHeatmap) {
      plotHost.className = "cc-heatmap-scroll";
      card.appendChild(plotHost);
    }
    plotHost.appendChild(plot);

    const actions = document.createElement("div");
    actions.className = "cc-actions";
    card.appendChild(actions);

    const notes = [];
    if (summary.missing > 0) notes.push(summary.missing + " 个空格未画（缺失不是 0）");
    if (summary.clip) notes.push("颜色截断 " + summary.clip.kind + " = " + summary.clip.at);
    for (const warning of compiled.warnings || []) notes.push(warning);
    if (notes.length) {
      const note = document.createElement("div");
      note.className = "cc-note";
      note.textContent = notes.join(" · ");
      card.appendChild(note);
    }

    const csv = document.createElement("button");
    csv.className = "ghost";
    csv.textContent = "下载 CSV";
    csv.onclick = () =>
      downloadFile("/v1/artifacts/" + artifact.id + "/data.csv", artifact.id + ".csv").catch((error) =>
        alert(error.message),
      );

    if (compiled.renderer === "table") {
      plot.style.display = "none";
      const wrap = document.createElement("div");
      wrap.className = "cc-table";
      wrap.style.display = "block";
      wrap.appendChild(artifactTable(artifact));
      card.appendChild(wrap);
      actions.appendChild(csv);
      return card;
    }

    const tableButton = document.createElement("button");
    tableButton.className = "ghost";
    tableButton.textContent = "数据";
    tableButton.onclick = () => {
      if (!tablePane.firstChild) tablePane.appendChild(artifactTable(artifact));
      card.classList.toggle("show-table");
    };
    const tablePane = document.createElement("div");
    tablePane.className = "cc-table";
    card.appendChild(tablePane);
    actions.appendChild(tableButton);
    actions.appendChild(csv);

    const refs = document.createElement("div");
    for (const item of summary.top || []) {
      const chip = document.createElement("button");
      chip.className = "ref-chip";
      chip.textContent = item.label;
      chip.title = item.ref;
      chip.onclick = () => openRef(item.ref);
      chip.dataset.ref = item.ref;
      refs.appendChild(chip);
    }
    card.appendChild(refs);
    const archive = document.createElement("button");
    archive.className = "ghost";
    archive.textContent = "归档";
    archive.title = "仅从工作清单隐藏，不删除数值证据或重置预算";
    archive.onclick = async () => {
      try {
        await api("/v1/artifacts/" + artifact.id + "/archive", {
          method: "POST",
          body: { archived: true },
        });
        archive.textContent = "已归档";
        archive.disabled = true;
        void refreshContext();
      } catch (error) {
        alert(error.message);
      }
    };
    actions.appendChild(archive);
    const yCount = categoryAxis(option, "yAxis")?.data.length ?? 0;
    const compactHeight = yCount > 6 ? Math.max(320, Math.min(460, yCount * 26 + 110)) : 300;
    plot.style.height = compactHeight + "px";
    const scrollHint = document.createElement("div");
    scrollHint.className = "cc-note";
    scrollHint.hidden = true;
    card.insertBefore(scrollHint, isHeatmap ? plotHost : actions);

    ensureEcharts()
      .then((echarts) => {
        if (!card.isConnected) return;
        let currentOption = option;
        let fullHeatmap = false;
        let showHeatmapValues = Boolean(option.series?.find(s => s.type === "heatmap")?.label?.show);
        let heatmapView = isHeatmap ? heatmapDisplay(option, { showValues: showHeatmapValues }) : null;
        const dark = document.documentElement.classList.contains("dark");
        const theme = {
          color: ["#628f91", "#bb856b", "#9b9a6b", "#7c8fad", "#ae7f94", "#a8b9b1"],
          backgroundColor: "transparent",
          textStyle: {
            color: dark ? "#c6d0d8" : "#525c60",
            fontFamily: "system-ui",
          },
          title: {
            textStyle: { color: dark ? "#e1e7eb" : "#333e44", fontSize: 14 },
          },
          categoryAxis: {
            axisLine: { lineStyle: { color: dark ? "#53616d" : "#ccc8bf" } },
            axisLabel: { color: dark ? "#b5c1ca" : "#656b6e" },
          },
          valueAxis: {
            splitLine: { lineStyle: { color: dark ? "#35404a" : "#eeece7" } },
            axisLabel: { color: dark ? "#b5c1ca" : "#656b6e" },
          },
        };
        const chart = echarts.init(plot, theme, { renderer: "svg" });
        let viewportKey;
        const chosenRanges = new Map();
        chart.on("datazoom", (event) => {
          for (const { dataZoomId, start, end } of event.batch ?? [event]) {
            if (dataZoomId && Number.isFinite(start) && Number.isFinite(end)) {
              chosenRanges.set(dataZoomId, { start, end });
            }
          }
        });
        function applyViewport(force = false) {
          const display = heatmapView?.option ?? currentOption;
          const view = fullHeatmap ? display : chartViewport(display, chart.getWidth(), chart.getHeight(), dark);
          const sliders = view.dataZoom?.filter((slider) => slider.id?.startsWith("viewport-")) ?? [];
          const key = JSON.stringify(sliders);
          if (!force && key === viewportKey) return;
          viewportKey = key;

          const next = structuredClone(view);
          for (const slider of next.dataZoom ?? []) {
            const range = chosenRanges.get(slider.id);
            if (!range) continue;
            delete slider.startValue;
            delete slider.endValue;
            Object.assign(slider, range);
          }
          chart.setOption(next, true);
          scrollHint.hidden = !fullHeatmap && sliders.length === 0;
          if (fullHeatmap) {
            scrollHint.textContent = `已展开全部 ${categoryAxis(display, "xAxis").data.length} 列 × ${yCount} 行；可上下左右滚动；下载 SVG 可保存整张图。`;
          } else if (sliders.length) {
            const direction = sliders.length === 2 ? "下方和右侧" : sliders[0].orient === "vertical" ? "右侧" : "下方";
            scrollHint.textContent = `拖动${direction}滑条浏览数据，拖动滑条两端可调整显示范围。`;
          }
        }
        applyViewport();
        if (isHeatmap) {
          const tools = document.createElement("div");
          tools.className = "cc-actions cc-heatmap-actions";
          const expand = document.createElement("button");
          const values = document.createElement("button");
          for (const button of [expand, values]) {
            button.type = "button";
            button.className = "ghost";
          }
          expand.textContent = "展开全图";
          values.textContent = "显示格内数值";
          const reflect = () => {
            for (const [button, on] of [[expand, fullHeatmap], [values, showHeatmapValues]]) {
              button.classList.toggle("active", on);
              button.setAttribute("aria-pressed", String(on));
            }
          };
          const updateHeatmap = () => {
            heatmapView = heatmapDisplay(option, { full: fullHeatmap, showValues: showHeatmapValues });
            plot.style.minWidth = fullHeatmap ? heatmapView.width + "px" : "";
            plot.style.height = (fullHeatmap ? heatmapView.height : compactHeight) + "px";
            plotHost.classList.toggle("expanded", fullHeatmap);
            plotHost.tabIndex = fullHeatmap ? 0 : -1;
            if (fullHeatmap) {
              plotHost.setAttribute("role", "region");
              plotHost.setAttribute("aria-label", "完整热力图，可滚动查看");
            } else {
              plotHost.removeAttribute("role");
              plotHost.removeAttribute("aria-label");
              plotHost.scrollLeft = plotHost.scrollTop = 0;
            }
            chart.resize();
            applyViewport(true);
            reflect();
          };
          expand.onclick = () => { fullHeatmap = !fullHeatmap; updateHeatmap(); };
          values.onclick = () => { showHeatmapValues = !showHeatmapValues; updateHeatmap(); };
          reflect();
          tools.append(expand, values);
          card.insertBefore(tools, scrollHint);
        }
        for (const chip of refs.children) {
          chip.onmouseenter = () => {
            const match = chip.dataset.ref.match(/#cell\[(.*)\]/);
            if (!match) return;
            const pairs = Object.fromEntries(
              match[1].split(",").map((p) => {
                const at = p.indexOf("=");
                return [decodeURIComponent(p.slice(0, at)), decodeURIComponent(p.slice(at + 1))];
              }),
            );
            const option = chart.getOption();
            const xIndex = option.xAxis?.[0]?.data?.indexOf(pairs[spec.x?.field]) ?? -1;
            const yIndex = option.yAxis?.[0]?.data?.indexOf(pairs[spec.y?.field]) ?? -1;
            const outsideWindow = (axis, index) => option.dataZoom?.some(({ id, startValue, endValue }) =>
              id === "viewport-" + axis && (index < startValue || index > endValue),
            );
            if (xIndex < 0 || outsideWindow("xAxis", xIndex) || (yIndex >= 0 && outsideWindow("yAxis", yIndex))) return;
            const seriesNames = option.series?.map((s) => s.name) ?? [];
            const seriesIndex = spec.series ? seriesNames.indexOf(pairs[spec.series.field]) : 0;
            const dataIndex = spec.type === "heatmap"
              ? option.series[0].data.findIndex(([x, y]) => x === xIndex && y === yIndex)
              : xIndex;
            if (dataIndex >= 0 && seriesIndex >= 0) {
              chart.dispatchAction({
                type: "highlight",
                seriesIndex,
                dataIndex,
              });
              chart.dispatchAction({ type: "showTip", seriesIndex, dataIndex });
            }
          };
          chip.onmouseleave = () => {
            chart.dispatchAction({ type: "downplay" });
            chart.dispatchAction({ type: "hideTip" });
          };
        }
        const resize = new ResizeObserver(() => {
          chart.resize();
          applyViewport();
        });
        resize.observe(plot);
        const removal = new MutationObserver(() => {
          if (card.isConnected) return;
          resize.disconnect();
          removal.disconnect();
          chart.dispose();
        });
        removal.observe(document.body, { childList: true, subtree: true });

        const svg = document.createElement("button");
        svg.className = "ghost";
        svg.textContent = "下载 SVG";
        svg.onclick = async () => {
          try {
            await api("/v1/artifacts/" + artifact.id + "/export-action", { method: "POST", body: { format: "svg" } });
            // Vector export, so a printed/reviewed copy stays sharp at any size.
            const url = chart.getDataURL({
              type: "svg",
              backgroundColor: "#ffffff",
            });
            const svgText = decodeURIComponent(url.replace(/^data:image\/svg\+xml;charset=UTF-8,/, ""));
            saveBlob(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }), artifact.id + ".svg");
          } catch (error) {
            alert(error.message);
          }
        };
        const png = document.createElement("button");
        png.className = "ghost";
        png.textContent = "下载 PNG";
        png.onclick = () => {
          const snapshot = chart.getOption();
          const width = chart.getWidth();
          const height = chart.getHeight();
          // Expanded figures can be much larger than the visible card. Keep canvas allocation bounded.
          const ratio = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
          if (ratio < 1) {
            alert("全图尺寸过大，无法导出 PNG。请下载 SVG，或关闭「展开全图」后再导出当前视图。");
            return;
          }
          return api("/v1/artifacts/" + artifact.id + "/export-action", { method: "POST", body: { format: "png" } })
            .then(() => pngFromOption(snapshot, theme, artifact.id, width, height, ratio))
            .catch((error) => alert(error.message));
        };
        actions.appendChild(svg);
        actions.appendChild(png);

        // Stored alternates: switching figure type is a UI action, not another model/tool call.
        const usable = [{ type: spec.type, option }].concat(artifact.alternates || []);
        const toggle = document.createElement("span");
        toggle.style.display = "contents";
        for (const alternate of usable) {
          const button = document.createElement("button");
          button.className = "ghost" + (alternate.type === spec.type ? " active" : "");
          button.textContent = alternate.type === "bar" ? "柱状" : alternate.type === "line" ? "折线" : alternate.type;
          button.onclick = () => {
            currentOption = alternate.option ?? {};
            applyViewport(true);
            for (const other of toggle.querySelectorAll("button")) other.classList.toggle("active", other === button);
          };
          toggle.appendChild(button);
        }
        if (toggle.childElementCount > 1) actions.insertBefore(toggle, actions.firstChild);
      })
      .catch((error) => {
        plot.innerHTML = '<div class="cc-note">' + escapeHtml(error.message) + "</div>";
      });

    return card;
  }

  /** Draw the current figure and its visible range with the canvas renderer for PNG. */
  async function pngFromOption(option, theme, id, width, height, ratio) {
    const echarts = await ensureEcharts();
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-99999px;top:0";
    document.body.appendChild(holder);
    let chart;
    try {
      chart = echarts.init(holder, theme, { renderer: "canvas", width, height });
      chart.setOption({ ...structuredClone(option), animation: false }, true);
      const url = chart.getDataURL({
        type: "png",
        pixelRatio: ratio,
        backgroundColor: "#ffffff",
      });
      const blob = await (await fetch(url)).blob();
      saveBlob(blob, id + ".png");
    } finally {
      chart?.dispose();
      holder.remove();
    }
  }

  return { downloadFile, artifactTable, buildChartCard, renderArtifactInto, ensureEcharts };
}
