/** Chart UI is a rendering of immutable server artifacts. No client aggregation. */
export function createCharts({ api, state, escapeHtml, cellToString, openRef, refreshContext }) {
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
    const headers = {};
    if (state.token) headers["authorization"] = "Bearer " + state.token;
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
      holder.replaceWith(buildChartCard(artifact));
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

    const plot = document.createElement("div");
    plot.className = "cc-plot";
    card.appendChild(plot);

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

    const option = compiled.option || {};
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
    const yCount = option.yAxis && Array.isArray(option.yAxis.data) ? option.yAxis.data.length : 0;
    plot.style.height = (yCount > 6 ? Math.max(320, Math.min(620, yCount * 26 + 110)) : 300) + "px";

    ensureEcharts()
      .then((echarts) => {
        if (!card.isConnected) return;
        let currentOption = option;
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
        chart.setOption(structuredClone(currentOption), true);
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
            const categories = option.xAxis?.[0]?.data ?? [];
            const seriesNames = option.series?.map((s) => s.name) ?? [];
            const dataIndex = categories.indexOf(pairs[spec.x?.field]);
            const seriesIndex = spec.series ? seriesNames.indexOf(pairs[spec.series.field]) : 0;
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
        const resize = new ResizeObserver(() => chart.resize());
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
        png.onclick = () =>
          api("/v1/artifacts/" + artifact.id + "/export-action", { method: "POST", body: { format: "png" } })
            .then(() => pngFromOption(currentOption, artifact.id, chart.getWidth(), chart.getHeight()))
            .catch((error) => alert(error.message));
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
            currentOption = alternate.option;
            chart.setOption(structuredClone(currentOption), true);
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

  /** PNG needs the canvas renderer, so it is drawn off-screen from the same stored option. */
  async function pngFromOption(option, id, width, height) {
    const echarts = await ensureEcharts();
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-99999px;top:0";
    document.body.appendChild(holder);
    let chart;
    try {
      chart = echarts.init(holder, null, { renderer: "canvas", width, height });
      chart.setOption({ ...structuredClone(option), animation: false }, true);
      const url = chart.getDataURL({
        type: "png",
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      const blob = await (await fetch(url)).blob();
      saveBlob(blob, id + ".png");
    } finally {
      chart?.dispose();
      holder.remove();
    }
  }

  return { downloadFile, artifactTable, buildChartCard, renderArtifactInto };
}
