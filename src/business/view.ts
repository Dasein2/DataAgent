import { AppError } from "../errors.js";
import type { ResultMeta, ResultStore } from "../results/store.js";
import { days, resultValueRef, type BusinessEvidence, type Window } from "./types.js";

const fields = ["period_key", "business_day", "row_kind", "dimension_value", "metric_value", "numerator", "denominator", "invalid_rows", "deduction_rows"];
const numberPattern = /^-?\d+(?:\.\d+)?$/;
function exact(value: unknown): string | null {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isSafeInteger(value))) return null;
  const str = String(value);
  return str.length <= 100 && numberPattern.test(str) ? str : null;
}
const scale = (v: string) => v.split(".")[1]?.length ?? 0;
function decimal(values: Array<{ value: string; sign?: bigint }>) {
  const digits = Math.max(0, ...values.map(v => scale(v.value)));
  const sum = values.reduce((acc, { value, sign = 1n }) => acc + BigInt(value.replace(".", "")) * 10n ** BigInt(digits - scale(value)) * sign, 0n);
  const raw = (sum < 0n ? -sum : sum).toString().padStart(digits + 1, "0");
  return (sum < 0n ? "-" : "") + (digits ? (raw.slice(0, -digits) + "." + raw.slice(-digits)).replace(/\.?0+$/, "") : raw);
}
const delta = (a: string, b: string) => decimal([{ value: a }, { value: b, sign: -1n }]);
function dateList(w: Window, daily: boolean) {
  return Array.from({ length: daily ? days(w) : 1 }, (_, index) => new Date(Date.parse(w.start) + index * 86_400_000).toISOString().slice(0,10));
}
const groupKey = (v: unknown) => v === null ? "null" : `${typeof v}:${String(v)}`;
function formatGroup(v: unknown) { return v === null ? "（未归类）" : String(v); }

