// Standalone, build-free model management. The server is authoritative; secrets are write-only.
export function initModelManager({ api, enhanceSelect, onChange }) {
  const root = document.getElementById("modelManager");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let catalog = null, selected = null, dirty = false, busy = false, revision = 0;
  let discovered = [];
  const $ = (id) => root.querySelector("#" + id);
  root.innerHTML = `
    <div class="mm-heading"><div><div class="mm-eyebrow">MODEL WORKSPACE</div><h2>模型管理</h2><p>你的渠道、凭证与模型，独立保存在此服务中。</p></div><button id="mmNew" class="primary">＋ 新建渠道</button></div>
    <div id="mmActive" class="mm-active"></div>
    <div class="mm-layout">
      <aside class="mm-sidebar"><input id="mmSearch" type="search" placeholder="搜索渠道或模型…" aria-label="搜索渠道或模型" /><div id="mmList"></div>
        <details><summary>从 pi 迁移渠道</summary><p class="hint">只读导入一次，复制后独立管理；不会修改 pi。</p><div id="mmPi"></div></details>
        <details><summary>配置备份 / 迁移</summary><p class="hint">导出仅含渠道与模型，不含 API key 或私有请求头。服务器迁移请另行备份 data 与加密主密钥。</p><button class="ghost" id="mmExport">导出配置 JSON</button><label>导入配置文件<input type="file" id="mmImport" accept=".json,application/json" /></label></details>
      </aside>
      <div id="mmEditor"></div>
    </div><div id="mmStatus" class="status info" role="status" aria-live="polite">读取中…</div>`;
  function status(text, tone = "info") { $("mmStatus").className = "status " + tone; $("mmStatus").textContent = text; }
  function confirmDiscard() { return !dirty || window.confirm("当前渠道有未保存的更改，要放弃这些更改吗？"); }
  function enhance() { root.querySelectorAll("select:not([data-enhanced])").forEach((s) => {
    s.dataset.enhanced = "1";
    const label = s.closest("label");
    if (label) label.htmlFor = s.id;
    enhanceSelect(s);
  }); }
  function renderList() {
    const query = $("mmSearch").value.trim().toLowerCase();
    $("mmList").innerHTML = catalog.providers.filter((p) => (p.id + p.name + p.models.map((m) => m.id).join(" ")).toLowerCase().includes(query)).map((p) =>
      `<button class="mm-channel ${selected === p.id ? "active" : ""}" data-edit="${esc(p.id)}"><span class="mm-channel-top"><b>${esc(p.name)}</b><span class="pill">${p.models.length} 模型</span></span><span class="hint">${esc(p.id)} · ${p.authMode === "none" ? "无需密钥" : p.has_api_key ? "已配置凭证" : "待配置凭证"}</span>${catalog.active.provider === p.id ? '<span class="mm-default">当前默认渠道</span>' : ""}</button>`).join("") || '<div class="mm-empty">暂无项目渠道<br><span class="hint">新建一个渠道，或从 pi 导入。</span></div>';
    const a = catalog.active;
    $("mmActive").innerHTML = '<span class="dot' + (a.ready ? ' ok' : '') + '"></span><span>当前默认 <b>' + esc(a.provider + " / " + a.modelId) + '</b> · ' + esc(a.thinkingLevel) + (a.ready ? '' : ' · 待配置凭证') + '</span><span class="hint">仅影响新建会话</span>';
  }
  function modelRow(m = { id: "", name: "", reasoning: false, contextWindow: 128000, maxTokens: 16384, input: ["text"] }) {
    return `<div class="mm-model">
      <div class="mm-model-top"><span class="mm-model-label">模型</span><button class="ghost danger" data-remove-model type="button" aria-label="删除此模型">移除</button></div>
      <div class="grid-2"><label>模型 ID<input data-field="id" value="${esc(m.id)}" placeholder="API 中的模型标识" /></label><label>显示名称<input data-field="name" value="${esc(m.name)}" placeholder="可选" /></label></div>
      <div class="grid-3"><label>上下文窗口<input data-field="contextWindow" type="number" min="1024" value="${m.contextWindow}" /></label><label>最大输出<input data-field="maxTokens" type="number" min="64" value="${m.maxTokens}" /></label><div class="mm-checks"><label class="checkbox-label"><input type="checkbox" data-field="reasoning" ${m.reasoning ? "checked" : ""} />支持思考</label><label class="checkbox-label"><input type="checkbox" data-field="image" ${m.input?.includes("image") ? "checked" : ""} />支持图片输入</label></div></div>
      <details><summary>模型兼容性与思考映射</summary><label>compat（JSON，可选）<textarea data-field="compat" rows="2" placeholder='{"supportsDeveloperRole":false}'>${m.compat ? esc(JSON.stringify(m.compat, null, 2)) : ""}</textarea></label><label>thinkingLevelMap（JSON，可选）<textarea data-field="thinkingLevelMap" rows="2" placeholder='{"xhigh":"xhigh","max":"max"}'>${m.thinkingLevelMap ? esc(JSON.stringify(m.thinkingLevelMap, null, 2)) : ""}</textarea></label></details>
    </div>`;
  }
  function edit(provider) {
    selected = provider?.id || null;
    dirty = false;
    revision++;
    discovered = [];
    const p = provider || { name: "", id: "", baseUrl: "", api: "openai-completions", authMode: "key", models: [{ id: "", contextWindow: 128000, maxTokens: 16384 }] };
    $("mmEditor").innerHTML = `
      <div class="mm-editor-head"><h3>${provider ? "编辑渠道" : "新建渠道"}</h3><span class="pill">${provider ? "项目独立配置" : "尚未保存"}</span></div>
      <fieldset id="mmFields" ${catalog.editable ? "" : "disabled"}>
      <div class="grid-2"><label>渠道标识<input id="mmId" value="${esc(p.id)}" ${provider ? "readonly" : ""} placeholder="例如 company-gateway" /><span class="hint">唯一标识，保存后不可更改</span></label><label>显示名称<input id="mmName" value="${esc(p.name)}" placeholder="例如 团队主渠道" /></label></div>
      <div class="grid-2"><label>API 协议<select id="mmApi">${catalog.api_options.map((a) => `<option value="${esc(a.id)}" ${a.id === p.api ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></label><label>API Base URL<input id="mmUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" /></label></div>
      <div class="grid-2"><label>API key<input id="mmKey" type="password" autocomplete="new-password" placeholder="${p.has_api_key ? "已保存；留空保持不变" : "输入密钥（仅写入，不回显）"}" /></label><div class="mm-checks"><label class="checkbox-label"><input type="checkbox" id="mmNoAuth" ${p.authMode === "none" ? "checked" : ""} />本地 / 无鉴权服务</label><label class="checkbox-label"><input type="checkbox" id="mmClearKey" />清除此渠道保存的密钥</label></div></div>
      <div class="mm-security hint">${catalog.storage.protection === "aes-256-gcm" ? "凭证使用 AES-256-GCM 加密存储。" : "建议在服务器设置 DATA_AGENT_PROFILE_SECRET_KEY，启用凭证加密；未设置时以 0600 明文文件保存。"} 留空不修改已有密钥；更改地址后需重新输入或清除。</div>
      <details><summary>渠道高级配置</summary><label>私有请求头 JSON（只写）<textarea id="mmHeaders" rows="2" placeholder='{"X-Org":"analytics"}'></textarea><span class="hint">${p.header_names?.length ? "已保存头名称：" + esc(p.header_names.join(", ")) + "；" : ""}留空保持；输入 {} 清空。值不会被导出。</span></label><label>渠道 compat JSON<textarea id="mmCompat" rows="2" placeholder='{"supportsDeveloperRole":false}'>${p.compat ? esc(JSON.stringify(p.compat, null, 2)) : ""}</textarea></label></details>
      <div class="mm-models-heading"><h3>模型列表</h3><div><button class="ghost" id="mmDiscover" type="button">从接口获取</button><button class="ghost" id="mmAdd" type="button">＋ 添加模型</button></div></div>
      <div id="mmDiscovered" hidden></div><div id="mmModels">${p.models.map(modelRow).join("")}</div>
      <div class="mm-actions"><button id="mmSave" class="primary" type="button">保存渠道</button><button id="mmCopy" class="ghost" type="button">复制渠道</button>${provider ? '<button id="mmDelete" class="ghost danger" type="button">删除渠道</button>' : ""}</div>
      <div class="mm-test"><label>测试 / 设为默认的模型<select id="mmTarget"></select></label><label>思考强度<select id="mmThinking">${catalog.thinking_levels.map((l) => `<option ${l === catalog.active.thinkingLevel ? "selected" : ""}>${l}</option>`).join("")}</select></label><button id="mmTest" class="ghost" type="button">测试草稿</button><button id="mmActivate" class="ghost" type="button">设为默认</button></div>
      </fieldset><div class="hint">测试只发送一次最小请求，不保存、不切换默认模型。设为默认前请先保存；已有会话保持原配置。</div>`;
    syncTargets();
    if (catalog.active.provider === p.id && p.models.some((m) => m.id === catalog.active.modelId)) $("mmTarget").value = catalog.active.modelId;
    enhance();
    renderList();
    if (!catalog.editable) status("只读：服务器需设置 DATA_AGENT_ALLOW_MODEL_EDIT=1 后才能管理渠道。", "err");
  }
  function jsonField(node, label) {
    if (!node.value.trim()) return undefined;
    try { return JSON.parse(node.value); } catch { throw new Error(label + " 不是合法 JSON"); }
  }
  function draft() {
    const id = $("mmId").value.trim();
    if (!id) throw new Error("请填写渠道标识");
    const models = [...root.querySelectorAll(".mm-model")].map((row) => {
      const field = (name) => row.querySelector('[data-field="' + name + '"]');
      return { id: field("id").value.trim(), name: field("name").value.trim() || undefined,
        contextWindow: Number(field("contextWindow").value), maxTokens: Number(field("maxTokens").value),
        reasoning: field("reasoning").checked, input: field("image").checked ? ["text", "image"] : ["text"],
        compat: jsonField(field("compat"), "模型 compat"), thinkingLevelMap: jsonField(field("thinkingLevelMap"), "思考映射") };
    });
    const body = { name: $("mmName").value.trim(), api: $("mmApi").value, baseUrl: $("mmUrl").value.trim(), models,
      authMode: $("mmNoAuth").checked ? "none" : "key", compat: jsonField($("mmCompat"), "渠道 compat"),
      headers: jsonField($("mmHeaders"), "私有请求头") };
    if ($("mmClearKey").checked) body.apiKey = null;
    else if ($("mmKey").value.trim()) body.apiKey = $("mmKey").value.trim();
    return { id, body };
  }
  function syncTargets() {
    const previous = $("mmTarget")?.value;
    const ids = [...root.querySelectorAll('[data-field="id"]')].map((n) => n.value.trim()).filter(Boolean);
    $("mmTarget").innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
    if (ids.includes(previous)) $("mmTarget").value = previous;
  }
  async function refresh() {
    try {
      catalog = await api("/v1/model/providers");
      renderList();
      const channels = await api("/v1/model/channels");
      $("mmPi").innerHTML = channels.channels.filter((c) => c.source === "pi-models").map((c) => `<button class="ghost mm-import" data-import-pi="${esc(c.id)}">导入 ${esc(c.name)}</button>`).join("") || '<span class="hint">服务器未连接 pi 配置。独立管理不需要安装 pi CLI 或挂载其目录。</span>';
      if (!$("mmFields") || !dirty) edit(catalog.providers.find((p) => p.id === selected) || catalog.providers[0]);
      if (!dirty) status("独立渠道 " + catalog.providers.length + " 个 · 保存后重启仍然有效", "info");
      $("mmNew").disabled = !catalog.editable;
      if (catalog.storage.status === "invalid" || catalog.storage.secrets_status === "invalid") status("配置或凭证文件不可读取，请先修复服务端文件或恢复加密主密钥，避免覆盖已有数据。", "err");
    } catch (error) { status(error.message, "err"); }
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    const rev = revision;
    const fieldset = $("mmFields");
    try { fieldset && (fieldset.disabled = true); await action(); }
    catch (error) { if (rev === revision) status(error.message, "err"); }
    finally { busy = false; if (rev === revision && fieldset) fieldset.disabled = !catalog.editable; }
  }
  $("mmSearch").oninput = renderList;
  root.addEventListener("input", (event) => {
    if (event.target.closest("#mmFields") && !["mmTarget", "mmThinking"].includes(event.target.id)) dirty = true;
    if (event.target.matches('[data-field="id"]')) syncTargets();
  });
  root.addEventListener("change", (event) => { if (event.target.closest("#mmFields") && !["mmTarget", "mmThinking"].includes(event.target.id)) dirty = true; });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy || !catalog) return;
    if (button.dataset.edit) { if (confirmDiscard()) edit(catalog.providers.find((p) => p.id === button.dataset.edit)); return; }
    if (button.id === "mmNew") { if (confirmDiscard()) edit(); return; }
    if (button.hasAttribute("data-remove-model")) { button.closest(".mm-model").remove(); dirty = true; syncTargets(); return; }
    if (button.id === "mmAdd") { $("mmModels").insertAdjacentHTML("beforeend", modelRow()); dirty = true; syncTargets(); return; }
    if (button.id === "mmCopy") {
      try { const { body } = draft(); if (!confirmDiscard()) return; edit({ ...body, id: "", header_names: [] }); $("mmId").readOnly = false; selected = null; dirty = true; status("副本不会带入已有凭证，请填写新的渠道标识与密钥。"); }
      catch (error) { status(error.message, "err"); } return;
    }
    if (button.id === "mmSave") return run(async () => {
      const { id, body } = draft();
      if (!selected && catalog.providers.some((p) => p.id === id)) throw new Error("渠道标识已存在，请使用新标识，或从左侧选择该渠道进行编辑。");
      status("校验并保存中…");
      catalog = await api("/v1/model/providers/" + encodeURIComponent(id), { method: "PUT", body });
      edit(catalog.providers.find((p) => p.id === id)); await onChange();
      status("渠道已保存；凭证仅存于服务器。可测试后设为默认。", "ok");
    });
    if (button.id === "mmDelete") {
      if (!selected || !window.confirm("删除渠道「" + selected + "」及其保存的凭证？此操作无法撤销。")) return;
      return run(async () => { catalog = await api("/v1/model/providers/" + encodeURIComponent(selected), { method: "DELETE" }); edit(catalog.providers[0]); await onChange(); status("渠道已删除", "ok"); });
    }
    if (button.id === "mmTest") return run(async () => {
      const { id, body } = draft(); const modelId = $("mmTarget").value;
      if (!modelId) throw new Error("请添加模型并选择测试目标"); status("测试草稿中（最多 20 秒）…");
      const result = await api("/v1/model/providers/" + encodeURIComponent(id) + "/test", { method: "POST", body: { config: body, modelId } });
      status(result.ok ? "测试通过 · " + result.latency_ms + "ms · " + (result.response_text || "请求成功") : "测试失败 · " + (result.error || "未知错误"), result.ok ? "ok" : "err");
    });
    if (button.id === "mmActivate") return run(async () => {
      if (!selected || dirty) throw new Error("请先保存渠道，再设为默认。");
      const modelId = $("mmTarget").value, thinkingLevel = $("mmThinking").value;
      if (!modelId) throw new Error("请选择模型");
      await api("/v1/model/select", { method: "POST", body: { provider: selected, modelId, thinkingLevel } });
      catalog = await api("/v1/model/providers"); renderList(); await onChange(); status("默认模型已更新；新建会话生效。", "ok");
    });
    if (button.id === "mmDiscover") return run(async () => {
      const { id, body } = draft();
      // Discovery only needs the endpoint; an empty draft gets a placeholder for schema validation.
      body.models = [{ id: "discovery-placeholder" }];
      status("获取接口模型列表…");
      discovered = (await api("/v1/model/providers/" + encodeURIComponent(id) + "/discover", { method: "POST", body })).models;
      const present = new Set([...root.querySelectorAll('[data-field="id"]')].map((n) => n.value.trim()));
      $("mmDiscovered").hidden = false;
      $("mmDiscovered").innerHTML = '<div class="hint">只导入所选模型。列表通常不提供能力参数，请核对上下文、输出上限和思考能力。</div><div class="mm-discovery-list">' + discovered.filter((m) => !present.has(m.id)).map((m, i) => `<label class="checkbox-label"><input type="checkbox" value="${esc(m.id)}" />${esc(m.name || m.id)}</label>`).join("") + '</div><button id="mmAddDiscovered" class="ghost">添加勾选模型</button>';
      status("获取到 " + discovered.length + " 个模型（已有模型不重复显示）", "ok");
    });
    if (button.id === "mmAddDiscovered") {
      const ids = [...$("mmDiscovered").querySelectorAll("input:checked")].map((i) => i.value);
      for (const id of ids) $("mmModels").insertAdjacentHTML("beforeend", modelRow({ ...discovered.find((m) => m.id === id), contextWindow: 128000, maxTokens: 16384 }));
      dirty = true; $("mmDiscovered").hidden = true; syncTargets(); return;
    }
    if (button.dataset.importPi) {
      if (!confirmDiscard()) return;
      const sourceId = button.dataset.importPi;
      const targetId = window.prompt("新项目渠道标识（不会覆盖同名已有渠道）", sourceId + "-local");
      if (!targetId) return;
      return run(async () => { catalog = await api("/v1/model/import-pi", { method: "POST", body: { sourceId, targetId } }); edit(catalog.providers.find((p) => p.id === targetId)); await onChange(); status("已导入为独立渠道；即使移除 pi 配置，仍然可用。", "ok"); });
    }
    if (button.id === "mmExport") {
      const providers = Object.fromEntries(catalog.providers.map(({ id, has_api_key, header_names, ...p }) => [id, p]));
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, providers }, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = "data-agent-model-providers.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      status("配置已导出，不含密钥和私有请求头。", "ok");
    }
  });
  $("mmImport").onchange = () => run(async () => {
    const file = $("mmImport").files[0]; if (!file) return;
    if (!confirmDiscard()) return;
    if (file.size > 1_000_000) throw new Error("配置文件不能超过 1 MB");
    const data = JSON.parse(await file.text());
    if (!data.providers || typeof data.providers !== "object") throw new Error("需要包含 providers 对象的 JSON");
    const entries = Object.entries(data.providers);
    if (!entries.length || entries.length > 30) throw new Error("一次请导入 1–30 个渠道");
    const existing = entries.filter(([id]) => catalog.providers.some((p) => p.id === id));
    if (existing.length) throw new Error("同名渠道已存在：" + existing.map(([id]) => id).join(", ") + "。请更改文件中的标识后再导入。" );
    let count = 0;
    try {
      for (const [id, body] of entries) { catalog = await api("/v1/model/providers/" + encodeURIComponent(id), { method: "PUT", body }); count++; }
      edit(catalog.providers.find((p) => p.id === entries[0][0])); await onChange(); status("已导入 " + count + " 个渠道。请配置凭证并测试。", "ok");
    } catch (error) { throw new Error("已成功导入 " + count + " 个；后续失败：" + error.message); }
    finally { $("mmImport").value = ""; renderList(); }
  });
  return { refresh };
}
