import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../web/composer-context.js", import.meta.url), "utf8");
const objects = (schema: string, offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ schema, name: `table_${offset + i + 1}` }));

function setup() {
  class Element extends EventTarget {
    children: Element[] = [];
    attributes = new Map<string, string>();
    parent?: Element;
    id = "";
    hidden = true;
    disabled = false;
    value = "";
    selectionStart = 0;
    selectionEnd = 0;
    scrollTop = 0;
    clientHeight = 150;
    textContent = "";
    onclick?: () => unknown;
    constructor(readonly tag: string) { super(); }
    get scrollHeight() { return this.children.length * 30; }
    append(...children: Element[]) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = undefined;
    }
    replaceChildren(...children: Element[]) {
      for (const child of this.children) child.parent = undefined;
      this.children = [];
      this.append(...children);
    }
    querySelectorAll(tag: string) { return this.children.filter(child => child.tag === tag); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    setRangeText(value: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + value + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + value.length;
    }
    focus() {}
    scrollIntoView() {}
  }

  const elements = Object.fromEntries("goal scopeToggle scopePicker scopeSearch scopeChoices tablePicker replyPreview replyExcerpt clearReply scopeName"
    .split(" ").map(id => [id, Object.assign(new Element("div"), { id })]));
  const goal = elements.goal!, mention = elements.tablePicker!;
  const state = { sessionId: "sess_a", session: { engine: "doris", database: "analytics" } };
  const requests: Array<{
    url: URL; signal?: AbortSignal; resolve: (result: unknown) => void; reject: (error: Error) => void;
  }> = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const document = {
    getElementById: (id: string) => elements[id] ?? mention.children.find(child => child.id === id),
    createElement: (tag: string) => new Element(tag), addEventListener() {},
  };
  const api = (path: string, { signal }: { signal?: AbortSignal } = {}) => new Promise((resolve, reject) => {
    requests.push({ url: new URL(path, "https://example.test"), signal, resolve, reject });
  });
  const vm = createContext({ document, api, state, Event, AbortController, URLSearchParams,
    setTimeout(fn: () => void) { timers.set(++seq, fn); return seq; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  runInContext(source.replace(/^export /gm, "") + "\nvar picker = initComposerContext({api, state}); picker.update(false);", vm);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    state, goal, mention, requests, elements, picker: vm.picker, flush,
    type(value: string) {
      goal.value = value;
      goal.selectionStart = goal.selectionEnd = value.length;
      goal.dispatchEvent(new Event("input"));
      for (const [id, fn] of timers) { timers.delete(id); fn(); }
    },
    scrollToBottom() {
      mention.scrollTop = mention.scrollHeight - mention.clientHeight;
      mention.dispatchEvent(new Event("scroll"));
    },
    key(key: string) {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key });
      goal.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

test("@ table picker appends all pages on scroll and can select a table past the first 30", async () => {
  const ui = setup();
  ui.type("查询 @");
  assert.equal(ui.requests[0]!.url.searchParams.get("limit"), "30");
  assert.equal(ui.requests[0]!.url.searchParams.get("match"), "names");
  assert.equal(ui.requests[0]!.url.searchParams.get("offset"), "0");
  ui.requests[0]!.resolve({ objects: objects("analytics", 0, 30), nextOffset: 30 });
  await ui.flush();
  const first = ui.mention.children[0];
  assert.match(ui.mention.children.at(-1)!.textContent, /加载更多/);
  ui.scrollToBottom();
  ui.scrollToBottom();
  assert.equal(ui.requests.length, 2, "scroll does not duplicate an in-flight page");
  assert.equal(ui.requests[1]!.url.searchParams.get("offset"), "30");
  ui.requests[1]!.resolve({ objects: [...objects("analytics", 29, 3), ...objects("other", 40, 1)], nextOffset: null });
  await ui.flush();
  assert.equal(ui.mention.children[0], first, "previous results are not rebuilt");
  assert.equal(ui.mention.children.length, 32, "ignore duplicates and results outside the selected database");
  assert.equal(ui.mention.children.at(-1)!.textContent, "table_32");
  ui.scrollToBottom();
  assert.equal(ui.requests.length, 2, "no further request after exhaustion");
  ui.mention.children.at(-1)!.onclick!();
  assert.equal(ui.goal.value, '查询 @`analytics`.`table_32` ');
  assert.equal(ui.mention.hidden, true);
  assert.equal(ui.picker.request().tables[0].name, "table_32");
});

test("@ load-more and retry work by click and keyboard without losing the current results", async () => {
  const ui = setup();
  ui.type("@table");
  ui.requests[0]!.resolve({ objects: objects("analytics", 0, 30), nextOffset: 30 });
  await ui.flush();
  const more = ui.mention.children.at(-1)!;
  more.onclick!();
  assert.equal(ui.mention.children.at(-1), more, "the click target stays mounted while loading");
  assert.equal(more.disabled, true);
  ui.requests[1]!.reject(new Error("network error"));
  await ui.flush();
  assert.equal(ui.mention.children.length, 31);
  assert.match(more.textContent, /重试/);
  ui.scrollToBottom();
  assert.equal(ui.requests.length, 2, "an error requires explicit retry");
  assert.equal(ui.key("ArrowUp"), true);
  assert.equal(ui.goal.attributes.get("aria-activedescendant"), "tableOption30");
  assert.equal(ui.key("Enter"), true);
  assert.equal(ui.requests[2]!.url.searchParams.get("offset"), "30");
  assert.equal(ui.requests[2]!.url.searchParams.get("search"), "table");
  ui.requests[2]!.resolve({ objects: objects("analytics", 30, 3), nextOffset: null });
  await ui.flush();
  assert.equal(ui.mention.children.length, 33);
  assert.equal(ui.key("Enter"), true);
  assert.equal(ui.goal.value, '@`analytics`.`table_31` ');
});

test("@ reuses a recent page without a request and drops it after reconnecting", async () => {
  const ui = setup();
  ui.type("@users");
  ui.requests[0]!.resolve({ objects: [{ schema: "analytics", name: "users" }], nextOffset: null });
  await ui.flush();
  ui.type(""); ui.type("@users");
  assert.deepEqual(ui.mention.children.map(child => child.textContent), ["users"]);
  assert.equal(ui.requests.length, 1);
  Object.assign(ui.state.session, { created_at: "reconnected" });
  ui.picker.update(false);
  ui.type("@users");
  assert.equal(ui.requests.length, 2);
});

test("@ discards pending pages when the search or selected database changes", async () => {
  const ui = setup();
  ui.type("@");
  ui.requests[0]!.resolve({ objects: objects("analytics", 0, 30), nextOffset: 30 });
  await ui.flush();
  ui.scrollToBottom();
  ui.type("@new");
  assert.equal(ui.requests[1]!.signal?.aborted, true);
  assert.equal(ui.requests[2]!.url.searchParams.get("offset"), "0");
  ui.requests[1]!.resolve({ objects: objects("analytics", 30, 1), nextOffset: null });
  await ui.flush();
  assert.equal(ui.mention.children[0]!.textContent, "正在查找数据表…");

  const opening = ui.elements.scopeToggle!.onclick!();
  assert.equal(ui.requests[2]!.signal?.aborted, true);
  assert.equal(ui.requests[3]!.url.searchParams.get("counts"), "false");
  ui.requests[3]!.resolve({ scopes: ["analytics", "warehouse"], default_scope: "analytics" });
  await opening;
  ui.elements.scopeChoices!.children[1]!.onclick!();
  ui.type("@new");
  assert.equal(ui.requests[4]!.url.searchParams.get("schema"), "warehouse");
  assert.equal(ui.requests[4]!.url.searchParams.get("offset"), "0");
  ui.requests[2]!.resolve({ objects: [{ schema: "analytics", name: "new_old" }], nextOffset: null });
  ui.requests[4]!.resolve({ objects: [{ schema: "warehouse", name: "new_current" }], nextOffset: null });
  await ui.flush();
  assert.deepEqual(ui.mention.children.map(child => child.textContent), ["new_current"]);
});
