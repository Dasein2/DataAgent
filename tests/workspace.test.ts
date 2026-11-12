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
