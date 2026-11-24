import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { it } from "node:test";
import { MysqlEngine, DorisEngine, StarrocksEngine } from "../src/db/engines/mysql.js";
import { ConnectionConfig } from "../src/db/types.js";
import { MetadataPool } from "../src/analysis/pool.js";
import { observeSourceRequests, type SourceRequest } from "../src/db/source-operations.js";

const limits = { timeoutMs: 1_000, maxRows: 10, maxBytes: 10_000, maxCellChars: 100 };
function engineFixture(engine: "mysql" | "doris" | "starrocks", rows: unknown[][], failure?: Error) {
  const config = ConnectionConfig.parse({ engine, host: "unused.test", port: 3306, database: "analytics", user: "reader", password: "" });
  const instance = engine === "doris" ? new DorisEngine(config) : engine === "starrocks" ? new StarrocksEngine(config) : new MysqlEngine(config);
  let destroyed = false;
  let cancellation = "";
  const connection = { threadId: 123, destroy: () => { destroyed = true; }, query: () => ({ stream: () => Readable.from((async function* () {
    for (const row of rows) yield row;
    if (failure) throw failure;
  })()) }) };
  Object.assign(instance, { connection, inReadOnly: true, beginReadOnly: async () => {}, endReadOnly: async () => {},
    newConnection: async () => ({ query: (sql: string, cb: Function) => { cancellation = sql; cb(); }, end: (cb: Function) => cb() }) });
  return { instance, destroyed: () => destroyed, cancellation: () => cancellation };
}

it("rebuilds a failed Doris metadata lane once; counts driver dispatches and never replays source SQL", async () => {
  const events: SourceRequest[] = [];
  let created = 0, closes = 0;
  const sql: string[] = [];
  const pool = new MetadataPool(1, async () => {
    const n = ++created;
    const { instance } = engineFixture("doris", []);
    Object.assign(instance, { connection: { destroy: () => { closes++; }, end: (cb: Function) => cb(), promise: () => ({
      query: async ({ sql: statement }: { sql: string }) => {
        sql.push(statement);
        if (n === 1) throw Object.assign(new Error("connection is in closed state"), { code: "PROTOCOL_CONNECTION_LOST" });
        return [[['analytics', 3]], []];
      },
    }) }, endReadOnly: async () => {} });
    return instance;
  });
  try {
    const counts = await observeSourceRequests(e => events.push(e), () => {}, () => pool.run(w => w.catalogTableCounts(["analytics"])));
    assert.deepEqual(counts, { analytics: 3 });
    assert.equal(created, 2); assert.equal(sql.length, 2); assert.ok(closes >= 1);
    assert.equal(sql[0], sql[1]); assert.match(sql[1]!, /information_schema/);
    assert.deepEqual(events.map(e => [e.phase, e.kind, e.phase === "finished" ? e.code : undefined]), [
      ["started", "metadata", undefined], ["finished", "metadata", "SESSION_UNAVAILABLE"],
      ["started", "metadata", undefined], ["finished", "metadata", undefined],
    ]);
  } finally { await pool.close(); }
});

