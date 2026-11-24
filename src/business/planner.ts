import { AppError } from "../errors.js";
import { Day, MetricRequest, days, type BusinessEvidence, type BusinessMetric, type BusinessRelation, type BusinessTable, type CatalogDraft, type CatalogVersion, type Window } from "./types.js";

const q = (s: string) => '`' + s.replaceAll('`', '``') + '`';
const col = (alias: string, field: string) => `${alias}.${q(field)}`;
const tab = (t: BusinessTable) => `${q(t.schema)}.${q(t.name)}`;
const val = (v: string | number) => typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;
const invalid = (message: string): never => { throw new AppError("INVALID_INPUT", message); };
const unique = (xs: string[]) => new Set(xs).size === xs.length;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
const contains = (larger: Window, smaller: Window) => larger.start <= smaller.start && larger.end >= smaller.end;
const predicates = (alias: string, filters: Array<{ field: string; value: number | string }>) => filters.map(f => `${col(alias, f.field)} = ${val(f.value)}`);

export function validateCatalog(c: CatalogDraft) {
  if (![c.tables, c.relations, c.metrics].every(entries => unique(entries.map(e => e.id))) || !unique(c.tables.map(t => `${t.schema}.${t.name}`))) invalid("Catalog IDs and physical tables must be unique");
  const tables = new Map(c.tables.map(t => [t.id, t]));
  const relations = new Map(c.relations.map(r => [r.id, r]));
  for (const t of c.tables) {
    if (!unique(t.keys) || !unique(t.fields.map(f => f.column))) invalid(`Duplicate key/field: ${t.id}`);
    if (t.completeFrom && t.completeThrough && t.completeFrom > t.completeThrough) invalid(`Invalid coverage: ${t.id}`);
  }
  for (const r of c.relations) {
    if (!tables.has(r.from) || !tables.has(r.to) || r.from === r.to || !unique(r.fromFields) || !unique(r.toFields) || r.fromFields.length !== r.toFields.length || r.metrics.some(id => !c.metrics.some(m => m.id === id))) invalid(`Invalid relationship: ${r.id}`);
  }
  for (const m of c.metrics) {
    const t = tables.get(m.table);
    if (!t?.time || t.level !== "detail") invalid(`Metric ${m.id} requires a detail table and an event date`);
    if (!unique(m.dimensions.map(d => d.id)) || !unique(m.allowedFilters.map(f => f.id))) invalid(`Duplicate dimensions/filters: ${m.id}`);
    if (m.measure.kind === "net") {
      const r = relations.get(m.measure.relation);
      const detail = r && tables.get(r.to);
      if (!r || r.from !== m.table || r.use !== "preaggregate_fact" || r.cardinality !== "one_to_many" || !r.metrics.includes(m.id) ||
          !detail?.time || detail.level !== "detail" || !sameSet(r.fromFields, t!.keys) || !r.toFields.every(f => detail.keys.includes(f)))
        invalid(`Net metric ${m.id} requires a child fact linked by the full parent key (including tenant) with its own detail key/date`);
      if (m.dimensions.length) invalid(`Net metric ${m.id} has no dimension allocation template; publish an order-level definition only`);
    }
    for (const d of m.dimensions) {
      if (d.additive && !["sum", "count"].includes(m.measure.kind)) invalid(`The metric ${m.id} cannot be summed across ${d.id}`);
      if (!d.relation) continue;
      const r = relations.get(d.relation);
      const to = r && tables.get(r.to);
      if (!r || r.from !== m.table || !r.metrics.includes(m.id) || r.use !== "current_dimension" || !["many_to_one", "one_to_one"].includes(r.cardinality) ||
          to?.level !== "dimension" || !sameSet(r.toFields, to.keys)) invalid(`Dimension ${d.id} requires a reviewed path to a full current-dimension key. Event/history and many-to-many paths are not compiled.`);
    }
  }
}

export function relationPassed(r: BusinessRelation) {
  const c = r.check;
  return Boolean(c && c.duplicateKeys === 0 && c.outputRows === c.inputRows && c.factKeysBefore === c.inputRows && c.factKeysBefore === c.factKeysAfter &&
    (r.use === "preaggregate_fact" || c.unmatchedRows === 0));
}

