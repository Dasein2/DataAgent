import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { guardSql } from "../../src/db/guard.js";
import { CatalogDraft } from "../../src/business/types.js";
import { compileMetric } from "../../src/business/planner.js";
import { buildBusinessView } from "../../src/business/view.js";
import type { ResultMeta } from "../../src/results/store.js";

const range = { start: "2026-11-01", end: "2026-12-01" };
const check = { window: range, source: "冻结样例，非正式口径", checkedAt: "2026-12-01T00:00:00Z", inputRows: 1, outputRows: 1, factKeysBefore: 1, factKeysAfter: 1, duplicateKeys: 0, unmatchedRows: 0, measureReconciled: true };
const table = (id: string, keys: string[], label: string, timeField?: string) => ({ id, schema: "sales", name: id, keys, label, level: timeField ? "detail" : "dimension", grain: `一行一个${label}`, time: timeField && { field: timeField, storage: "business_date" }, completeFrom: range.start, completeThrough: "2026-11-30" });
export const catalog = CatalogDraft.parse({ domain: "支付（模拟）", timezone: "Asia/Shanghai", tables: [
  table("orders", ["tenant", "oid"], "订单", "paid_on"), table("refunds", ["tenant", "oid", "rid"], "退款", "posted_on"), table("channels", ["tenant", "cid"], "渠道"),
], relations: [
  { id: "orders_refunds", from: "orders", to: "refunds", fromFields: ["tenant", "oid"], toFields: ["tenant", "oid"], cardinality: "one_to_many", use: "preaggregate_fact", purpose: "同一订单当期已入账退款", metrics: ["net"], source: "样例", check },
  { id: "orders_channels", from: "orders", to: "channels", fromFields: ["tenant", "cid"], toFields: ["tenant", "cid"], cardinality: "many_to_one", use: "current_dimension", purpose: "订单渠道", metrics: ["payments"], source: "样例", check },
], metrics: [
  { id: "net", label: "净收款", owner: "样例", definition: "当期已支付订单的金额减去这些订单在当期已入账退款", unit: "元", table: "orders", filters: [{ field: "state", value: "paid" }], allowedFilters: [{ id: "tenant", field: "tenant", label: "租户" }, { id: "order", field: "oid", label: "订单" }], measure: { kind: "net", field: "amount", deduction: "amount", relation: "orders_refunds", filters: [{ field: "state", value: "posted" }] } },
  { id: "payments", label: "支付订单", aliases: ["支付单量"], owner: "样例", definition: "按支付日计算当日已支付订单数", unit: "单", table: "orders", measure: { kind: "count" }, filters: [{ field: "state", value: "paid" }], dimensions: [{ id: "channel", label: "渠道", field: "label", relation: "orders_channels", additive: true }], visualization: "trend_breakdown" },
] });
export const version = { id: "biz_fixture", at: check.checkedAt, reviewer: "样例验收", catalog };
export const net = { metric_id: "net", window: range, filters: [{ id: "tenant", value: 1 }, { id: "order", value: 1 }] };
export const trend = { metric_id: "payments", grain: "day", dimension: "channel", window: { start: "2026-11-19", end: "2026-11-21" } };

// Execute the generated relational plan on frozen local rows. Only syntax is adapted; this
// deliberately does not claim Doris driver/dialect/optimizer compatibility.
export async function execute(db: PGlite, query: unknown, def = version) {
  const plan = compileMetric(def, query);
  const guard = guardSql(plan.sql, { engine: "doris", allowedScopes: ["sales"] });
  assert.equal(guard.ok, true, guard.reason);
  const result = await queryFrozen(db, plan.sql);
  const rows = result.rows.map(row => row.map(v => v instanceof Date ? v.toISOString().slice(0, 10) : v));
  const meta = { id: "res_fixtures1", columns: result.fields.map(f => ({ name: f.name, type: "text" })), rowCount: rows.length, truncated: "none", business: plan.evidence } as ResultMeta;
  return { meta, rows, report: buildBusinessView(meta, rows, plan.evidence) };
}

export async function queryFrozen(db: PGlite, sql: string) {
  const built = sql.replace(/`([\w]+)`/g, '"$1"').replace(/ AS STRING\)/g, " AS TEXT)")
    .replace(/NULL AS dimension_value/g, "NULL::text AS dimension_value")
    .replace(/CONVERT_TZ\(([^,]+), '([^']+)', '([^']+)'\)/g, (_, input, from, to) =>
      `(CAST(${input} AS timestamp) AT TIME ZONE '${from === "+00:00" ? "UTC" : from}' AT TIME ZONE '${to === "+00:00" ? "UTC" : to}')`);
  return db.query<unknown[]>(built, [], { rowMode: "array", parsers: { 20: v => v, 1700: v => v } });
}

export async function data() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA sales;
    CREATE TABLE sales.orders(tenant int, oid int, paid_on date, cid int, state text, amount numeric(20,2));
    CREATE TABLE sales.channels(tenant int, cid int, label text);
    CREATE TABLE sales.refunds(tenant int, oid int, rid int, posted_on date, state text, amount numeric(20,2));
    CREATE TABLE sales.items(tenant int, oid int, sku text);
    INSERT INTO sales.orders VALUES (1,1,'2026-11-04',1,'paid',100), (2,1,'2026-11-04',1,'paid',100);
    INSERT INTO sales.refunds VALUES (1,1,1,'2026-11-06','posted',10), (1,1,2,'2026-11-07','posted',20), (2,1,1,'2026-11-06','posted',99), (1,1,3,'2026-11-07','pending',80);
    INSERT INTO sales.items VALUES (1,1,'A'),(1,1,'B');
    INSERT INTO sales.channels VALUES (1,1,'自然搜索'),(1,2,'广告投放'),(1,3,'直接访问'),(2,1,'另一租户的渠道');
    INSERT INTO sales.orders SELECT 1, s.seq + 10000*v.batch, v.day::date, v.cid, 'paid', 1 FROM
    (VALUES (1,'2026-11-19',1,220),(2,'2026-11-19',2,165),(3,'2026-11-19',3,65),(4,'2026-11-20',1,210),(5,'2026-11-20',2,90),(6,'2026-11-20',3,60)) v(batch, day, cid, n)
    JOIN LATERAL generate_series(1,v.n) s(seq) ON TRUE`);
  return db;
}
