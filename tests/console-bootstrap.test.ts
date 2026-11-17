import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";

test("an unavailable optional model module does not block console bootstrap and can be retried", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotMatch(script, /import\s+[^;\n]+from\s+["']\/model-manager\.js["']/);
  const loader = script.slice(script.indexOf("// Optional panels"));
  assert.match(loader, /async function openModelManager/);
  const elements: Record<string, any> = {
    modelManager: { innerHTML: "" }, legacyModel: { open: false }, btnModelManagerRetry: {},
  };
  const urls: string[] = [];
  let fail = true, refreshes = 0, inits = 0;
  const context = createContext({
    $: (id: string) => elements[id],
    api: () => {}, enhanceSelect: () => {}, loadModel: async () => {}, loadChannels: async () => {},
    console: { warn() {} },
    importManager: async (url: string) => {
      urls.push(url);
      if (fail) throw new Error("HTTP 404");
      return { initModelManager: () => { inits++; return { refresh: async () => { refreshes++; } }; } };
    },
  });
  // Inject only the transport boundary; exercise the same loader and recovery branches as the page.
  runInContext(loader.replace("await import(", "await importManager("), context);
  await runInContext("openModelManager()", context);
  assert.equal(elements.legacyModel.open, true);
  assert.match(elements.modelManager.innerHTML, /重启项目/);
  assert.equal(typeof elements.btnModelManagerRetry.onclick, "function");
  fail = false;
  await Promise.all([runInContext("openModelManager()", context), runInContext("openModelManager()", context)]);
  assert.deepEqual(urls, ["/model-manager.js?load=1", "/model-manager.js?load=2"]);
  assert.equal(inits, 1, "simultaneous clicks share one load");
  assert.equal(refreshes, 1);
  await runInContext("openModelManager()", context);
  assert.equal(urls.length, 2, "successful initialization is reused");
  assert.equal(refreshes, 2);
});
