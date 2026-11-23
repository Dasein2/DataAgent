import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { ConnectionConfig, type EngineKind } from "../src/db/types.js";
import { parseServerQueryTimeout, resolveQueryTimeout } from "../src/db/query-timeout.js";
import { MysqlEngine, DorisEngine, StarrocksEngine } from "../src/db/engines/mysql.js";
import { PostgresEngine } from "../src/db/engines/postgres.js";
import { getProfile } from "../src/db/engines/profiles.js";
import { DbSession } from "../src/db/session.js";
import { ResultStore } from "../src/results/store.js";
import { cleanup, testConfig } from "./support.js";

const budgets = { queryTimeoutMs: 60_000, maxQueryTimeoutMs: 600_000, taskTimeoutMs: 900_000 };
const connection = (engine: EngineKind = "postgres") => ConnectionConfig.parse({
  engine, host: "fixture.test", port: 5432, database: "analytics", user: "reader", password: "fixture-password",
});

test("old connections default to auto; manual timeouts are bounded integers and never unlimited", () => {
  assert.equal(connection().queryTimeoutMs, undefined);
  assert.equal(ConnectionConfig.parse({ ...connection(), queryTimeoutMs: 180_000 }).queryTimeoutMs, 180_000);
  for (const invalid of [0, -1, 999, 3_600_001, 1_000.5, Infinity, NaN, "180000", null])
    assert.equal(ConnectionConfig.safeParse({ ...connection(), queryTimeoutMs: invalid }).success, false);
});

test("parses each engine's timeout units, unlimited and malformed settings without guessing", () => {
  for (const [engine, raw, ms] of [
    ["postgres", "1min", 60_000], ["postgres", "1.5s", 1500], ["postgres", "250ms", 250],
    ["postgres", "60000", 60_000], ["mysql", "1500", 1500],
    ["doris", "300", 300_000], ["starrocks", 120, 120_000],
  ] as const) {
    assert.equal(parseServerQueryTimeout(engine, raw).timeoutMs, ms);
    assert.equal(parseServerQueryTimeout(engine, raw).status, "detected");
  }
  assert.equal(parseServerQueryTimeout("postgres", "0").status, "unlimited");
  for (const raw of [undefined, null, "", "unknown", "-1", "NaN", "Infinity", "1e100", "9999999999999999999999", {}])
    assert.equal(parseServerQueryTimeout("doris", raw).status, "unavailable");
});

for (const engine of ["postgres", "mysql", "doris", "starrocks"] as const) {
  test(`${engine}: auto mode respects detected session limits and falls back explicitly`, () => {
    const detected = parseServerQueryTimeout(engine, engine === "doris" || engine === "starrocks" ? "180" : "180000");
    const policy = resolveQueryTimeout(connection(engine), budgets, detected);
    assert.equal(policy.effectiveMs, 180_000);
    assert.equal(policy.source, "server");
    assert.equal(policy.mode, "auto");
    for (const probe of [undefined, parseServerQueryTimeout(engine, "0"), parseServerQueryTimeout(engine, "invalid")]) {
      const fallback = resolveQueryTimeout(connection(engine), budgets, probe);
      assert.equal(fallback.effectiveMs, engine === "doris" || engine === "starrocks" ? 300_000 : 60_000);
      assert.equal(fallback.source, "engine_default");
    }
  });
}

test("manual and auto policies cannot exceed detected server, operator or task ceilings", () => {
  const config = { ...connection("doris"), queryTimeoutMs: 900_000 };
  const server = parseServerQueryTimeout("doris", "120");
  const policy = resolveQueryTimeout(config, { ...budgets, taskTimeoutMs: 60_000 }, server);
  assert.equal(policy.effectiveMs, 60_000);
  assert.equal(policy.source, "connection");
  assert.deepEqual(policy.clampedBy, ["server", "platform", "task"]);
  assert.equal(resolveQueryTimeout(connection("doris"), { ...budgets, maxQueryTimeoutMs: 30_000 }).effectiveMs, 30_000);
  assert.equal(resolveQueryTimeout(connection("mysql"), budgets, parseServerQueryTimeout("mysql", "9999999")).effectiveMs, 600_000);
  assert.equal(resolveQueryTimeout({ ...connection(), queryTimeoutMs: 10_000 }, budgets, server).effectiveMs, 10_000);
});

for (const engine of ["mysql", "doris", "starrocks"] as const) {
  test(`${engine}: connect probes only the session timeout with a five-second bound`, async () => {
    const config = connection(engine);
    const instance = engine === "mysql" ? new MysqlEngine(config) : engine === "doris" ? new DorisEngine(config) : new StarrocksEngine(config);
    let fail = false;
    const calls: Array<[string, number]> = [];
    const variable = engine === "mysql" ? "max_execution_time" : "query_timeout";
    Object.assign(instance, {
      newConnection: async () => ({}), probeVersion: async () => {}, beginReadOnly: async () => {},
      buffered: async (sql: string, ms: number) => {
        calls.push([sql, ms]);
        if (fail) throw new Error("permission denied: fixture detail must not leak");
        return { rows: [[variable, engine === "mysql" ? "180000" : "180"]] };
      },
    });
    await instance.connect();
    assert.deepEqual(calls, [[`SHOW SESSION VARIABLES LIKE '${variable}'`, 5000]]);
    assert.equal(instance.queryTimeoutStatus().timeoutMs, 180_000);
    fail = true;
    await instance.connect();
    assert.deepEqual(instance.queryTimeoutStatus(), { status: "unavailable", variable });
  });
}