export function buildBusinessView(meta: ResultMeta, raw: unknown[][], evidence: BusinessEvidence) {
  const { request } = evidence;
  const reasons = new Set(evidence.reasons);
  const indexes = fields.map(name => meta.columns.findIndex(c => c.name === name));
  const shapeOk = indexes.every(i => i >= 0) && new Set(meta.columns.map(c => c.name)).size === meta.columns.length;
  const complete = raw.length === meta.rowCount && meta.truncated === "none" && shapeOk;
  const periods = ["current", ...(request.comparison ? ["comparison"] : [])];
  const byPeriod = new Map(periods.map(p => [p, dateList(p === "current" ? request.window : request.comparison!, request.grain === "day")]));
  type Cell = { value: string; ref: string; label?: string };
  const deductionKey = meta.columns.findIndex(c => c.name === "deduction_key");
  type Entry = { value: Cell | null; numerator: Cell | null; denominator: Cell | null; deduction_count: string | null };
  const days = new Map<string, { total?: Entry; groups: Map<string, { label: string; entry: Entry }>; deductions: Cell[] }>();
  for (const [p, dates] of byPeriod) for (const day of dates) days.set(`${p}:${day}`, { groups: new Map(), deductions: [] });
  let invalid = false;
  if (!complete) reasons.add("结果不完整、已截断或字段不可用，不能进行数值对账");
  if (complete) raw.forEach((row, i) => {
    const [period, day, kind, dim, , , , bad] = indexes.map(c => row[c]);
    const bucket = days.get(`${period}:${day}`);
    if (!bucket || row.some(v => v !== null && typeof v === "object") || exact(bad) !== "0") { invalid = true; return; }
    function cell(slot: number) { const value = exact(row[indexes[slot]!]); return value === null ? null : { value, ref: resultValueRef(meta.id, i, indexes[slot]!) }; }
    const value = cell(4);
    if (!value) { invalid = true; return; }
    const entry: Entry = { value, numerator: cell(5), denominator: cell(6), deduction_count: exact(row[indexes[8]!]) };
    if (kind === "total" && !bucket.total) bucket.total = entry;
    else if (kind === "group" && evidence.dimension && !bucket.groups.has(groupKey(dim))) bucket.groups.set(groupKey(dim), { label: formatGroup(dim), entry });
    else if (kind === "deduction" && evidence.deduction_details && typeof row[deductionKey] === "string") bucket.deductions.push({ ...value, label: row[deductionKey] as string });
    else invalid = true;
  });
  if (invalid) reasons.add("存在重复键、未匹配关系、缺失值或无法核验的行；不展示该批数值");
  const currentDates = byPeriod.get("current")!;
  const baselineDates = byPeriod.get("comparison");
  const available = complete && !invalid;
  let reconciled = true, missing = false;
  let maxChange = 0;
  const entries = currentDates.map((day, index) => {
    const priorDay = baselineDates?.[index] ?? (index ? currentDates[index - 1]! : null);
    const current = days.get(`current:${day}`)!;
    const previous = priorDay ? days.get(`${baselineDates ? "comparison" : "current"}:${priorDay}`) : undefined;
    if (!current.total || (priorDay && !previous?.total)) missing = true;
    const ratioValid = (entry: Entry) => {
      const num = Number(entry.numerator?.value), den = Number(entry.denominator?.value);
      const expected = num * (evidence.ratio_multiplier ?? 1) / den;
      return entry.value && Number.isSafeInteger(num) && Number.isSafeInteger(den) && den > 0 && num >= 0 && num <= den && Math.abs(expected - Number(entry.value.value)) <= 0.0001;
    };
    for (const side of [current, previous]) {
      if (!side?.total?.value) continue;
      if (evidence.dimension?.additive && (!side.groups.size || delta(decimal([...side.groups.values()].map(g => ({ value: g.entry.value!.value }))), side.total.value.value) !== "0")) reconciled = false;
      const total = side.total;
      const amount = side.total.value;
      if (evidence.measure === "net") {
        if (!total.numerator || !total.denominator || delta(total.numerator.value, total.denominator.value) !== decimal([amount])) reconciled = false;
        if (evidence.deduction_details && (!total.denominator || delta(decimal(side.deductions), total.denominator.value) !== "0" || String(side.deductions.length) !== total.deduction_count)) reconciled = false;
      }
      if (evidence.measure === "ratio" && (!ratioValid(total) || [...side.groups.values()].some(g => !ratioValid(g.entry)))) reconciled = false;
    }
    const all = [...new Set([...current.groups.keys(), ...(previous?.groups.keys() ?? [])])];
    const channels = all.map(key => {
      const a = current.groups.get(key), b = previous?.groups.get(key);
      const change = evidence.dimension?.additive && a?.entry.value && b?.entry.value ? delta(a.entry.value.value, b.entry.value.value) : null;
      if (change !== null) maxChange = Math.max(maxChange, Math.abs(Number(change)));
      return { key, label: (a ?? b)!.label, current: a?.entry ?? null, comparison: b?.entry ?? null, change };
    }).sort((a, b) => Math.abs(Number(b.change ?? 0)) - Math.abs(Number(a.change ?? 0)) || a.label.localeCompare(b.label));
    const total = current.total?.value, baseline = previous?.total?.value;
    if (evidence.dimension && previous?.total && current.total && channels.some(c => !c.current || !c.comparison)) missing = true;
    const previousZero = Boolean(baseline && decimal([baseline]) === "0");
    return {
      day, comparison_day: priorDay, current: available ? current.total ?? null : null, comparison: available ? previous?.total ?? null : null,
      change: available && total && baseline ? delta(total.value, baseline.value) : null,
      comparison_zero: available && previousZero,
      channels: available ? channels : [], deductions: available ? current.deductions : [],
      breakdown_comparable: Boolean(available && evidence.dimension?.additive && priorDay && channels.length && channels.every(c => c.change !== null)),
    };
  });
  if (missing) reasons.add("部分日期或分组缺数；留空，不推定为零");
  if (!reconciled) reasons.add("分组或明细无法与独立总数对账");
  const status = !available || !reconciled || !entries.some(e => e.current?.value) ? "unconfirmed" : reasons.size ? "limited" : "verified";
  const visible = available && reconciled;
  return { result_id: meta.id, executed_at: meta.createdAt, ...evidence, status, reasons: [...reasons],
    days: visible ? entries : entries.map(d => ({ ...d, current: null, comparison: null, change: null, comparison_zero: false, channels: [], deductions: [], breakdown_comparable: false })),
    max_change: visible ? maxChange : 0, empty: available && meta.rowCount === 0 } as const;
}

const cap = 2_000;
export async function readBusinessView(store: ResultStore, meta: ResultMeta) {
  if (!meta.business || meta.error) throw new AppError("NOT_FOUND", "No structured business report for this result");
  const rows: unknown[][] = [];
  if (meta.truncated === "none" && meta.rowCount <= cap) {
    for await (const row of store.iterateRows(meta.id)) { rows.push(row); if (rows.length > cap) break; }
  }
  return buildBusinessView(meta, rows, meta.business);
}
