const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, className = "ghost") => {
  const node = el("button", text, className);
  node.type = "button";
  return node;
};
const tokenCount = (files) => files.reduce((sum, file) => sum + file.estimatedTokens, 0);

const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_CHARS = 16_000;

/** File name without extension becomes the document name; the library name limit is 100 characters. */
export function documentName(filename) {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").trim();
  return (base || filename.trim() || "未命名文档").slice(0, 100);
}

export function initBusinessContext({ api, state, panel, trigger }) {
  const heading = el("div", undefined, "bc-header");
  const create = button("新建文档"), refresh = button("刷新"), upload = button("上传文档");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".md,.markdown,.mdx,.txt,text/markdown,text/plain";
  fileInput.multiple = true;
  fileInput.hidden = true;
  heading.append(el("h3", "业务上下文"), refresh, upload, create, fileInput);
  const notice = el("p", undefined, "muted bc-notice");
  notice.setAttribute("role", "status");
  const activeHeading = el("h3", "当前会话使用");
  const activeList = el("ul", undefined, "bc-list");
  const library = el("ul", undefined, "bc-list");
  panel.append(heading, notice, activeHeading, activeList, el("h3", "文档库"), library);

  function makeDialog(title) {
    const dialog = el("dialog", undefined, "bc-dialog");
    dialog.setAttribute("aria-label", title);
    const header = el("header"), close = button("关闭");
    close.onclick = () => dialog.close();
    header.append(el("h2", title), close);
    dialog.append(header);
    document.body.append(dialog);
    return dialog;
  }
  const picker = makeDialog("选用业务上下文");
  const pickerHelp = el("p", "已应用的资料会随当前会话保留，不需要每次重选。应用后，下次分析使用最新勾选版本。", "muted");
  const choices = el("div", undefined, "bc-choices");
  const estimate = el("p", undefined, "muted");
  const status = el("p", undefined, "bc-notice");
  status.setAttribute("role", "status");
  const defaults = button("设为连接默认"), apply = button("应用到会话", "primary");
  const actions = el("div", undefined, "buttons bc-actions");
  actions.append(defaults, apply);
  picker.append(pickerHelp, choices, estimate, status, actions);

  const editor = makeDialog("Markdown 文档");
  const form = el("form");
  const name = el("input"), markdown = el("textarea");
  name.id = "bcName"; name.required = true; name.maxLength = 100;
  markdown.id = "bcMarkdown"; markdown.required = true; markdown.maxLength = 16000; markdown.rows = 12;
  markdown.placeholder = "## 指标定义\n例如：GMV = 已支付且未退款订单金额之和。";
  const nameLabel = el("label", "文档名称"), markdownLabel = el("label", "Markdown 正文");
  nameLabel.htmlFor = name.id; markdownLabel.htmlFor = markdown.id;
  const editorStatus = el("p", undefined, "bc-notice");
  editorStatus.setAttribute("role", "status");
  const save = el("button", "保存到文档库", "primary");
  save.type = "submit";
  form.append(nameLabel, name, markdownLabel, markdown,
    el("p", "保存不会替换当前会话中的旧版本。请从输入框旁的「业务上下文」重新应用。", "muted"), editorStatus, save);
  editor.append(form);

  let data = null, revision = 0, loadId = 0, viewKey = null;
  let busy = false, editingId = null, draft = new Set();
  const route = () => `/v1/sessions/${encodeURIComponent(state.sessionId)}/business-context`;
  const connected = () => Boolean(state.sessionId && state.sessionReady);
  const isCurrent = (stamp, path) => stamp === revision && connected() && route() === path;

  function setBusy(value) {
    busy = value;
    save.disabled = create.disabled = refresh.disabled = upload.disabled = value || !connected();
    draftChanged();
  }

  function render() {
    trigger.disabled = !connected();
    const active = data?.active ?? state.session?.business_context ?? [];
    trigger.textContent = "业务上下文" + (connected() && active.length ? ` · ${active.length}` : "");
    activeList.replaceChildren();
    library.replaceChildren();
    if (!connected()) {
      notice.textContent = "连接数据库后可管理并选用 Markdown 文档。";
      return;
    }
    if (!data) return;
    notice.textContent = `单篇约 ${data.limits.document_tokens.toLocaleString()} tokens 上限。上传 .md 文件或新建文档；编辑不改变已应用的版本。`;
    activeHeading.textContent = `当前会话使用 · ${active.length} 篇 · 约 ${tokenCount(active).toLocaleString()} tokens`;
    for (const item of active) {
      const latest = data.files.find((file) => file.id === item.id);
      const suffix = !latest ? " · 库中已删除" : latest.revision !== item.revision ? " · 有新版" : "";
      activeList.append(el("li", item.name + suffix, "bc-active"));
    }
    if (!active.length) activeList.append(el("li", "未选用文档", "muted"));
    for (const file of data.files) {
      const row = el("li", undefined, "bc-row");
      const label = el("div", undefined, "bc-file");
      label.append(el("strong", file.name), el("small", `约 ${file.estimatedTokens} tokens${data.default_ids.includes(file.id) ? " · 默认" : ""}`, "muted"));
      const edit = button("编辑"), remove = button("删除", "ghost danger");
      edit.setAttribute("aria-label", `编辑 ${file.name}`);
      remove.setAttribute("aria-label", `删除 ${file.name}`);
      edit.onclick = () => void openEditor(file.id);
      remove.onclick = () => void removeFile(file);
      row.append(label, edit, remove);
      library.append(row);
    }
    if (!data.files.length) library.append(el("li", "还没有文档，可新建，或拖入 / 上传 .md 文件（指标口径、业务规则、事件字段说明）。", "muted"));
  }

  async function load({ report = notice } = {}) {
    if (!connected()) return false;
    const stamp = revision, path = route(), request = ++loadId;
    try {
      const loaded = await api(path);
      if (!isCurrent(stamp, path) || request !== loadId) return false;
      data = loaded;
      render();
      return true;
    } catch (error) {
      if (isCurrent(stamp, path) && request === loadId) report.textContent = error.message;
      return false;
    }
  }

  function sessionChanged() {
    const key = connected() ? JSON.stringify([state.sessionId, state.session?.created_at, state.token]) : null;
    // A status refresh after task completion must not close an open editor or discard its draft.
    if (key !== null && key === viewKey) {
      if (!busy && !editor.open && !picker.open) void load();
      return;
    }
    viewKey = key;
    revision++;
    data = null;
    picker.close();
    editor.close();
    setBusy(false);
    notice.textContent = connected() ? "读取文档库…" : "";
    activeHeading.textContent = "当前会话使用";
    render();
    void load();
  }

  function draftChanged() {
    const count = tokenCount((data?.files ?? []).filter((file) => draft.has(file.id)));
    const limit = data?.limits.selection_tokens ?? 0;
    estimate.textContent = `已勾选 ${draft.size} 篇 · 约 ${count.toLocaleString()} / ${limit.toLocaleString()} tokens`;
    apply.disabled = defaults.disabled = busy || !data || count > limit;
  }

  trigger.onclick = async () => {
    if (!connected() || busy) return;
    status.textContent = "读取文档库…";
    choices.replaceChildren();
    draft = new Set();
    picker.showModal();
    setBusy(true);
    const stamp = revision, path = route();
    const loaded = await load({ report: status });
    if (!isCurrent(stamp, path)) return;
    if (!loaded) {
      setBusy(false);
      apply.disabled = defaults.disabled = true;
      return;
    }
    const active = new Map(data.active.map((file) => [file.id, file.revision]));
    const available = new Set(data.files.map((file) => file.id));
    draft = new Set([...active.keys()].filter((id) => available.has(id)));
    for (const file of data.files) {
      const option = el("label", undefined, "bc-option"), check = el("input");
      check.type = "checkbox";
      check.checked = draft.has(file.id);
      check.onchange = () => {
        if (check.checked) draft.add(file.id);
        else draft.delete(file.id);
        draftChanged();
      };
      const updated = check.checked && active.get(file.id) !== file.revision;
      option.append(check, el("span", `${file.name} · 约 ${file.estimatedTokens} tokens${updated ? " · 有新版" : ""}`));
      choices.append(option);
    }
    if (!data.files.length) choices.append(el("p", "暂无文档。请先在右侧「业务资料」新建或上传 .md 文件。", "muted"));
    status.textContent = data.active.some((file) => !draft.has(file.id)) ? "部分已选文档已删除，重新应用会将它们从会话移除。" : "";
    setBusy(false);
  };

  async function updateSelection(target) {
    if (!connected() || busy) return;
    const stamp = revision, path = route();
    const ids = [...draft];
    setBusy(true);
    try {
      const updated = await api(`${path}/${target}`, { method: "PUT", body: { ids } });
      if (!isCurrent(stamp, path)) return;
      data = { ...data, ...updated };
      render();
      if (target === "selection") {
        if (state.session?.session_id === state.sessionId) state.session.business_context = updated.active;
        picker.close();
      } else {
        status.textContent = "已保存为此连接的默认选用项；不改变当前会话。";
      }
    } catch (error) {
      if (isCurrent(stamp, path)) status.textContent = error.message;
    } finally {
      if (isCurrent(stamp, path)) setBusy(false);
    }
  }
  apply.onclick = () => void updateSelection("selection");
  defaults.onclick = () => void updateSelection("defaults");

  async function openEditor(id = null) {
    if (!connected() || busy) return;
    const stamp = revision, path = route();
    setBusy(true);
    try {
      const file = id ? (await api(`${path}/${id}`)).file : { name: "", content: "" };
      if (!isCurrent(stamp, path)) return;
      editingId = id;
      editorStatus.textContent = "";
      name.value = file.name;
      markdown.value = file.content;
      editor.showModal();
      name.focus();
    } catch (error) {
      if (isCurrent(stamp, path)) notice.textContent = error.message;
    } finally {
      if (isCurrent(stamp, path)) setBusy(false);
    }
  }
  create.onclick = () => void openEditor();
  refresh.onclick = () => void load();

  async function importFiles(fileList) {
    if (!connected() || busy) return;
    const files = [...fileList];
    if (!files.length) return;
    if (files.length > MAX_IMPORT_FILES) {
      notice.textContent = `一次最多上传 ${MAX_IMPORT_FILES} 个文件，请分批上传。`;
      return;
    }
    const stamp = revision, path = route();
    setBusy(true);
    notice.textContent = `读取 ${files.length} 个文件…`;
    const documents = [], rejected = [];
    for (const file of files) {
      let content;
      try { content = await file.text(); }
      catch { rejected.push(`${file.name}：读取失败`); continue; }
      if (!content.trim()) { rejected.push(`${file.name}：内容为空`); continue; }
      if (content.length > MAX_IMPORT_CHARS) { rejected.push(`${file.name}：超过 ${MAX_IMPORT_CHARS.toLocaleString()} 字符上限`); continue; }
      documents.push({ name: documentName(file.name), content });
    }
    try {
      if (!documents.length) {
        notice.textContent = rejected.join("\n");
        return;
      }
      notice.textContent = "上传中…";
      const result = await api(`${path}/import`, { method: "POST", body: { documents } });
      if (!isCurrent(stamp, path)) return;
      const summary = [];
      if (result.created.length) summary.push(`新增 ${result.created.length} 篇：${result.created.map((file) => file.name).join("、")}`);
      if (result.updated.length) summary.push(`替换同名 ${result.updated.length} 篇：${result.updated.map((file) => file.name).join("、")}`);
      for (const item of result.failed) summary.push(`${item.name}：${item.message}`);
      summary.push(...rejected);
      if (result.created.length || result.updated.length) summary.push("已存入文档库；重新应用「业务上下文」后才会进入本会话。");
      await load();
      if (isCurrent(stamp, path)) notice.textContent = summary.join("\n");
    } catch (error) {
      if (isCurrent(stamp, path)) notice.textContent = error.message;
    } finally {
      if (isCurrent(stamp, path)) setBusy(false);
    }
  }

  upload.onclick = () => { if (connected() && !busy) fileInput.click(); };
  fileInput.onchange = () => {
    const files = fileInput.files ? [...fileInput.files] : [];
    fileInput.value = "";
    void importFiles(files);
  };
  // Dropping .md files onto the panel reuses the same import path as the picker.
  panel.addEventListener("dragover", (event) => {
    if (!connected() || busy || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("bc-drop");
  });
  panel.addEventListener("dragleave", (event) => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove("bc-drop");
  });
  panel.addEventListener("drop", (event) => {
    panel.classList.remove("bc-drop");
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void importFiles(event.dataTransfer.files);
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!connected() || busy) return;
    const stamp = revision, path = route(), id = editingId;
    setBusy(true);
    try {
      await api(id ? `${path}/${id}` : path, { method: id ? "PUT" : "POST", body: { name: name.value, content: markdown.value } });
      if (!isCurrent(stamp, path)) return;
      editor.close();
      await load();
    } catch (error) {
      if (isCurrent(stamp, path)) editorStatus.textContent = error.message;
    } finally {
      if (isCurrent(stamp, path)) setBusy(false);
    }
  };

  async function removeFile(file) {
    if (!connected() || busy || !window.confirm(`删除「${file.name}」？已选用的会话仍保留当前快照，直到重新应用。`)) return;
    const stamp = revision, path = route();
    setBusy(true);
    try {
      await api(`${path}/${file.id}`, { method: "DELETE" });
      if (isCurrent(stamp, path)) await load();
    } catch (error) {
      if (isCurrent(stamp, path)) notice.textContent = error.message;
    } finally {
      if (isCurrent(stamp, path)) setBusy(false);
    }
  }

  sessionChanged();
  return { sessionChanged };
}