test("PostgreSQL captures the original role timeout, never disables it, and clamps SET LOCAL", async () => {
  const instance = new PostgresEngine(connection(), { applicationName: "fixture" });
  const sqls: string[] = [];
  const client = { query: async (input: string | { text: string; query_timeout?: number }) => {
    const sql = typeof input === "string" ? input : input.text;
    sqls.push(sql);
    if (sql === "SHOW statement_timeout") {
      assert.equal((input as any).query_timeout, 5000);
      return { rows: [{ statement_timeout: "2s" }] };
    }
    return { rows: [], fields: [] };
  } };
  Object.assign(instance, { newClient: async () => client });
  await instance.connect();
  assert.equal(instance.queryTimeoutStatus().timeoutMs, 2000);
  assert.ok(!sqls.includes("SET statement_timeout = 0"));
  await (instance as any).buffered("SELECT 1", 60_000);
  assert.ok(sqls.includes("SET LOCAL statement_timeout = 2000"));
});

test("new sessions publish the detected effective timeout, including legacy auto connections", async () => {
  const app = await testConfig(); app.budgets = { ...app.budgets, ...budgets };
  const originals = new Map<string, unknown>();
  const overrides = {
    connect: async () => {}, close: async () => {}, listScopes: async () => ["public"], defaultScope: async () => "public",
    queryTimeoutStatus: () => parseServerQueryTimeout("postgres", "90s"),
  };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      originals.set(key, (PostgresEngine.prototype as any)[key]);
      (PostgresEngine.prototype as any)[key] = value;
    }
    const db = await DbSession.open({ config: { ...connection(), host: "127.0.0.1" }, app, results: new ResultStore(join(app.dataDir, "results")) });
    try {
      assert.equal(db.snapshot().capabilities.queryTimeout?.effectiveMs, 90_000);
      assert.equal(db.capabilitiesView.queryTimeout?.source, "server");
      assert.equal(db.capabilitiesView.queryTimeout?.mode, "auto");
    } finally { await db.close(); }
  } finally {
    for (const [key, value] of originals) (PostgresEngine.prototype as any)[key] = value;
    await cleanup(app);
  }
});

test("SQL execution, EXPLAIN and profiling share the effective policy; per-call limits only shorten it", async () => {
  const app = await testConfig();
  app.budgets = { ...app.budgets, ...budgets };
  app.analysis = { preflight: "off" };
  const config = { ...connection(), queryTimeoutMs: 180_000 };
  const policy = resolveQueryTimeout(config, app.budgets);
  const limits: number[] = [];
  try {
    const db = new (DbSession as any)("sess_policytimeout", config, app, new ResultStore(join(app.dataDir, "results"))) as DbSession;
    Object.assign(db, {
      allowedScopes: ["public"],
      capabilities: { sourceAccess: "read_only", queryTimeout: policy, features: { explain: true }, environment: "production" },
      engine: {
        profile: getProfile("postgres"),
        query: async (_sql: string, options: any, sink: any) => {
          limits.push(options.timeoutMs); sink.onColumns([]);
          return { columns: [], rowCount: 0, bytes: 0, durationMs: 1, truncated: "none", warnings: [] };
        },
        explain: async (_sql: string, options: any) => {
          limits.push(options.timeoutMs); return { planText: "fixture", warnings: [] };
        },
        describeObject: async () => ({ object: { schema: "public", name: "events", kind: "table" }, columns: [] }),
        profileObject: async (_schema: string, _name: string, _rows: number, timeoutMs: number) => {
          limits.push(timeoutMs); return { object: { schema: "public", name: "events" }, columns: [] };
        },
      },
    });
    await db.query("SELECT 1");
    await db.query("SELECT 2", { timeoutMs: 900_000 });
    await db.query("SELECT 3", { timeoutMs: 1000 });
    await db.explain("SELECT 1", { timeoutMs: 900_000 });
    await db.profile("public", "events", 1, 900_000);
    assert.deepEqual(limits, [180_000, 180_000, 1000, 180_000, 180_000]);
    await assert.rejects(db.query("SELECT 4", { timeoutMs: -1 }), { code: "INVALID_INPUT" });
  } finally { await cleanup(app); }
});

test("console converts seconds, restores manual/auto and submits policy with saved-profile credentials", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /id="queryTimeoutMode"/);
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
  const elements: Record<string, any> = {};
  const $ = (id: string) => elements[id] ??= { value: "", checked: false };
  const context = createContext({ $, state: { selectedProfile: "saved" }, defaultPort: () => 5432 });
  const extract = (start: string, end: string) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
  runInContext(extract("function connectionPayload()", "function saveToken()"), context);
  runInContext(extract("function connectionRequest()", "function profileEntry("), context);
  $("engine").value = "doris";
  $("queryTimeoutMode").value = "manual";
  $("queryTimeoutSeconds").value = "180";
  $("password").value = "fixture-only";
  let payload = runInContext("connectionRequest()", context);
  assert.equal(payload.profile, "saved");
  assert.equal(payload.queryTimeoutMs, 180_000);
  assert.equal(payload.credentials.password, "fixture-only");
  $("queryTimeoutSeconds").value = "0";
  assert.throws(() => runInContext("connectionPayload()", context), /SQL 超时/);
  $("queryTimeoutMode").value = "auto";
  payload = runInContext("connectionRequest()", context);
  assert.equal(payload.queryTimeoutMs, null);
  assert.equal(runInContext("connectionPayload()", context).queryTimeoutMs, undefined);
});
