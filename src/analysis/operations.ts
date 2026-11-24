import { z } from "zod";
import { AppError } from "../errors.js";
import type { ResultMeta } from "../results/store.js";
import { isLocalNumeric } from "./results.js";

const field = z.string().min(1).max(128);
export const ResultOperation = z.strictObject({
  filters: z.array(z.strictObject({ field, op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "is_null"]), value: z.union([z.string().max(512), z.number(), z.boolean()]).optional() })).max(12).optional(),
  group_by: z.array(field).max(8).optional(),
  aggregates: z.array(z.strictObject({ fn: z.enum(["sum", "avg", "min", "max", "count", "count_distinct"]), field: field.optional(), as: field })).max(8).optional(),
  sort: z.array(z.strictObject({ field, direction: z.enum(["asc", "desc"]) })).max(8).optional(),
  share: z.strictObject({ field, as: field }).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});
export type ResultOperation = z.infer<typeof ResultOperation>;

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const decimal = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d{1,3})?$/;
const comparator = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export function compileResultOperation(meta: ResultMeta, input: unknown): string {
  const parsed = ResultOperation.safeParse(input);
  if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid structured result operation", { issues: parsed.error.issues });
  const p = parsed.data;
  if (meta.truncated !== "none") throw new AppError("RESULT_FAILED", "Structured operations require a complete result; request the missing data first");
  if (meta.lineage?.operation === "local_sql" && meta.warnings?.some((w) => /incomplete|partial/i.test(w)))
    throw new AppError("RESULT_FAILED", "A derivative of incomplete input is not a complete result");
  const columns = new Map(meta.columns.map((c) => [c.name, c.type]));
  if (columns.size !== meta.columns.length) throw new AppError("INVALID_INPUT", "Duplicate columns must be disambiguated first");
  function requireField(name: string, available = columns) {
    const type = available.get(name);
    if (!type) throw new AppError("INVALID_INPUT", `Stored result has no field ${name}; it may require a source query`);
    return type;
  }
  const groups = p.group_by ?? [], measures = p.aggregates ?? [];
  // Official cubes carry multiple grains (overall and breakdown). Do not re-aggregate them
  // or infer denominators from their rows. The business definition owns those operations.
  if (meta.business && (groups.length || measures.length || p.share))
    throw new AppError("INVALID_INPUT", "Use the published metric at the requested grain; do not re-aggregate a stored business cube");
  if (groups.length && !measures.length) throw new AppError("INVALID_INPUT", "group_by requires aggregates");
  const outputs = measures.length ? new Map<string, string>() : new Map(columns);
  const addOutput = (name: string, type: string) => {
    if (outputs.has(name) || name.includes("\0") || Buffer.byteLength(name) > 63)
      throw new AppError("INVALID_INPUT", `Duplicate or invalid output column ${name}`);
    outputs.set(name, type);
  };
  const selected = groups.map((name) => {
    addOutput(name, requireField(name));
    return ident(name);
  });
  for (const agg of measures) {
    const type = agg.field && requireField(agg.field);
    if (agg.fn !== "count" && !type) throw new AppError("INVALID_INPUT", `${agg.fn} requires a field`);
    if ((agg.fn === "sum" || agg.fn === "avg") && !isLocalNumeric(type!)) throw new AppError("INVALID_INPUT", `${agg.fn} requires a numeric field`);
    const resultType = ["min", "max"].includes(agg.fn) ? type! : "numeric";
    addOutput(agg.as, resultType);
    const expression = agg.field ? ident(agg.field) : "*";
    selected.push(`${agg.fn === "count_distinct" ? `COUNT(DISTINCT ${expression})` : `${agg.fn.toUpperCase()}(${expression})`} AS ${ident(agg.as)}`);
  }
  const filters = (p.filters ?? []).map((f) => {
    const type = requireField(f.field);
    if (f.op === "is_null") return `${ident(f.field)} IS NULL`;
    if (f.value === undefined) throw new AppError("INVALID_INPUT", `${f.op} requires a value`);
    let literal: string;
    if (isLocalNumeric(type)) {
      if (!decimal.test(String(f.value))) throw new AppError("INVALID_INPUT", `${f.field} requires a decimal value`);
      literal = String(f.value);
    } else if (/bool/i.test(type)) {
      if (typeof f.value !== "boolean") throw new AppError("INVALID_INPUT", `${f.field} requires a boolean`);
      literal = f.value ? "TRUE" : "FALSE";
    } else {
      if (typeof f.value !== "string" || f.value.includes("\0")) throw new AppError("INVALID_INPUT", `${f.field} requires a text value`);
      literal = `'${f.value.replaceAll("'", "''")}'`;
    }
    return `${ident(f.field)} ${comparator[f.op]} ${literal}`;
  });
  let sql = `SELECT ${selected.join(", ") || "*"} FROM data`;
  if (filters.length) sql += ` WHERE ${filters.join(" AND ")}`;
  if (groups.length) sql += ` GROUP BY ${groups.map(ident).join(", ")}`;
  if (p.share) {
    if (!isLocalNumeric(requireField(p.share.field, outputs))) throw new AppError("INVALID_INPUT", "Share requires a numeric field");
    addOutput(p.share.as, "numeric");
    const field = ident(p.share.field);
    sql = `SELECT *, CAST(${field} AS numeric) / NULLIF(SUM(${field}) OVER (), 0) AS ${ident(p.share.as)} FROM (${sql}) AS grouped_data`;
  }
  if (p.sort?.length) sql += " ORDER BY " + p.sort.map((s) => {
    requireField(s.field, outputs);
    return `${ident(s.field)} ${s.direction.toUpperCase()} NULLS LAST`;
  }).join(", ");
  if (p.limit) sql += ` LIMIT ${p.limit}`;
  return sql;
}
