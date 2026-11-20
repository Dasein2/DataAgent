const engineNames = { postgres: "PostgreSQL", mysql: "MySQL", doris: "Apache Doris", starrocks: "StarRocks" };
const iconPaths = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pin: '<path d="M16 3H8l1 6-3 4v2h12v-2l-3-4 1-6ZM12 15v6"/>',
  rename: '<path d="m14 6 4 4M4 20l1-5L16 4a2.8 2.8 0 0 1 4 4L9 19l-5 1Z"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
  open: '<path d="M13 4h7v7M20 4l-9 9M10 5H5v14h14v-5"/>',
  remove: '<path d="M4 6h16M9 6V3h6v3m3 0-1 14H7L6 6m4 4v6m4-6v6"/>',
};

export function sessionTitle(session) {
  return session.title || session.tasks?.[0]?.goal || "未命名会话";
}

export function buildAssetGroups(profiles, sessions, pinnedGroups = new Set(), pinnedSessions = new Set()) {
  const groups = new Map();
  const byId = new Map();
  function addAsset(groupId, title, asset) {
    if (!groups.has(groupId)) groups.set(groupId, { key: groupId, title, assets: [], pinned: pinnedGroups.has(groupId) });
    groups.get(groupId).assets.push(asset);
    byId.set(asset.key, asset);
    return asset;
  }
  for (const profile of [...profiles].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
    const group = profile.group || "";
    addAsset("group:" + group, group || "未分组", {
      key: profile.id || "legacy:" + profile.name, title: profile.name,
      engine: profile.engine, target: [profile.host, profile.database].filter(Boolean).join(" / "), profile, sessions: [],
    });
  }
  // A pinned session floats to the top of its connection; otherwise the order is creation time, so
  // opening a session no longer moves it (opening touches last_used_at, not created_at).
  for (const session of [...sessions].sort((a, b) => sessionOrder(a, b, pinnedSessions))) {
    let asset = session.connection_profile_id && byId.get(session.connection_profile_id);
    if (!asset) {
      const key = "history:" + JSON.stringify([session.connection_profile_id, session.engine, session.host, session.database]);
      asset = byId.get(key) || addAsset("history", "未关联历史", {
        key, title: session.database || "数据库", engine: session.engine, target: session.host || "", sessions: [],
      });
    }
    asset.sessions.push(session);
  }
  const fallbackOrder = (key) => key === "history" ? 2 : key === "group:" ? 1 : 0;
  return [...groups.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
    fallbackOrder(a.key) - fallbackOrder(b.key) || a.title.localeCompare(b.title, "zh-CN"));
}

function sessionOrder(a, b, pinnedSessions) {
  const pinnedA = pinnedSessions.has(a.session_id);
  const pinnedB = pinnedSessions.has(b.session_id);
  if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
  const timeA = a.created_at || sessionTime(a);
  const timeB = b.created_at || sessionTime(b);
  if (timeA !== timeB) return timeB.localeCompare(timeA);
  return String(a.session_id).localeCompare(String(b.session_id));
}