function timeExpr(t: BusinessTable, alias: string, timezone: string) {
  const time = t.time!;
  const field = col(alias, time.field);
  return time.storage === "business_date" ? field : `DATE(CONVERT_TZ(${field}, '+00:00', ${val(timezone === "UTC" ? "+00:00" : timezone)}))`;
}
function range(t: BusinessTable, alias: string, w: Window, timezone: string) {
  const field = col(alias, t.time!.field);
  const bound = (day: string) => t.time!.storage === "business_date" ? val(day)
    : `CONVERT_TZ(${val(day + " 00:00:00")}, ${val(timezone === "UTC" ? "+00:00" : timezone)}, '+00:00')`;
  return `(${field} >= ${bound(w.start)} AND ${field} < ${bound(w.end)})`;
}
// These are the only identifier positions exposed by the templates. Values must be parsed by
// MetricRequest/CatalogDraft; all executable SQL goes back through the session guard.
export function compileMetric(version: CatalogVersion, input: unknown) {
  const parsed = MetricRequest.safeParse(input);
  if (!parsed.success) return invalid("Invalid metric input; supply explicit [start,end) dates, metric, and an allowed grain");
  const p = parsed.data, c = version.catalog;
  const m = c.metrics.find(m => m.id === p.metric_id) ?? invalid("Choose a published metric ID");
  const t = c.tables.find(t => t.id === m.table)!;
  const d = p.dimension ? m.dimensions.find(d => d.id === p.dimension) ?? invalid("This dimension has no published attribution or allocation rule") : undefined;
  const vs = p.comparison;
  if (vs && (days(vs) !== days(p.window) || vs.end > p.window.start)) return invalid("The comparison must precede the current period, have equal length, and not overlap");
  if (m.measure.kind === "net" && p.grain !== "period") return invalid("Net payment attribution is published at period grain only");
  const filters = [...m.filters];
  if (!unique(p.filters.map(f => f.id))) return invalid("Specify each filter once");
  for (const f of p.filters) {
    const allowed = m.allowedFilters.find(x => x.id === f.id) ?? invalid(`Filter ${f.id} has no published definition`);
    filters.push({ field: allowed.field, value: f.value });
  }
  const related = (id: string) => c.relations.find(r => r.id === id)!;
  const dimensionJoin = d?.relation ? related(d.relation) : undefined;
  const net = m.measure.kind === "net" ? m.measure : undefined;
  const netJoin = net && related(net.relation);
  const windows = [p.window, ...(vs ? [vs] : [])];
  const relations = [...new Set([dimensionJoin, netJoin].filter(r => r !== undefined))];
  const tables = [t, ...relations.map(r => c.tables.find(x => x.id === r.to)!)];
  const reasons: string[] = version.reviewer ? [] : ["指标定义未签认"];
  const starts = tables.filter(x => x.time).map(x => x.completeFrom);
  const ends = tables.filter(x => x.time).map(x => x.completeThrough);
  const coverStart = starts.every(Boolean) ? (starts as string[]).sort().at(-1) : undefined;
  const coverEnd = ends.every(Boolean) ? (ends as string[]).sort()[0] : undefined;
  if (!coverStart || !coverEnd) reasons.push("覆盖日期待核验");
  else if (windows.some(w => w.start < coverStart || w.end > new Date(Date.parse(coverEnd) + 86400000).toISOString().slice(0, 10))) reasons.push("请求范围超出签认的数据覆盖区间");
  for (const r of relations) {
    if (!relationPassed(r)) return invalid(`Relationship ${r.id} has no passing check on the published transformation`);
    if (windows.some(w => !contains(r.check!.window, w))) return invalid(`Relationship ${r.id} has not been checked for the requested window`);
    if ((m.measure.kind === "sum" || net) && !r.check!.measureReconciled) reasons.push(`关系 ${r.id} 缺少金额对账`);
  }
  const includeDeductions = Boolean(net && t.keys.every(k => filters.some(f => f.field === k)));
  const branches = windows.map((window, index) => {
    const period = index ? "comparison" : "current";
    const sliced = (a: string, table: BusinessTable) => range(table, a, window, c.timezone);
    const where = [sliced("f", t), ...predicates("f", filters)].join(" AND ");
    const keyCols = t.keys.map(f => col("f", f));
    const keyInvalid = keyCols.map(k => `${k} IS NULL`).join(" OR ");
    const partition = keyCols.join(", ");
    const day = p.grain === "day" ? timeExpr(t, "f", c.timezone) : val(window.start);
    const a = m.measure;
    const selectField = a.kind === "count" ? "1" : a.kind === "ratio" ? `CASE WHEN ${predicates("f", [a.numerator])[0]} THEN 1 ELSE 0 END` : col("f", a.field);
    const projectedKeys = t.keys.map((key, i) => `${col("f", key)} AS k${i}`);
    const fks = dimensionJoin?.fromFields.map((key, i) => `${col("f", key)} AS d${i}`) ?? [];
    const fAlias = (key: string) => `f.k${t.keys.indexOf(key)}`;
    const fromCount = dimensionJoin?.cardinality === "one_to_one"
      ? [`COUNT(*) OVER (PARTITION BY ${dimensionJoin.fromFields.map(f => col("f", f)).join(", ")}) AS source_count`]
      : [];
    const inputRows = `f${index} AS (SELECT ${[...projectedKeys, ...fks, ...fromCount, `${day} AS day_key`, `${selectField} AS base_value`,
      `CASE WHEN ${keyInvalid} THEN 1 ELSE 0 END AS null_key`, `COUNT(*) OVER (PARTITION BY ${partition}) AS key_count`,
      ...(d && !dimensionJoin ? [`${col("f", d.field)} AS dim_value`] : [])].join(", ")} FROM ${tab(t)} AS f WHERE ${where})`;
    let lookup = "", join = "", dim = d ? "f.dim_value" : "NULL", details = "";
    const factIssues = "f.null_key <> 0 OR f.key_count <> 1 OR f.day_key IS NULL" + (a.kind === "sum" || a.kind === "distinct" ? " OR f.base_value IS NULL" : "");
    let issues = factIssues;
    if (dimensionJoin && d) {
      const table = c.tables.find(x => x.id === dimensionJoin.to)!;
      const fields = dimensionJoin.toFields.map(key => col("d", key));
      lookup = `, d${index} AS (SELECT ${fields.map((f,i) => `${f} AS dk${i}`).join(", ")}, MAX(${col("d", d.field)}) AS dim_value, COUNT(*) AS target_count FROM ${tab(table)} AS d GROUP BY ${fields.join(", ")})`;
      join = ` LEFT JOIN d${index} AS d ON ${fields.map((_, i) => `f.d${i} = d.dk${i}`).join(" AND ")}`;
      dim = "d.dim_value";
      issues += ` OR COALESCE(d.target_count, 0) <> 1${dimensionJoin.cardinality === "one_to_one" ? " OR f.source_count > 1" : ""}`;
    }
    let refund = "0", refundRows = "0";
    if (net && netJoin) {
      const table = c.tables.find(x => x.id === netJoin.to)!;
      const fk = netJoin.toFields.map(key => col("r", key));
      const keys = table.keys.map(key => col("r", key));
      const amount = col("r", net.deduction);
      lookup = `, r${index} AS (SELECT ${fk.map((k,i) => `${k} AS rk${i}`).join(", ")}, ${amount} AS amount, CONCAT_WS(' | ', ${keys.map(k => `CAST(${k} AS STRING)`).join(", ")}) AS deduction_key, COUNT(*) OVER (PARTITION BY ${keys.join(", ")}) AS key_count, CASE WHEN ${[...keys, amount].map(k => `${k} IS NULL`).join(" OR ")} THEN 1 ELSE 0 END AS bad_detail FROM ${tab(table)} AS r WHERE ${[sliced("r", table), ...predicates("r", net.filters)].join(" AND ")}), ` +
        `rs${index} AS (SELECT ${fk.map((_,i) => `rk${i}`).join(", ")}, SUM(amount) AS refund, COUNT(*) AS refund_rows, SUM(CASE WHEN key_count = 1 AND bad_detail = 0 THEN 0 ELSE 1 END) AS bad_rows FROM r${index} GROUP BY ${fk.map((_,i) => `rk${i}`).join(", ")})`;
      join = ` LEFT JOIN rs${index} AS r ON ${netJoin.fromFields.map((k,i) => `${fAlias(k)} = r.rk${i}`).join(" AND ")}`;
      refund = "COALESCE(r.refund, 0)";
      refundRows = "COALESCE(r.refund_rows, 0)";
      issues += " OR f.base_value IS NULL OR COALESCE(r.bad_rows, 0) <> 0";
      if (includeDeductions) {
        details = `SELECT ${val(period)} AS period_key, f.day_key AS business_day, 'deduction' AS row_kind, NULL AS dimension_value, ` +
          `r.amount AS metric_value, NULL AS numerator, NULL AS denominator, 0 AS invalid_rows, NULL AS deduction_rows, r.deduction_key AS deduction_key FROM r${index} AS r JOIN f${index} AS f ON ` +
          netJoin.fromFields.map((k,i) => `${fAlias(k)} = r.rk${i}`).join(" AND ") + ` WHERE f.key_count = 1 AND f.null_key = 0 AND f.base_value IS NOT NULL AND r.key_count = 1 AND r.bad_detail = 0`;
      }
    }
    const enriched = `, e${index} AS (SELECT f.day_key, ${dim} AS dim_value, f.base_value, ${refund} AS refund, ${refundRows} AS refund_rows, CASE WHEN ${issues} THEN 1 ELSE 0 END AS invalid_row FROM f${index} AS f${join})`;
    const numerator = a.kind === "count" ? "COUNT(*)" : a.kind === "distinct" ? "COUNT(DISTINCT base_value)" : a.kind === "net" ? "SUM(base_value) - SUM(refund)" : "SUM(base_value)";
    const value = a.kind === "ratio" ? `(${numerator}) * ${a.unitMultiplier}.0 / NULLIF(COUNT(*), 0)` : numerator;
    const selection = (breakdown: boolean) => {
      // Reconcile dimension groups with an independent total from the unjoined fact slice.
      const baseOnly = !breakdown && Boolean(dimensionJoin);
      const bad = baseOnly ? `SUM(CASE WHEN ${factIssues} THEN 1 ELSE 0 END)` : "SUM(invalid_row)";
      return `SELECT ${val(period)} AS period_key, day_key AS business_day, ${breakdown ? "'group'" : "'total'"} AS row_kind, ${breakdown ? "dim_value" : "NULL"} AS dimension_value, ` +
        `CASE WHEN ${bad} = 0 THEN ${value} ELSE NULL END AS metric_value, ` +
        `CASE WHEN ${bad} = 0 THEN ${a.kind === "ratio" || net ? "SUM(base_value)" : "NULL"} ELSE NULL END AS numerator, ` +
        `CASE WHEN ${bad} = 0 THEN ${a.kind === "ratio" ? "COUNT(*)" : net ? "SUM(refund)" : "NULL"} ELSE NULL END AS denominator, ` +
        `${bad} AS invalid_rows, ${net ? "SUM(refund_rows)" : "NULL"} AS deduction_rows, NULL AS deduction_key FROM ${baseOnly ? `f${index} AS f` : `e${index}`} GROUP BY day_key${breakdown ? ", dim_value" : ""}`;
    };
    return { ctes: inputRows + lookup + enriched, selects: [selection(false), ...(d ? [selection(true)] : []), ...(details ? [details] : [])] };
  });
  const sql = `WITH ${branches.map(b => b.ctes).join(", ")} ${branches.flatMap(b => b.selects).join(" UNION ALL ")} ORDER BY period_key, business_day, row_kind, dimension_value, metric_value, deduction_key`;
  const evidence: BusinessEvidence = {
    domain: c.domain, version: version.id, reviewer: version.reviewer ?? "", timezone: c.timezone,
    metric: { id: m.id, label: m.label, unit: m.unit, owner: m.owner, definition: m.definition, visualization: m.visualization },
    request: p, measure: m.measure.kind, ratio_multiplier: m.measure.kind === "ratio" ? m.measure.unitMultiplier : undefined,
    deduction_details: includeDeductions, available_dimensions: m.dimensions.map(({ id, label }) => ({ id, label })), dimension: d && { id: d.id, label: d.label, additive: d.additive }, relations,
    tables: tables.map(({schema, name, grain, keys, time}) => ({schema, name, grain, keys, time})),
    complete_from: coverStart, complete_through: coverEnd, status: "limited", reasons,
  };
  return { sql, evidence, metric: m, tables };
}

export const isDay = (day: unknown): day is string => Day.safeParse(day).success;
export type BoundMetric = ReturnType<typeof compileMetric>;
export type { BusinessMetric };
