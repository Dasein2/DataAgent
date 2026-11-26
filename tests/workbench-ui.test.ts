import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, Script } from "node:vm";
import { it } from "node:test";
import { createServer } from "node:http";
import { createHttpApp } from "../src/api/http.js";
import { AnalysisService } from "../src/agent/service.js";
import { testConfig, cleanup } from "./support.js";

it("all eagerly imported console modules are served over HTTP, including progress and evidence", async () => {
  const app = await testConfig();
  const service = await AnalysisService.create(app);
  const server = createServer(await createHttpApp(service));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await fetch(base).then(res => res.text());
    const urls = [...page.matchAll(/^import[^\n]+from "(\/[^"\n]+)";/gm)].map(match => match[1]!);
    assert.ok(urls.includes("/task-progress.js"));
    assert.ok(urls.includes("/answer-evidence.js"));
    for (const url of urls) {
      const response = await fetch(base + url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get("content-type")!, /javascript/, url);
      assert.ok((await response.text()).length > 0);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.shutdown(); await cleanup(app);
  }
});

it("catalog qualifies names using the engine delimiter and escapes embedded delimiters", async () => {
  const source = await readFile(new URL("../web/catalog.js", import.meta.url), "utf8");
  const context = createContext();
  runInContext(source.replaceAll("export function", "function"), context);
  assert.equal(runInContext(`qualifiedTableName("postgres", "Sales Data", 'a"b')`, context), '"Sales Data"."a""b"');
  assert.equal(runInContext('qualifiedTableName("doris", "Sales Data", "a`b")', context), "`Sales Data`.`a``b`");
});

it("uploaded Markdown file names become document names within the library limit", async () => {
  const source = await readFile(new URL("../web/business-context.js", import.meta.url), "utf8");
  const context = createContext();
  runInContext(source.replaceAll("export function", "function"), context);
  assert.equal(runInContext('documentName("GMV 口径.md")', context), "GMV 口径");
  assert.equal(runInContext('documentName("C:\\\\docs\\\\events.MARKDOWN")', context), "events");
  assert.equal(runInContext('documentName("notes.txt")', context), "notes");
  assert.equal(runInContext('documentName(".md")', context), ".md");
  assert.equal(runInContext('documentName("x".repeat(300) + ".md").length', context), 100);
});

it("console and workbench modules parse, and chart downloads retain live authentication state", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Script(script.replace(/^import[^\n]*;\s*$/gm, ""));
  for (const file of ["charts.js", "explore.js", "workbench.js", "business-context.js", "catalog.js", "assets.js", "task-activity.js", "task-tools.js", "task-progress.js", "answer-evidence.js"]) {
    const source = await readFile(new URL("../web/" + file, import.meta.url), "utf8");
    new Script(source.replace(/^import[^\n]*;\s*$/gm, "").replace(/export (?=(?:async )?function)/g, ""));
  }
  const charts = await readFile(new URL("../web/charts.js", import.meta.url), "utf8");
  const state = { token: "first-token" };
  const requests: Array<{ path: string; token?: string }> = [];
  const downloads: string[] = [];
  let revoked = 0;
  const context = createContext({
    document: {
      createElement: () => ({
        href: "",
        download: "",
        click() {
          downloads.push(this.download);
        },
        remove() {},
      }),
      body: { appendChild() {} },
    },
    URL: {
      createObjectURL: () => "blob:fixture",
      revokeObjectURL: () => {
        revoked++;
      },
    },
    setTimeout: (callback: () => void) => callback(),
    fetch: async (path: string, options: any) => {
      requests.push({ path, token: options.headers.authorization });
      return {
        ok: true,
        headers: { get: () => "attachment; filename*=UTF-8''%E8%AF%81%E6%8D%AE.csv" },
        blob: async () => ({}),
      };
    },
    state,
  });
  runInContext(charts.replaceAll("export function", "function") + "\nvar chartUi = createCharts({ state });", context);
  await runInContext('chartUi.downloadFile("/v1/results/res_fixture/data.csv", "fallback.csv")', context);
  state.token = "rotated-token";
  await runInContext('chartUi.downloadFile("/v1/artifacts/art_fixture/data.csv", "fallback.csv")', context);
  assert.deepEqual(
    requests.map((r) => r.token),
    ["Bearer first-token", "Bearer rotated-token"],
  );
  assert.deepEqual(downloads, ["证据.csv", "证据.csv"]);
  assert.equal(revoked, 2);
});
