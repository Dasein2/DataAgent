import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { cleanup, testConfig } from "./support.js";
import { TtlCache } from "../src/analysis/cache.js";
import { MetadataPool } from "../src/analysis/pool.js";
import { DEFAULT_ANALYSIS } from "../src/analysis/options.js";
import { rowMasker } from "../src/analysis/privacy.js";
import { validateLocalSql } from "../src/analysis/local-guard.js";
import { localSql, ownedResult, summarize } from "../src/analysis/results.js";
import { ResultStore } from "../src/results/store.js";
import { SnapshotStore } from "../src/analysis/snapshots.js";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig } from "../src/db/types.js";
import { getProfile } from "../src/db/engines/profiles.js";
import { compileChart } from "../src/artifacts/charts.js";
import { resolveRef } from "../src/artifacts/refs.js";
import { reusableSql } from "../src/analysis/reuse.js";

it("metadata cache coalesces, isolates returned values, refreshes and never caches errors", async () => {
  const cache = new TtlCache(1000, 2);
  let calls = 0;
  const load = async () => {
    calls++;
    await Promise.resolve();
    return { x: 1 };
  };
  const [a, b] = await Promise.all([cache.get("x", load), cache.get("x", load)]);
  a.x = 99;
  assert.equal(b.x, 1);
  assert.equal(calls, 1);
  assert.equal((await cache.get("x", load)).x, 1);
  await cache.get("x", load, true);
  assert.equal(calls, 2);
  cache.clear();
  await cache.get("x", load);
  assert.equal(calls, 3);
  await assert.rejects(
    cache.get("error", async () => {
      throw new Error("no");
    }),
  );
  assert.equal(await cache.get("error", async () => 42), 42);
});

