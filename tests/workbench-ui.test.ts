import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, Script } from "node:vm";
import { it } from "node:test";

it("console and workbench modules parse, and chart downloads retain live authentication state", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Script(script.replace(/^import[^\n]*;\s*$/gm, ""));
  for (const file of ["charts.js", "explore.js", "workbench.js"]) {
    const source = await readFile(new URL("../web/" + file, import.meta.url), "utf8");
    new Script(source.replace(/export (?=(?:async )?function)/g, ""));
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
  runInContext(charts.replace("export function", "function") + "\nvar chartUi = createCharts({ state });", context);
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
