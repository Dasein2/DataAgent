import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BusinessAnalysis, BusinessCatalogStore } from "../scripts/doris-pilot/service.js";
import { readBusinessView } from "../src/business/view.js";
import { CatalogDraft, parseResultValueRef } from "../src/business/types.js";
import { compileMetric, validateCatalog } from "../scripts/doris-pilot/planner.js";
import { buildBusinessView } from "../src/business/view.js";
import { ResultStore, type ResultMeta } from "../src/results/store.js";
import type { DbSession } from "../src/db/session.js";

import { catalog, version, net, trend, execute, data } from "./fixtures/frozen-business.js";

it("executes the frozen refund plan: 70 not 340; exact equal amounts and composite tenant keys", async () => {
  validateCatalog(catalog);
  const db = await data();
  try {
    const old = await db.query(`SELECT SUM(o.amount) - SUM(r.amount) AS wrong FROM sales.orders o JOIN sales.refunds r USING (tenant,oid) JOIN sales.items i USING (tenant,oid) WHERE o.tenant=1 AND o.oid=1 AND r.state='posted'`);
    assert.equal(String(old.rows[0]!.wrong), "340.00");
    const a = await execute(db, net);
    assert.equal(a.report.status, "verified", a.report.reasons.join());
    const d = a.report.days[0]!;
    assert.equal(d.current?.value?.value, "70.00");
    assert.equal(d.current?.numerator?.value, "100.00");
    assert.equal(d.current?.denominator?.value, "30.00");
    assert.deepEqual(d.deductions.map(c => c.value), ["10.00", "20.00"]);
    assert.throws(() => compileMetric(version, { ...net, dimension: "product" }), /allocation rule/);
    assert.doesNotMatch(compileMetric(version, net).sql, /\bitems\b|DISTINCT/);
    await db.exec("UPDATE sales.refunds SET amount=10 WHERE tenant=1 AND rid=2; INSERT INTO sales.orders VALUES (1,2,'2026-11-04',1,'paid',100)");
    const equal = await execute(db, { ...net, window: { start: "2026-11-01", end: "2026-11-08" }, filters: [net.filters[0]] });
    assert.equal(equal.report.days[0]?.current?.value?.value, "180.00");
    await db.exec("INSERT INTO sales.refunds SELECT * FROM sales.refunds WHERE tenant=1 AND rid=2");
    const dup = await execute(db, net);
    assert.equal(dup.report.status, "unconfirmed");
    assert.equal(dup.report.days[0]?.current, null);
    assert.throws(() => compileMetric(version, { ...net, window: { start: "2026-10-01", end: "2026-11-08" } }), /not been checked/);
  } finally { await db.close(); }
});

it("uses half-open business day boundaries; checks ratio operands and never infers zero for missing days", async () => {
  const db = await data();
  try {
    await db.exec(`CREATE TABLE sales.boundary(id int, event_at timestamp, ok int, channel text);
      INSERT INTO sales.boundary VALUES
      (1, '2026-11-18 15:59:59', 1, 'ads'), (2, '2026-11-18 16:00:00', 0, 'ads'),
      (3, '2026-11-19 15:59:59', 0, 'other'), (4, '2026-11-19 16:00:00', 1, 'ads'),
      (5, '2026-11-20 15:59:59', 0, 'ads'), (6, '2026-11-21 16:00:00', 1, 'other')`);
    const c = CatalogDraft.parse({ ...catalog, tables: [...catalog.tables,
      { id: "edge", schema: "sales", name: "boundary", label: "事件", keys: ["id"], grain: "一个事件", level: "detail",
        time: { field: "event_at", storage: "utc_datetime" }, completeFrom: "2026-11-01", completeThrough: "2026-11-30" }],
      metrics: [...catalog.metrics, { id: "rate", label: "成功率", owner: "样例", definition: "成功事件占比", unit: "%", table: "edge",
        measure: { kind: "ratio", numerator: { field: "ok", value: 1 }, unitMultiplier: 100 },
        dimensions: [{ id: "channel", label: "渠道", field: "channel", additive: false }] }] });
    validateCatalog(c);
    const question = { ...trend, metric_id: "rate" };
    const { report, rows, meta } = await execute(db, question, { ...version, catalog: c });
    assert.equal(report.status, "limited"); // 'other' has no row on the second day.
    const [a,b] = report.days;
    assert.deepEqual([a!.current!.numerator?.value, a!.current!.denominator?.value], ["0", "2"]);
    assert.equal(Number(b!.current!.value!.value), 50);
    assert.equal(b!.change, "50"); assert.equal(b!.comparison_zero, true);
    assert.equal(b!.breakdown_comparable, false);
    const { row, column } = parseResultValueRef(b!.channels.find(g => g.label === "ads")!.current!.denominator!.ref)!;
    const zero = structuredClone(rows); zero[row]![column] = "0";
    assert.equal(buildBusinessView(meta, zero, meta.business!).status, "unconfirmed");
    const empty = await execute(db, { ...question, window: { start: "2026-11-21", end: "2026-11-22" } }, { ...version, catalog: c });
    assert.equal(empty.report.empty, true); assert.equal(empty.report.days[0]?.current, null);
  } finally { await db.close(); }
});

