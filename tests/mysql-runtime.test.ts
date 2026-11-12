import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { it } from "node:test";
import { MysqlEngine, DorisEngine, StarrocksEngine } from "../src/db/engines/mysql.js";
import { ConnectionConfig } from "../src/db/types.js";

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

for (const engine of ["mysql", "doris", "starrocks"] as const) {
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