it("metadata workers bound concurrency, serialize each connection and recover from creation failure", async () => {
  let created = 0,
    active = 0,
    peak = 0,
    closed = 0;
  const pool = new MetadataPool(2, async () => ({
    id: ++created,
    busy: false,
    close: async () => {
      closed++;
    },
  }));
  await Promise.all(
    Array.from({ length: 10 }, () =>
      pool.run(async (worker) => {
        assert.equal(worker.busy, false);
        worker.busy = true;
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 3));
        active--;
        worker.busy = false;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(created, 2);
  await pool.close();
  assert.equal(closed, 2);
  await assert.rejects(pool.run(async () => 1));
  let tries = 0;
  const retry = new MetadataPool(1, async () => {
    if (++tries === 1) throw new Error("connection failed");
    return { close: async () => {} };
  });
  await assert.rejects(retry.run(async () => 1));
  assert.equal(await retry.run(async () => 2), 2);
  await retry.close();
});

it("output masking is applied before storage and preserves nulls without advertising authorization", () => {
  const mask = rowMasker(
    [
      { name: "phone", type: "text" },
      { name: "email", type: "text" },
      { name: "secret", type: "text" },
    ],
    [
      { column: "phone", mode: "partial" },
      { column: "email", mode: "hash" },
      { column: "secret", mode: "deny" },
    ],
    "session-a",
  );
  const row = mask(["13812345678", "a@example.test", "s"]);
  assert.equal(row[0], "13***78");
  assert.match(String(row[1]), /^[a-f0-9]{64}$/);
  assert.equal(row[2], null);
  assert.deepEqual(mask([null, null, null]), [null, null, null]);
});

it("local SQL AST allowlist rejects writes, catalogs and quoted function bypasses", () => {
  for (const sql of [
    "SELECT sum(amount) AS total FROM data",
    "WITH x AS (SELECT amount FROM data) SELECT count(*) FROM x",
    "SELECT * FROM data ORDER BY amount DESC LIMIT 10",
  ])
    assert.doesNotThrow(() => validateLocalSql(sql));
  for (const sql of [
    "DELETE FROM data",
    "SELECT 1; SELECT 2",
    "SELECT * FROM pg_catalog.pg_class",
    'SELECT "version"() FROM data',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM other",
    "SELECT generate_series(1,10000000)",
    "WITH x AS (WITH pg_class AS (SELECT 1) SELECT * FROM pg_class) SELECT * FROM pg_class",
  ])
    assert.throws(() => validateLocalSql(sql));
});

async function seeded() {
  const app = await testConfig();
  const store = new ResultStore(join(app.dataDir, "results"));
  const writer = await store.create({
    sessionId: "sess_analysis",
    sql: "SELECT category, amount FROM sales",
    previewRows: 2,
  });
  writer.setColumns([
    { name: "category", type: "text" },
    { name: "amount", type: "numeric" },
  ]);
  for (const r of [
    ["a", "9007199254740993.10"],
    ["a", "0.20"],
    ["b", "2.00"],
    ["c", null],
  ])
    await writer.append(r);
  return { app, store, meta: await writer.finish("none", 1) };
}

it("streaming stored-result summary exposes scope, nulls and approximate precision", async () => {
  const { app, store, meta } = await seeded();
  try {
    const s = await summarize(store, meta, DEFAULT_ANALYSIS);
    assert.equal(s.rows, 4);
    assert.equal(s.columns[1]!.nulls, 1);
    assert.equal(s.columns[0]!.distinct, 3);
    assert.match(s.scope, /stored result only/);
    await assert.rejects(ownedResult(store, meta.id, "sess_other"), {
      code: "FORBIDDEN",
    });
  } finally {
    await cleanup(app);
  }
});

it("isolated local SQL preserves decimal sums and lineage, rejects incomplete input", { timeout: 30000 }, async () => {
  const { app, store, meta } = await seeded();
  try {
    const result = await localSql(
      store,
      meta,
      "SELECT category, sum(amount) AS total FROM data GROUP BY category ORDER BY category",
      DEFAULT_ANALYSIS,
    );
    assert.equal(result.preview[0]![1], "9007199254740993.30");
    assert.equal(result.lineage?.parent_result_id, meta.id);
    assert.equal(result.rowCount, 3);
    assert.equal(result.truncated, "none");
    await assert.rejects(
      localSql(store, { ...meta, truncated: "rows" }, "SELECT count(*) FROM data", DEFAULT_ANALYSIS),
      { code: "CHART_RESULT_TRUNCATED" },
    );
    const top = await localSql(
      store,
      meta,
      `WITH grouped AS (SELECT category, SUM(amount) AS total FROM data WHERE amount IS NOT NULL GROUP BY category), ranked AS (SELECT category, total, ROW_NUMBER() OVER (ORDER BY total DESC, category) AS rn FROM grouped) SELECT CASE WHEN rn <= 1 THEN category ELSE 'Other' END AS category, SUM(total) AS total FROM ranked GROUP BY CASE WHEN rn <= 1 THEN category ELSE 'Other' END ORDER BY total DESC`,
      DEFAULT_ANALYSIS,
    );
    assert.equal(top.preview[0]![0], "a");
    assert.equal(top.preview[0]![1], "9007199254740993.30");
    assert.equal(top.preview[1]![1], "2.00");
    const broken = await store.create({ sessionId: meta.sessionId, sql: "SELECT long_text", previewRows: 1 });
    broken.setColumns([{ name: "long_text", type: "text" }]);
    await broken.append([{ __type: "text", preview: "clipped", truncated: true }]);
    await assert.rejects(
      localSql(store, await broken.finish("none", 1), "SELECT COUNT(*) FROM data", DEFAULT_ANALYSIS),
      { code: "RESULT_FAILED" },
    );
    const snapshots = new SnapshotStore(join(app.dataDir, "snapshots"));
    const pinned = await snapshots.create(meta.sessionId, meta.id, "完整快照");
    assert.equal((await snapshots.list(meta.sessionId))[0]!.id, pinned.id);
    assert.deepEqual(await snapshots.list("sess_other"), []);
    await snapshots.drop(meta.sessionId, pinned.id);
    assert.deepEqual(await snapshots.list(meta.sessionId), []);
  } finally {
    await cleanup(app);
  }
});

it("source result reuse is exact SQL/limit scoped and opt in; preflight cost policy is enforced", async () => {
  assert.equal(reusableSql("SELECT random()", "Postgresql"), false);
  assert.equal(reusableSql("SELECT CURRENT_TIMESTAMP", "Postgresql"), false);
  assert.equal(reusableSql('SELECT "version"()', "Postgresql"), false);
  assert.equal(reusableSql("SELECT SUM(amount) FROM sales", "Postgresql"), true);
  const app = await testConfig();
  app.analysis = { preflight: "enforce", maxEstimatedScanRows: 100 };
  const store = new ResultStore(join(app.dataDir, "results"));
  const config = ConnectionConfig.parse({
    engine: "postgres",
    host: "fixture",
    database: "analytics",
    user: "reader",
    password: "",
    port: 5432,
  });
  const db = new (DbSession as any)("sess_policy", config, app, store) as DbSession;
  let runs = 0,
    scans = 10;
  Object.assign(db, {
    allowedScopes: ["public"],
    capabilities: { sourceAccess: "read_only", features: { explain: true } },
    engine: {
      profile: getProfile("postgres"),
      explain: async () => ({
        estimatedScanRows: scans,
        estimatedRows: 1,
        estimatedCost: 10,
        planText: "{}",
        warnings: [],
      }),
      query: async (_sql: string, _limits: any, sink: any) => {
        runs++;
        sink.onColumns([{ name: "value", type: "int" }]);
        await sink.onRow([runs]);
        return {
          rowCount: 1,
          bytes: 3,
          durationMs: 1,
          truncated: "none",
          warnings: [],
        };
      },
    },
  });
  try {
    const a = await db.query("SELECT 1");
    const b = await db.query("SELECT 1", { reuse: true });
    assert.equal(b.id, a.id);
    assert.equal(b.cached, true);
    assert.equal(runs, 1);
    assert.notEqual((await db.query("SELECT 1")).id, a.id);
    assert.equal(runs, 2);
    await db.query("SELECT 1", { reuse: true, maxRows: 2 });
    assert.equal(runs, 3);
    scans = 1000;
    await assert.rejects(db.query("SELECT COUNT(*) FROM public.sales"), {
      code: "QUERY_COST_EXCEEDED",
    });
    assert.equal(runs, 3);
    Object.assign((db as any).engine, { explain: async () => ({ planText: "unknown", warnings: [] }) });
    await assert.rejects(db.query("SELECT 2"), { code: "QUERY_COST_EXCEEDED" });
    assert.equal(runs, 3);
  } finally {
    await cleanup(app);
  }
});

function chart(type: any, rows: unknown[][], extra: any = {}) {
  return compileChart({
    artifact_id: "art_analysis123",
    spec: {
      result_id: "res_analysis123",
      type,
      x: { field: "category" },
      value: { field: "value" },
      ...extra,
    },
    columns: [
      { name: "category", type: "text" },
      { name: "value", type: "numeric" },
    ],
    rows,
    source: {
      result_id: "res_analysis123",
      sql: "SELECT 1",
      session_id: "sess_analysis",
      executed_at: new Date().toISOString(),
      row_count: rows.length,
      truncated: "none",
    },
    limits: { maxRows: 100, maxCells: 100, maxSeries: 2 },
  });
}
it("new chart types preserve raw values, reject invalid pies and resolve exact KPI refs", () => {
  const pie = chart(
    "donut",
    [
      ["a", "3.10"],
      ["b", "2.20"],
    ],
    { value_sort: "desc" },
  );
  assert.equal(pie.data.rows[0]![1], "3.10");
  assert.equal((pie.compiled.option!.series as any[])[0].type, "pie");
  assert.throws(() => chart("pie", [["a", -1]]));
  assert.throws(
    () =>
      chart("pie", [
        ["a", 1],
        ["a", 2],
      ]),
    { code: "CHART_DUPLICATE_CELL" },
  );
  const kpi = chart("kpi", [["a", "9007199254740993.10"]], { x: undefined });
  assert.equal(resolveRef(kpi.summary.top[0]!.ref, kpi.data)?.value, "9007199254740993.10");
  const bar = chart(
    "bar",
    [
      ["b", 1],
      ["a", 3],
    ],
    { value_sort: "desc" },
  );
  assert.deepEqual((bar.compiled.option!.xAxis as any).data, ["a", "b"]);
  const area = chart("area", [["a", 1]]);
  assert.ok((area.compiled.option!.series as any[])[0].areaStyle);
  const scatter = chart(
    "scatter",
    [
      [1, "2.25"],
      [2, "3.50"],
    ],
    { y: { field: "value" } },
  );
  assert.equal((scatter.compiled.option!.series as any[])[0].type, "scatter");
  assert.equal(scatter.data.rows[0]![1], "2.25");
  assert.equal(resolveRef("art_analysis123#row=0", scatter.data)?.value, "2.25");
});

it("cost preflight cancellation never starts the source query, including late control acknowledgement", async () => {
  const app = await testConfig();
  app.budgets.queryTimeoutMs = 100;
  const results = new ResultStore(join(app.dataDir, "results"));
  const config = ConnectionConfig.parse({
    engine: "postgres",
    host: "fixture",
    port: 5432,
    database: "analytics",
    user: "reader",
    password: "",
  });
  const db = new (DbSession as any)("sess_plancancel", config, app, results) as DbSession;
  let release!: () => void,
    started!: () => void,
    acknowledged = false,
    queries = 0;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  Object.assign(db, {
    allowedScopes: ["public"],
    capabilities: { features: { explain: true } },
    engine: {
      profile: getProfile("postgres"),
      cancelSupported: true,
      explain: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { planText: "{}", warnings: [] };
      },
      cancel: async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 5));
        acknowledged = true;
        return true;
      },
      query: async () => {
        queries++;
        throw new Error("must not execute");
      },
    },
  });
  try {
    const controller = new AbortController();
    const outcome = db.query("SELECT 1", { signal: controller.signal });
    const rejected = assert.rejects(outcome, { code: "QUERY_CANCELLED" });
    await ready;
    controller.abort();
    await rejected;
    assert.equal(acknowledged, true);
    assert.equal(queries, 0);
    assert.equal((await results.listBySession(db.id)).length, 0);
    await assert.rejects(db.query("EXPLAIN ANALYZE SELECT 1"), { code: "INVALID_INPUT" });
  } finally {
    await cleanup(app);
  }
});

it("source and local storage write leases serialize across store instances and recover after failures", async () => {
  const app = await testConfig();
  const a = new ResultStore(join(app.dataDir, "results")),
    b = new ResultStore(join(app.dataDir, "results"));
  const order: number[] = [];
  try {
    const first = a.serializeWrite("sess_quota", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
      throw new Error("failed writer");
    });
    const rejected = assert.rejects(first);
    const next = b.serializeWrite("sess_quota", async () => {
      order.push(3);
      return 42;
    });
    await rejected;
    assert.equal(await next, 42);
    assert.deepEqual(order, [1, 2, 3]);
  } finally {
    await cleanup(app);
  }
});