for (const engine of ["mysql", "doris", "starrocks"] as const) {
  it(`${engine}: counts visible tables by scope in one unpaged query`, async () => {
    const { instance } = engineFixture(engine, []);
    const queries: string[] = [];
    Object.assign(instance, { buffered: async (sql: string) => {
      queries.push(sql);
      return { rows: [["analytics", "122"], ["blocked", "99"]] };
    } });
    const counts = await instance.catalogTableCounts(["analytics", "empty"]);
    assert.deepEqual(counts, { analytics: 122, empty: 0 });
    assert.equal(queries.length, 1);
    assert.ok(queries[0]?.includes("COUNT(*) FROM information_schema.TABLES"));
    assert.ok(queries[0]?.includes("TABLE_SCHEMA IN ('analytics','empty')"));
    assert.ok(queries[0]?.includes("IN ('table','foreign_table') GROUP BY TABLE_SCHEMA"));
    assert.doesNotMatch(queries[0]!, /LIMIT|OFFSET/);
  });
  it(`${engine}: keeps the column match representative and count in paged catalog results`, async () => {
    const { instance } = engineFixture(engine, []);
    const queries: string[] = [];
    Object.assign(instance, { buffered: async (sql: string) => {
      queries.push(sql);
      return { rows: [["analytics", "events", "table", null, null, 4, "user_id", 2]] };
    } });
    const objects = await instance.listObjects({ search: "user_id", scopes: ["analytics", "information_schema"],
      searchColumns: true, includeMatchDetails: true, kinds: ["table"], offset: 50, limit: 51 });
    assert.deepEqual(objects[0]?.columnMatch, { name: "user_id", count: 2 });
    assert.equal(objects[0]?.match, "column");
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /t.TABLE_SCHEMA IN \('analytics'\)/);
    assert.match(queries[0]!, /WHERE object_kind IN \('table'\)[\s\S]*LIMIT 51 OFFSET 50/);
    await instance.listObjects({ schema: "analytics", limit: 50 });
    assert.doesNotMatch(queries[1]!, /information_schema.COLUMNS/);
  });
  it(`${engine}: propagates a missing-table error instead of returning zero rows`, async () => {
    const error = new Error("Table analytics.missing does not exist");
    const { instance } = engineFixture(engine, [], error);
    await assert.rejects(instance.query("SELECT * FROM missing", limits, { onRow: () => {} }), error);
  });
  it(`${engine}: distinguishes a legitimate empty result from failure`, async () => {
    const { instance } = engineFixture(engine, []);
    const result = await instance.query("SELECT 1 WHERE FALSE", limits, { onRow: () => {} });
    assert.equal(result.rowCount, 0); assert.equal(result.truncated, "none");
  });
  it(`${engine}: propagates result-storage failures after partial output`, async () => {
    const { instance } = engineFixture(engine, [[1], [2]]);
    await assert.rejects(instance.query("SELECT 1", limits, { onRow: () => { throw new Error("disk full"); } }), /disk full/);
  });
  it(`${engine}: records a deliberate row cap without treating it as query failure`, async () => {
    const { instance } = engineFixture(engine, [[1], [2], [3]]);
    const rows: unknown[][] = [];
    const result = await instance.query("SELECT 1", { ...limits, maxRows: 1 }, { onRow: (row) => { rows.push(row); } });
    assert.equal(result.truncated, "rows"); assert.deepEqual(rows, [[1]]);
    if (engine !== "mysql") assert.match(instance.unavailableReason!, /Open a new/);
  });
}

for (const engine of ["doris", "starrocks"] as const) {
  it(`${engine}: invalidates a killed connection and refuses subsequent queries clearly`, async () => {
    const f = engineFixture(engine, []);
    assert.equal(await f.instance.cancel(), true);
    assert.equal(f.cancellation(), "KILL 123"); assert.equal(f.destroyed(), true);
    await assert.rejects(f.instance.query("SELECT 1", limits, { onRow: () => {} }), { code: "SESSION_UNAVAILABLE" });
  });
  it(`${engine}: waits for cancellation acknowledgement before returning an interrupted stream`, async () => {
    const f = engineFixture(engine, [[1], [2]]);
    const controller = new AbortController();
    let kills = 0;
    Object.assign(f.instance, { newConnection: async () => ({
      query: (_sql: string, cb: Function) => { kills++; setTimeout(() => cb(), 5); }, end: (cb: Function) => cb(),
    }) });
    await f.instance.query("SELECT 1", { ...limits, signal: controller.signal }, { onRow: () => { controller.abort(); } });
    assert.equal(kills, 1); assert.ok(f.instance.unavailableReason); assert.equal(f.destroyed(), true);
  });
}
