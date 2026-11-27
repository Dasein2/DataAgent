import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig } from "../src/db/types.js";
import { getProfile } from "../src/db/engines/profiles.js";
import { ResultStore } from "../src/results/store.js";
import { cleanup, testConfig } from "./support.js";

it("isolates dataset listing/deletion and never deletes another session's object after a failed create", async () => {
  const app = await testConfig();
  const objects = new Map<string, any>();
  const dropped: string[] = [];
  const config = ConnectionConfig.parse({ engine: "mysql", host: "db.test", port: 3306, database: "analytics", user: "reader", password: "", environment: "non_production", workspace: { name: "analysis_ws" } });
  function session(id: string) {
    const db = new (DbSession as any)(id, config, app, new ResultStore(join(app.dataDir, "results"))) as DbSession;
    Object.assign(db, { allowedScopes: ["analytics"], capabilities: { environment: "non_production", workspaceName: "analysis_ws", workspaceAccess: "tables_and_views" },
      engine: { profile: getProfile("mysql"), listDatasets: async () => [...objects.values()],
        createView: async (_: string, name: string) => { objects.set(name, { name, kind: "view" }); },
        dropDataset: async (_: string, name: string) => { dropped.push(name); objects.delete(name); } } });
    return db;
  }
  try {
    const first = session("sess_first"), second = session("sess_second");
    await first.createDataset("ds_totals", "SELECT 1", "view");
    assert.equal((await second.listDatasets()).length, 0);
    await assert.rejects(second.dropDataset("ds_totals"), { code: "FORBIDDEN" });
    await assert.rejects(second.createDataset("ds_totals", "SELECT 2", "view"), { code: "DATASET_ALREADY_EXISTS" });
    assert.deepEqual(dropped, []);
    assert.equal(objects.has("ds_totals"), true);
    await first.dropDataset("ds_totals");
    assert.deepEqual(dropped, ["ds_totals"]);
  } finally { await cleanup(app); }
});

it("marks an invalidated database connection unavailable and rejects queued work before execution", async () => {
  const app = await testConfig();
  try {
    const db = new (DbSession as any)("sess_dead", { engine: "doris" }, app, {}) as DbSession;
    Object.assign(db, { capabilities: {}, engine: { unavailableReason: "Connection was killed; reconnect" } });
    assert.equal(db.snapshot().status, "unavailable");
    await assert.rejects(db.query("SELECT 1"), { code: "SESSION_UNAVAILABLE" });
  } finally { await cleanup(app); }
});

it("keeps idle Doris alive without extending expiry, competing with SQL, or spending query budget", async () => {
  const app = await testConfig();
  const db = new (DbSession as any)("sess_heartbeat", { engine: "doris" }, app, {}) as DbSession;
  const internals = db as any;
  let calls = 0, fail = false, release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  Object.assign(db, { capabilities: {}, engine: { close: async () => {}, keepAlive: async () => {
    calls++;
    if (fail) throw Object.assign(new Error("Disconnected"), { code: "PROTOCOL_CONNECTION_LOST" });
  } } });
  try {
    const wasActiveAt = db.snapshot().last_used_at;
    const expiry = db.expiresAt.getTime();
    internals.lastSourceAt = Date.now() - 100_000;
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 1);
    assert.equal(db.snapshot().queries.used, 0);
    assert.equal(db.snapshot().last_used_at, wasActiveAt);
    assert.equal(db.expiresAt.getTime(), expiry);
    assert.equal(db.snapshot().status, "ready");
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 1, "no redundant heartbeat after source activity");
    internals.lastSourceAt = Date.now() - 100_000;
    const pending = internals.run(() => work);
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 1, "no heartbeat during or behind a user statement");
    release(); await pending;
    internals.lastSourceAt = Date.now() - 100_000;
    internals.lastUsedAt = new Date(0);
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 1, "expired sessions are not kept alive");
    db.touch(); fail = true;
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 2);
    assert.equal(db.snapshot().status, "unavailable");
    await internals.keepIdleSourceAlive(60_000);
    assert.equal(calls, 2, "a broken source is not silently reconnected");
  } finally { release(); await db.close(); await cleanup(app); }
});

it("cancels only an active statement and accepts another query in the same Doris session", async () => {
  const app = await testConfig();
  app.budgets.queryTimeoutMs = 2_000;
  const results = new ResultStore(join(app.dataDir, "results"));
  const config = ConnectionConfig.parse({ engine: "doris", host: "fixture", port: 9030, database: "analytics", user: "reader", password: "" });
  const db = new (DbSession as any)("sess_cancel", config, app, results) as DbSession;
  let started!: () => void, release!: () => void, controls = 0;
  const running = new Promise<void>(resolve => { started = resolve; });
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  Object.assign(db, { allowedScopes: ["analytics"], capabilities: { sourceAccess: "read_only", workspaceAccess: "none" },
    engine: { profile: getProfile("doris"), cancelSupported: true,
      cancel: async () => { controls++; await acknowledgement; return true; },
      query: async (sql: string, limits: any) => {
        if (sql === "SELECT 1") {
          await new Promise<void>(resolve => { limits.signal.addEventListener("abort", () => resolve(), { once: true }); started(); });
        }
        return { columns: [], rowCount: 0, bytes: 0, durationMs: 1, truncated: "none", warnings: [] };
      } } });
  try {
    assert.equal(await db.cancel(), false, "no statement to cancel during model thinking");
    assert.equal(controls, 0);
    const signal = new AbortController();
    const stopped = assert.rejects(db.query("SELECT 1", { signal: signal.signal, skipPreflight: true }), { code: "QUERY_CANCELLED" });
    await running;
    const cancel = db.cancel();
    signal.abort(); // Model abort and Stop overlap, but still only one control request.
    const next = db.query("SELECT 2", { skipPreflight: true });
    assert.equal(controls, 1);
    release();
    assert.equal(await cancel, true);
    await stopped;
    assert.equal((await next).sql, "SELECT 2");
    assert.equal(db.snapshot().status, "ready");
    assert.equal(controls, 1);
  } finally { release(); await cleanup(app); }
});

it("rejects a query timeout even when the driver resolves its interrupted stream normally", async () => {
  const app = await testConfig(); app.budgets.queryTimeoutMs = 5;
  try {
    const results = new ResultStore(join(app.dataDir, "results"));
    const config = ConnectionConfig.parse({ engine: "mysql", host: "fixture", port: 3306, database: "analytics", user: "reader", password: "" });
    const db = new (DbSession as any)("sess_timeout", config, app, results) as DbSession;
    Object.assign(db, { allowedScopes: ["analytics"], capabilities: { sourceAccess: "read_only", workspaceAccess: "none" },
      engine: { profile: getProfile("mysql"), cancel: async () => true,
        query: async (_sql: string, limits: any) => {
          await new Promise<void>((resolve) => limits.signal.addEventListener("abort", () => resolve(), { once: true }));
          return { columns: [], rowCount: 0, bytes: 0, durationMs: 5, truncated: "none", warnings: [] };
        } } });
    await assert.rejects(db.query("SELECT 1"), { code: "QUERY_TIMEOUT" });
    assert.match((await results.listBySession(db.id))[0]?.error ?? "", /exceeded/);
  } finally { await cleanup(app); }
});