function sessionTime(session) {
  return session.last_used_at || session.created_at || "";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function icon(name) {
  const node = element("span", "asset-icon");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + iconPaths[name] + '</svg>';
  return node;
}

function createActionMenu() {
  const menu = element("div", "asset-menu");
  menu.id = "assetActionMenu";
  menu.setAttribute("popover", "manual");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  let anchor = null;

  function reset() {
    anchor?.setAttribute("aria-expanded", "false");
    anchor = null;
  }
  function close(restoreFocus = false) {
    const previous = anchor;
    if (menu.matches(":popover-open")) menu.hidePopover();
    reset();
    if (restoreFocus) previous?.focus({ preventScroll: true });
  }
  // Ignore the trigger here so its click can close the menu instead of reopening it.
  document.addEventListener("pointerdown", (event) => {
    if (anchor && !anchor.contains(event.target) && !menu.contains(event.target)) close();
  }, true);
  document.addEventListener("focusin", (event) => {
    if (anchor && !anchor.contains(event.target) && !menu.contains(event.target)) close();
  });
  // Do not leave the menu floating next to a different row after a scroll.
  document.addEventListener("scroll", (event) => { if (anchor && !menu.contains(event.target)) close(menu.contains(document.activeElement)); }, true);
  window.addEventListener("resize", () => close(menu.contains(document.activeElement)));

  function open(trigger, actions, last = false) {
    close();
    anchor = trigger;
    menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
    menu.replaceChildren(...actions.map(({ glyph, label, run, danger }) => {
      const command = button("asset-menu-item" + (danger ? " asset-menu-danger" : ""));
      command.setAttribute("role", "menuitem");
      command.tabIndex = -1;
      command.append(icon(glyph), element("span", "", label));
      command.onclick = () => { close(true); run(); };
      return command;
    }));
    const rect = trigger.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    menu.style.left = menu.style.top = "0px";
    menu.showPopover({ source: trigger });
    const { offsetWidth: width, offsetHeight: height } = menu;
    const below = clientHeight - rect.bottom;
    const above = rect.top;
    const top = height + 12 > below && above > below ? rect.top - height - 4 : rect.bottom + 4;
    menu.style.left = Math.max(8, Math.min(rect.right - width, clientWidth - width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(top, clientHeight - height - 8)) + "px";
    trigger.setAttribute("aria-expanded", "true");
    (last ? menu.lastElementChild : menu.firstElementChild)?.focus({ preventScroll: true });
  }

  menu.addEventListener("keydown", (event) => {
    const items = [...menu.children];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Tab") { close(true); return; }
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") close(true);
    else items[next]?.focus();
  });

  return {
    close,
    containsFocus: () => menu.contains(document.activeElement),
    trigger(name, key, actions) {
      const trigger = button("asset-more");
      trigger.dataset.assetFocus = "menu:" + key;
      trigger.title = "更多操作";
      trigger.setAttribute("aria-label", `${name}：更多操作`);
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-controls", menu.id);
      trigger.setAttribute("aria-expanded", "false");
      trigger.append(icon("more"));
      trigger.onclick = () => {
        if (anchor === trigger && menu.matches(":popover-open")) close(true);
        else open(trigger, actions);
      };
      trigger.onkeydown = (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        open(trigger, actions, event.key === "ArrowUp");
      };
      return trigger;
    },
  };
}

function createRenameDialog() {
  const dialog = element("dialog", "asset-rename-dialog");
  const heading = element("h2");
  heading.id = "assetRenameTitle";
  dialog.setAttribute("aria-labelledby", heading.id);
  const form = element("form");
  const input = element("input");
  input.id = "assetRenameName";
  input.required = true;
  input.autofocus = true;
  const label = element("label", "", "名称");
  label.htmlFor = input.id;
  const notice = element("p", "asset-rename-error");
  notice.setAttribute("role", "alert");
  const footer = element("div", "asset-rename-actions");
  const cancel = button("ghost", "取消");
  const save = element("button", "primary", "保存");
  footer.append(cancel, save);
  form.append(label, input, notice, footer);
  dialog.append(heading, form);
  document.body.append(dialog);
  cancel.onclick = () => dialog.close();
  dialog.oncancel = (event) => { if (save.disabled) event.preventDefault(); };
  input.oninput = () => { input.setCustomValidity(""); notice.textContent = ""; };

  return ({ title, value, limit, run, restore }) => {
    heading.textContent = title;
    input.maxLength = limit;
    input.value = value.slice(0, limit);
    input.oninput();
    dialog.showModal();
    input.select();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const name = input.value.trim();
      if (!name) {
        input.setCustomValidity("请输入名称");
        input.reportValidity();
        return;
      }
      save.disabled = cancel.disabled = input.disabled = true;
      try {
        await run(name);
        dialog.close();
        restore();
      } catch (error) {
        notice.textContent = error.message || "保存失败，请重试";
      } finally {
        save.disabled = cancel.disabled = input.disabled = false;
        if (dialog.open) input.focus();
      }
    };
  };
}

export function initAssets({ list, search, toggle, onEdit, onOpen, onDelete, onDeleteAsset, onRenameSession, onRenameGroup }) {
  const layout = list.closest("main");
  const collapseKey = "data-agent-assets-collapsed";
  const menu = createActionMenu();
  const rename = createRenameDialog();
  function setCollapsed(collapsed) {
    if (collapsed) menu.close();
    layout.classList.toggle("assets-collapsed", collapsed);
    const label = collapsed ? "展开资产侧栏" : "收起资产侧栏";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.textContent = collapsed ? "›" : "‹";
  }
  setCollapsed(localStorage.getItem(collapseKey) === "true");
  toggle.onclick = () => {
    const collapsed = toggle.getAttribute("aria-expanded") === "true";
    setCollapsed(collapsed);
    localStorage.setItem(collapseKey, String(collapsed));
  };
  const expanded = new Map();
  let profiles = [], sessions = [], groups = [], selected = null, unreadSessions = new Set(), error = "", loading = true;
  const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
  const pinnedGroupsKey = "data-agent-pinned-group-keys";
  function storedPins(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return Array.isArray(value) ? value.filter((name) => typeof name === "string") : null;
    } catch { return null; }
  }
  const pinnedGroups = new Set(storedPins(pinnedGroupsKey) ??
    (storedPins("data-agent-pinned-groups") ?? []).map((name) => "group:" + name));
  const pinnedSessionsKey = "data-agent-pinned-session-ids";
  const pinnedSessions = new Set(storedPins(pinnedSessionsKey) ?? []);

  function savePinnedSessions() {
    try { localStorage.setItem(pinnedSessionsKey, JSON.stringify([...pinnedSessions])); } catch { /* keep session-local state */ }
  }

  function refreshPins() {
    try { localStorage.setItem(pinnedGroupsKey, JSON.stringify([...pinnedGroups])); } catch { /* keep session-local state */ }
    savePinnedSessions();
    groups = buildAssetGroups(profiles, sessions, pinnedGroups, pinnedSessions);
    render();
  }

  let branchId = 0;
  // Clicking a visible row means its branches are already open, so the selection must not re-expand
  // anything: doing that used to uncover collapsed rows and pop a scrollbar into the sidebar.
  let openedFromRow = false;
  function branch(key, classes, title, count, defaultOpen, items) {
    const branch = element("div", classes);
    const row = element("div", "asset-row");
    const children = element("div", "asset-children");
    children.id = "asset-branch-" + ++branchId;
    const summary = button("asset-summary");
    summary.dataset.assetFocus = "branch:" + key;
    summary.setAttribute("aria-controls", children.id);
    const label = element("span", "asset-label", title);
    summary.title = title;
    summary.append(label, element("span", "asset-count", String(count)));
    const setOpen = (open) => {
      children.hidden = !open;
      summary.setAttribute("aria-expanded", String(open));
    };
    setOpen(Boolean(search.value.trim()) || (expanded.get(key) ?? defaultOpen));
    summary.onclick = () => {
      const open = children.hidden;
      if (!search.value.trim()) expanded.set(key, open);
      setOpen(open);
    };
    row.append(summary, menu.trigger(title, key, items));
    branch.append(row, children);
    return { branch, summary, children };
  }

  function focusRow(key) {
    const target = [...list.querySelectorAll("[data-asset-focus]")].find((node) => node.dataset.assetFocus === key);
    (target?.getClientRects().length ? target : search).focus({ preventScroll: true });
  }

  function render() {
    menu.close(menu.containsFocus());
    const focusKey = document.activeElement?.dataset?.assetFocus;
    const query = search.value.trim().toLowerCase();
    const matches = (...parts) => parts.join(" ").toLowerCase().includes(query);
    const groupNodes = [];
    for (const group of groups) {
      const assets = group.assets.flatMap((asset) => {
        const visible = matches(group.title, asset.title, asset.target, engineNames[asset.engine]);
        const sessions = visible ? asset.sessions : asset.sessions.filter((s) => matches(sessionTitle(s), s.session_id));
        return visible || sessions.length ? [{ ...asset, sessions }] : [];
      });
      if (!assets.length) continue;
      const groupActions = [{ glyph: "pin", label: group.pinned ? "取消置顶" : "置顶", run: () => {
        if (group.pinned) pinnedGroups.delete(group.key);
        else pinnedGroups.add(group.key);
        refreshPins();
      } }];
      if (group.key !== "history") {
        const oldName = group.key.slice("group:".length);
        groupActions.push({ glyph: "rename", label: "重命名", run: () => {
          let nextKey = group.key;
          rename({ title: "重命名分组", value: oldName, limit: 60, restore: () => focusRow("menu:" + nextKey), run: async (name) => {
            if (name === oldName) return;
            await onRenameGroup(oldName, name);
            nextKey = "group:" + name;
            if (expanded.has(group.key)) { expanded.set(nextKey, expanded.get(group.key)); expanded.delete(group.key); }
            if (pinnedGroups.delete(group.key)) pinnedGroups.add(nextKey);
            refreshPins();
          } });
        } });
      }
      const groupNode = branch(group.key, "asset-group", group.title, assets.length, true, groupActions);
      groupNode.summary.prepend(element("span", "asset-folder"));
      if (group.pinned) groupNode.summary.title = group.title + " · 已置顶";
      groupNode.children.classList.add("asset-group-children");
      for (const asset of assets) {
        const active = asset.sessions.some((session) => session.session_id === selected);
        const items = asset.profile ? [
          { glyph: "add", label: "新建会话", run: () => onEdit(asset.profile, true) },
          { glyph: "settings", label: "连接设置", run: () => onEdit(asset.profile) },
          { glyph: "remove", label: "删除连接…", run: () => onDeleteAsset(asset.profile), danger: true },
        ] : [{ glyph: "open", label: "打开最近会话", run: () => onOpen(asset.sessions[0]) }];
        const connection = branch(asset.key, "asset-connection", asset.title, asset.sessions.length, active || !asset.profile, items);
        const engine = engineNames[asset.engine] || asset.engine || "数据库";
        connection.summary.title = [asset.title, engine, asset.target].filter(Boolean).join(" · ");
        const db = element("span", "asset-db");
        db.dataset.engine = asset.engine || "";
        connection.summary.prepend(db);
        for (const session of asset.sessions) {
          const row = element("div", "asset-row asset-session");
          const open = button("asset-session-open");
          const key = "session:" + session.session_id;
          open.dataset.assetFocus = key;
          open.setAttribute("aria-current", session.session_id === selected ? "true" : "false");
          const title = sessionTitle(session);
          const status = { ready: "已连接", unavailable: "连接不可用", closed: "已关闭", expired: "已过期" }[session.status] || "历史会话";
          const isRunning = Boolean(session.current_task_id);
          const isSelected = session.session_id === selected;
          const hasUnread = !isSelected && !isRunning && unreadSessions.has(session.session_id);
          open.title = `${title} · ${status}${isRunning ? " · 运行中" : ""}${hasUnread ? " · 有新消息" : ""}`;
          const dot = element("span", "asset-status");
          dot.dataset.ready = String(session.status === "ready");
          const date = new Date(sessionTime(session));
          const taskIndicator = element("span", "asset-task-indicator");
          if (isRunning) {
            const spinner = element("span", "asset-spinner");
            taskIndicator.append(spinner);
          } else if (hasUnread) {
            const idleDot = element("span", "asset-task-idle");
            taskIndicator.append(idleDot);
          }
          open.append(dot, element("span", "asset-label", title), element("span", "asset-date", isNaN(date.valueOf()) ? "" : dateFormat.format(date)), taskIndicator);
          open.onclick = () => { openedFromRow = true; onOpen(session); };
          row.append(open, menu.trigger(title, key, [
            { glyph: "pin", label: pinnedSessions.has(session.session_id) ? "取消置顶" : "置顶", run: () => {
              if (pinnedSessions.has(session.session_id)) pinnedSessions.delete(session.session_id);
              else pinnedSessions.add(session.session_id);
              refreshPins();
            } },
            { glyph: "rename", label: "重命名", run: () => rename({ title: "重命名会话", value: session.title || session.tasks?.[0]?.goal || "", limit: 80,
              restore: () => focusRow("menu:" + key), run: (name) => name === session.title ? undefined : onRenameSession(session.session_id, name) }) },
            { glyph: "remove", label: "删除会话…", run: () => onDelete(session), danger: true },
          ]));
          connection.children.append(row);
        }
        if (!asset.sessions.length) connection.children.append(element("p", "asset-empty", "暂无会话"));
        groupNode.children.append(connection.branch);
      }
      groupNodes.push(groupNode.branch);
    }
    const messages = [];
    if (error) messages.push(element("p", "asset-empty", error));
    if (!groupNodes.length && !error) messages.push(element("p", "asset-empty", loading ? "正在载入资产…" : query ? "没有匹配的资产或会话" : "暂无数据库连接，点击 ＋ 添加。"));
    list.replaceChildren(...messages, ...groupNodes);
    if (focusKey) focusRow(focusKey);
  }

  search.addEventListener("input", render);
  return {
    update(nextProfiles, nextSessions, options = {}) {
      const next = options.selected;
      profiles = nextProfiles;
      sessions = nextSessions;
      unreadSessions = options.unreadSessions || new Set();
      groups = buildAssetGroups(profiles, sessions, pinnedGroups, pinnedSessions);
      if (next && selected !== next && !openedFromRow) {
        for (const group of groups) {
          const asset = group.assets.find((entry) => entry.sessions.some((session) => session.session_id === next));
          if (asset) { expanded.set(group.key, true); expanded.set(asset.key, true); }
        }
      }
      selected = next;
      error = options.error || "";
      loading = options.loading;
      openedFromRow = false;
      render();
    },
  };
}