it("reconciles -90 with saved operands 90 − 165; fails closed on missing/duplicate joins and truncation", async () => {
  const db = await data();
  try {
    const { report, meta, rows } = await execute(db, trend);
    assert.equal(report.status, "verified");
    const d = report.days[1]!;
    assert.equal(d.current?.value?.value, "360"); assert.equal(d.comparison?.value?.value, "450");
    assert.equal(d.change, "-90"); assert.equal(d.channels.reduce((n,c) => n + Number(c.change), 0), -90);
    const ad = d.channels.find(c => c.label === "广告投放")!;
    assert.equal(ad.change, "-75");
    for (const [cell, expected] of [[ad.current?.value, "90"], [ad.comparison?.value, "165"]] as const) {
      const ref = parseResultValueRef(cell!.ref)!;
      assert.equal(rows[ref.row]![ref.column], expected);
    }
    const totalOnly = await execute(db, { ...trend, dimension: undefined });
    assert.equal(totalOnly.report.days[1]?.current?.value?.value, "360");
    assert.equal(totalOnly.report.days[1]?.breakdown_comparable, false);
    const truncated = buildBusinessView({ ...meta, truncated: "rows" }, rows.slice(0, 2), meta.business!);
    assert.equal(truncated.status, "unconfirmed");
    const falsified = structuredClone(rows);
    const ref = parseResultValueRef(ad.current!.value!.ref)!; falsified[ref.row]![ref.column] = "99";
    assert.equal(buildBusinessView(meta, falsified, meta.business!).status, "unconfirmed");
    await db.exec("INSERT INTO sales.channels VALUES (1,2,'重复渠道')");
    assert.equal((await execute(db, trend)).report.status, "unconfirmed");
    await db.exec("DELETE FROM sales.channels WHERE tenant=1 AND cid=2");
    assert.equal((await execute(db, trend)).report.status, "unconfirmed");
  } finally { await db.close(); }
});

it("persists a dark-by-default revision, refuses stale grants/schema and leaves historical reports readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-catalog-"));
  const path = join(root, "catalog.sqlite");
  let store = new BusinessCatalogStore(path);
  const db = await data();
  let grant = "select-sales", changes = false, calls = 0, disableBeforeDispatch = false;
  const results = new ResultStore(join(root, "results"));
  const cols = { orders: ["tenant", "oid", "paid_on", "cid", "state", "amount"], refunds: ["tenant", "oid", "rid", "posted_on", "state", "amount"], channels: ["tenant", "cid", "label"] };
  const port = {
    snapshot: () => ({ status: "ready" }), scopesView: ["sales"], businessPermissionKey: async () => grant, businessMasked: () => false,
    describeBusiness: async (schema: string, name: keyof typeof cols) => ({ object: { schema, name, kind: "table" }, primaryKey: [], columns: cols[name].filter(f => !changes || f !== "state").map(f => ({ name: f, type: f.endsWith("_on") ? "date" : f === "amount" ? "decimal(20,2)" : ["state", "label"].includes(f) ? "string" : "int", nullable: false })) }),
    measure: (_: string, run: () => unknown) => run(),
    query: async (sql: string, options: { business: ResultMeta["business"]; assertPlanActive(): void }) => {
      if (disableBeforeDispatch) store.enable("alice-connection", false);
      options.assertPlanActive();
      calls++;
      const { meta, rows } = await execute(db, net);
      const writer = await results.create({ sessionId: "sess_fixture", sql, previewRows: 5 });
      writer.setColumns(meta.columns); for (const row of rows) await writer.append(row);
      const created = await writer.finish("none", 1); created.business = options.business; await results.saveMeta(created); return created;
    },
  } as unknown as DbSession;
  let service = new BusinessAnalysis(store, "alice-connection", port, results);
  try {
    const draft = await service.draft(catalog);
    const signed = await service.publish(draft.id, "本地样例签认");
    assert.equal(service.enabled, false);
    await assert.rejects(service.analyze(net), { code: "FEATURE_UNSUPPORTED" });
    await service.enable(true);
    store.close(); store = new BusinessCatalogStore(path); service = new BusinessAnalysis(store, "alice-connection", port, results);
    assert.equal((await service.list()).active, signed.id);
    assert.equal((await service.lookup("请问支付单量")).candidates[0]?.id, "payments");
    const other = new BusinessAnalysis(store, "bob-connection", port, results);
    assert.equal(other.enabled, false); await assert.rejects(other.get(signed.id), { code: "NOT_FOUND" });
    const report = await service.analyze(net);
    assert.equal(report.status, "verified"); assert.equal(calls, 1);
    grant = "different-grants";
    assert.equal((await service.list()).enabled, false);
    await assert.rejects(service.analyze(net), { code: "NOT_FOUND" });
    grant = "select-sales"; changes = true;
    await assert.rejects(service.analyze(net), { code: "SQL_FIELD_ERROR" });
    changes = false; disableBeforeDispatch = true;
    await assert.rejects(service.analyze(net), { code: "FORBIDDEN" });
    assert.equal(calls, 1); assert.equal(service.enabled, false);
    assert.equal((await readBusinessView(results, (await results.get(report.result_id))!)).days[0]?.current?.value?.value, "70.00");
  } finally { store.close(); await db.close(); rmSync(root, { recursive: true, force: true }); }
});
