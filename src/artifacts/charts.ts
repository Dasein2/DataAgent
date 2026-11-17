import { createHash } from "node:crypto";
import type { ColumnMeta } from "../db/engines/base.js";
import { cellText } from "../db/engines/base.js";
import { AppError } from "../errors.js";
import { cellRef } from "./refs.js";
import {
  CHART_TYPES,
  COMPILER_VERSION,
  ECHARTS_VERSION,
  SPEC_VERSION,
  type Artifact,
  type ArtifactColumn,
  type ArtifactData,
  type AxisSpec,
  type ChartCompileInput,
  type ChartSpec,
  type ChartSummary,
  type ChartTop,
  type ChartType,
  type CompiledChart,
  type ValueFormat,
} from "./types.js";

/**
 * Server-side chart compiler.
 *
 * The model submits a *spec* (which fields, which figure, how to order them); this module is the
 * only thing that turns it into an ECharts option. Everything here is deterministic and free of
 * user-supplied JS, HTML or formatter strings: the browser only calls `setOption`, so the chart in
 * the console, the exported SVG and any later snapshot are the same picture by construction.
 *
 * Validation is deliberately chatty. A model cannot see its own chart, so a rejected spec must say
 * what to do next (which fields exist, how many cells is too many, that the result was truncated).
 */

export interface CompiledArtifact {
  data: ArtifactData;
  compiled: CompiledChart;
  alternates: NonNullable<Artifact["alternates"]>;
  summary: ChartSummary;
  spec_hash: string;
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const SEQUENTIAL = ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"];
const DIVERGING = ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"];
const LAST_RESORT_LABEL = "NULL";

/** Deterministic JSON, so an identical spec always hashes to the same value. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function specHash(spec: ChartSpec): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex").slice(0, 32);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError("CHART_SPEC_INVALID", message, details);
}

function label(value: unknown): string {
  if (value === null || value === undefined) return LAST_RESORT_LABEL;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return String(value);
  return cellText(value, 120);
}

export function toNumber(value: unknown, field: string, samples: unknown[]): number {
  const seen = samples.slice(0, 5).map((sample) => label(sample));
  const sawText = seen.length > 0 ? ` Values seen: ${seen.join(", ")}.` : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError("CHART_VALUE_NOT_NUMERIC", `Field "${field}" contains a non-finite number (NaN or Infinity).`, {
        field,
        samples: seen,
      });
    }
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const text = value.trim();
    // PostgreSQL returns numeric/int8 as strings; a strict parse here is what stops "12 apples"
    // from silently becoming NaN in the chart.
    if (NUMERIC.test(text)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw new AppError(
    "CHART_VALUE_NOT_NUMERIC",
    `Field "${field}" is not numeric, so it cannot be plotted as the value axis.${sawText} ` +
      "Cast it in SQL (for example round(x::numeric, 2)) or pick another field.",
    { field, samples: seen },
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function formatValue(value: number | null, format: ValueFormat | undefined): string {
  if (value === null) return "null";
  switch (format) {
    case "percent":
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%`;
    case "decimal":
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    case "compact":
      return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
    default:
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
}

function resolveField(columns: ColumnMeta[], field: string | undefined, role: string): number {
  if (!field || !field.trim()) invalid(`${role}.field is required`);
  const indexes = columns.map((column, index) => (column.name === field ? index : -1)).filter((index) => index >= 0);
  const available = columns.map((column) => column.name);
  if (indexes.length === 0) {
    throw new AppError(
      "CHART_FIELD_UNKNOWN",
      `No column named "${field}" in this result. Available columns: ${available.slice(0, 40).join(", ")}`,
      { role, field, available: available.slice(0, 40) },
    );
  }
  if (indexes.length > 1) {
    throw new AppError(
      "CHART_FIELD_AMBIGUOUS",
      `Column name "${field}" appears ${indexes.length} times; alias it in SQL (for example ${field}_a) and retry.`,
      { role, field, occurrences: indexes.length },
    );
  }
  return indexes[0]!;
}

function resolveAxis(
  axis: AxisSpec,
  seen: string[],
  role: "x" | "y",
  requireExplicit: boolean,
): { labels: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const available = seen.slice(0, 30);
  if (axis.order && axis.order.length > 0) {
    const ordered = axis.order.map((item) => label(item));
    const known = new Set(ordered);
    const extra = seen.filter((item) => !known.has(item));
    if (extra.length > 0) {
      // Never drop data because the declared order was stale; append and say so.
      warnings.push(`${extra.length} ${role} value(s) were absent from order and appended at the end`);
      ordered.push(...extra);
    }
    return { labels: ordered, warnings };
  }
  if (axis.sort === "numeric") {
    const numeric = seen.map((item) => Number(item));
    if (numeric.some((value) => !Number.isFinite(value))) {
      throw new AppError(
        "CHART_ORDER_REQUIRED",
        `sort="numeric" was requested on ${role}, but some labels are not numbers: ` +
          `${seen.filter((item) => !Number.isFinite(Number(item))).slice(0, 8).join(", ")}`,
        { role, values: available },
      );
    }
    const pairs = seen.map((item, index) => ({ item, value: numeric[index]! }));
    pairs.sort((a, b) => a.value - b.value);
    return { labels: pairs.map((pair) => pair.item), warnings };
  }
  if (axis.sort === "label") return { labels: [...seen].sort(), warnings };
  if (requireExplicit && seen.length > 1) {
    throw new AppError(
      "CHART_ORDER_REQUIRED",
      `Axis ${role} needs an explicit order. Provide order (for example ["周一", …]) or sort (numeric|label). ` +
        `Values present: ${available.join(", ")}`,
      { role, values: available, total: seen.length },
    );
  }
  // Default: keep the SQL row order. Never sort strings implicitly.
  return { labels: seen, warnings };
}

function projectData(
  columns: ColumnMeta[],
  rows: unknown[][],
  used: Array<{ index: number; role: ArtifactColumn["role"] }>,
  rowKey: string[],
): ArtifactData {
  const seen = new Map<number, ArtifactColumn>();
  for (const column of used) {
    if (seen.has(column.index)) continue;
    const meta = columns[column.index] ?? { name: `col_${column.index}`, type: "unknown" };
    seen.set(column.index, { name: meta.name, type: meta.type, role: column.role });
  }
  const indexes = [...seen.keys()];
  return {
    columns: [...seen.values()],
    row_key: rowKey,
    rows: rows.map((row) => indexes.map((index) => row[index] ?? null)),
  };
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}


export function compileChart(input: ChartCompileInput): CompiledArtifact {
  const { spec, columns, rows, source, limits, artifact_id: artifactId } = input;

  if (!CHART_TYPES.includes(spec.type)) {
    throw new AppError(
      "CHART_TYPE_UNSUPPORTED",
      `Chart type "${String(spec.type)}" is not supported. Use one of: ${CHART_TYPES.join(", ")}.`,
      { supported: CHART_TYPES },
    );
  }
  if (source.truncated !== "none") {
    throw new AppError(
      "CHART_RESULT_TRUNCATED",
      `Result ${source.result_id} was truncated (${source.truncated}) at ${source.row_count} rows, so any chart drawn ` +
        "from it would silently understate the data. Aggregate in SQL first (GROUP BY the axes) and chart a result " +
        "that fits the row cap.",
      { result_id: source.result_id, truncated: source.truncated, row_count: source.row_count },
    );
  }
  if (rows.length === 0) {
    throw new AppError("CHART_RESULT_EMPTY", `Result ${source.result_id} has no rows; nothing to draw.`, {
      result_id: source.result_id,
    });
  }
  if (rows.length > limits.maxRows) {
    throw new AppError(
      "CHART_TOO_MANY_ROWS",
      `Result ${source.result_id} has more than ${limits.maxRows} rows. The chart layer must not aggregate: ` +
        "GROUP BY x (and series) in SQL so the result is already the shape of the chart.",
      { result_id: source.result_id, rows: rows.length, limit: limits.maxRows },
    );
  }

  const summaryBase = {
    chart_id: artifactId,
    type: spec.type,
    source,
  } as const;

  if (spec.type === "table") {
    return compileTable(input, summaryBase);
  }
  if (spec.type === "heatmap") {
    return compileHeatmap(input, summaryBase);
  }
  return compileCartesian(input, summaryBase, spec.type);
}

function compileTable(
  input: ChartCompileInput,
  base: { chart_id: string; type: ChartType; source: ChartCompileInput["source"] },
): CompiledArtifact {
  const { spec, columns, rows } = input;
  const used = columns.map((_column, index) => ({ index, role: "column" as const }));
  const data = projectData(columns, rows, used, []);
  const warnings: string[] = [];
  if (data.columns.length > 30) warnings.push(`table shows ${data.columns.length} columns; consider selecting fewer in SQL`);
  const compiled: CompiledChart = {
    compiler_version: COMPILER_VERSION,
    spec_version: SPEC_VERSION,
    engine: "echarts",
    engine_version: ECHARTS_VERSION,
    renderer: "table",
    option: null,
    warnings,
  };
  const text = [
    `chart_id=${base.chart_id} table columns=${data.columns.length} rows=${data.rows.length}`,
    `source ${base.source.result_id} rows=${base.source.row_count} truncated=${base.source.truncated}`,
  ].join("\n");
  return {
    data,
    compiled,
    alternates: [],
    summary: {
      chart_id: base.chart_id,
      type: "table",
      shape: `${data.columns.length}×${data.rows.length}`,
      cells: data.rows.length,
      missing: 0,
      value_min: null,
      value_max: null,
      clip: null,
      top: [],
      text,
    },
    spec_hash: specHash(spec),
  };
}

function compileHeatmap(
  input: ChartCompileInput,
  base: { chart_id: string; type: ChartType; source: ChartCompileInput["source"] },
): CompiledArtifact {
  const { spec, columns, rows, limits } = input;
  if (!spec.x || !spec.y || !spec.value) {
    invalid('heatmap requires x, y and value (each with a "field")');
  }
  if (spec.series) invalid("heatmap does not accept series; use bar or line for multi-series data");

  const xi = resolveField(columns, spec.x.field, "x");
  const yi = resolveField(columns, spec.y.field, "y");
  const vi = resolveField(columns, spec.value.field, "value");

  const seenX = uniqueInOrder(rows.map((row) => label(row[xi])));
  const seenY = uniqueInOrder(rows.map((row) => label(row[yi])));

  const x = resolveAxis(spec.x, seenX, "x", true);
  const y = resolveAxis(spec.y, seenY, "y", true);

  if (x.labels.length * y.labels.length > limits.maxCells) {
    throw new AppError(
      "CHART_TOO_MANY_CELLS",
      `Heatmap would be ${x.labels.length}×${y.labels.length} = ${x.labels.length * y.labels.length} cells, ` +
        `above the ${limits.maxCells} cell limit. Take the top categories (ORDER BY … LIMIT n) or bucket the axis ` +
        "in SQL (for example date_trunc('month', ts)).",
      { x: x.labels.length, y: y.labels.length, limit: limits.maxCells },
    );
  }

  const xIndex = new Map(x.labels.map((item, index) => [item, index]));
  const yIndex = new Map(y.labels.map((item, index) => [item, index]));
  const points = new Map<string, { xi: number; yi: number; value: number; row: unknown[] }>();
  const values: number[] = [];
  const valueSamples = rows.slice(0, 5).map((row) => row[vi]);

  for (const row of rows) {
    const xLabel = label(row[xi]);
    const yLabel = label(row[yi]);
    const key = `${xLabel}\u0000${yLabel}`;
    if (points.has(key)) {
      throw new AppError(
        "CHART_DUPLICATE_CELL",
        `Cell (${spec.x.field}=${xLabel}, ${spec.y.field}=${yLabel}) appears more than once. ` +
          "Aggregate in SQL first: SELECT …, SUM(…) AS value … GROUP BY the two axes.",
        { x: xLabel, y: yLabel, field_x: spec.x.field, field_y: spec.y.field },
      );
    }
    const value = toNumber(row[vi], spec.value.field, valueSamples);
    values.push(value);
    points.set(key, { xi: xIndex.get(xLabel)!, yi: yIndex.get(yLabel)!, value, row });
  }

  const sorted = [...values].sort((a, b) => a - b);
  const valueMin = sorted[0]!;
  const valueMax = sorted[sorted.length - 1]!;
  let clip: ChartSummary["clip"] = null;
  let colorMin = Math.min(0, valueMin);
  let colorMax = valueMax;
  if (spec.color?.clip && spec.color.clip !== "none") {
    const at = percentile(sorted, spec.color.clip === "p95" ? 0.95 : 0.99);
    clip = { kind: spec.color.clip, at };
    colorMax = at;
  }
  const diverging = spec.color?.scale === "diverging";
  if (valueMin < 0 && valueMax > 0) {
    const extent = Math.max(Math.abs(colorMin), Math.abs(colorMax));
    colorMin = -extent;
    colorMax = extent;
  }
  if (colorMax <= colorMin) colorMax = colorMin + 1;

  // Dense grid: one slot per (x, y) so a 60×60 heatmap stays linear instead of quadratic.
  const grid = new Array<number | null>(x.labels.length * y.labels.length).fill(null);
  for (const point of points.values()) {
    grid[point.yi * x.labels.length + point.xi] = point.value;
  }
  const seriesData: Array<[number, number, number]> = [];
  for (let yiRaw = 0; yiRaw < y.labels.length; yiRaw += 1) {
    for (let xiRaw = 0; xiRaw < x.labels.length; xiRaw += 1) {
      const value = grid[yiRaw * x.labels.length + xiRaw];
      if (value !== null && value !== undefined) seriesData.push([xiRaw, yiRaw, value]);
    }
  }

  const top: ChartTop[] = [...points.entries()]
    .map(([, point]) => ({
      ref: cellRef(base.chart_id, [
        [spec.x!.field, label(point.row[xi])],
        [spec.y!.field, label(point.row[yi])],
      ]),
      label: `${spec.y!.field}=${label(point.row[yi])} ${spec.x!.field}=${label(point.row[xi])}`,
      value: point.value,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, 3);

  const missing = x.labels.length * y.labels.length - points.size;
  const warnings = [...x.warnings, ...y.warnings];

  const option: Record<string, unknown> = {
    title: spec.title ? { text: spec.title, left: "center" } : undefined,
    tooltip: { position: "top" },
    grid: { left: 80, right: 32, top: spec.title ? 56 : 32, bottom: 80, containLabel: true },
    xAxis: {
      type: "category",
      data: x.labels,
      name: spec.x.title ?? spec.x.field,
      nameLocation: "middle",
      nameGap: 30,
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: y.labels,
      name: spec.y.title ?? spec.y.field,
      nameLocation: "middle",
      nameGap: 60,
      splitArea: { show: true },
    },
    visualMap: {
      min: colorMin,
      max: colorMax,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 8,
      inRange: { color: diverging ? DIVERGING : SEQUENTIAL },
      text: [formatNumber(colorMax), formatNumber(colorMin)],
    },
    series: [
      {
        type: "heatmap",
        name: spec.value.title ?? spec.value.field,
        data: seriesData,
        label: { show: x.labels.length * y.labels.length <= 400 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.4)" } },
        itemStyle: { borderColor: "#ffffff", borderWidth: 1 },
      },
    ],
  };
  stripUndefined(option);

  const compiled: CompiledChart = {
    compiler_version: COMPILER_VERSION,
    spec_version: SPEC_VERSION,
    engine: "echarts",
    engine_version: ECHARTS_VERSION,
    renderer: "echarts",
    option,
    warnings,
  };

  const data = projectData(
    columns,
    rows,
    [
      { index: xi, role: "x" },
      { index: yi, role: "y" },
      { index: vi, role: "value" },
    ],
    [spec.x.field, spec.y.field],
  );

  const text = [
    `chart_id=${base.chart_id} heatmap ${x.labels.length}×${y.labels.length} cells=${points.size} missing=${missing}`,
    `value ${formatNumber(valueMin)}–${formatNumber(valueMax)}` +
      (clip ? ` (colour clipped at ${clip.kind}=${formatNumber(clip.at)})` : ""),
    top.length > 0
      ? `top: ${top.map((item) => `ref=${item.ref} value=${formatNumber(item.value)}`).join("; ")}`
      : "top: none",
    `source ${base.source.result_id} rows=${base.source.row_count} truncated=${base.source.truncated}`,
  ].join("\n");

  return {
    data,
    compiled,
    alternates: [],
    summary: {
      chart_id: base.chart_id,
      type: "heatmap",
      shape: `${x.labels.length}×${y.labels.length}`,
      cells: points.size,
      missing,
      value_min: valueMin,
      value_max: valueMax,
      clip,
      top,
      text,
    },
    spec_hash: specHash(spec),
  };
}

function compileCartesian(
  input: ChartCompileInput,
  base: { chart_id: string; type: ChartType; source: ChartCompileInput["source"] },
  type: "bar" | "line",
): CompiledArtifact {
  const { spec, columns, rows, limits } = input;
  if (!spec.x || !spec.value) invalid(`${type} requires x and value (each with a "field")`);
  if (spec.y) invalid(`${type} takes a single category axis; use type="heatmap" for a two-dimensional grid`);

  const xi = resolveField(columns, spec.x.field, "x");
  const vi = resolveField(columns, spec.value.field, "value");
  const si = spec.series ? resolveField(columns, spec.series.field, "series") : undefined;

  const seenX = uniqueInOrder(rows.map((row) => label(row[xi])));
  const x = resolveAxis(spec.x, seenX, "x", false);
  const seriesNames = si === undefined ? ["value"] : uniqueInOrder(rows.map((row) => label(row[si])));

  const points = x.labels.length * seriesNames.length;
  if (points > limits.maxCells) {
    throw new AppError(
      "CHART_TOO_MANY_CELLS",
      `${type} would have ${x.labels.length} categories × ${seriesNames.length} series = ${points} points, ` +
        `above the ${limits.maxCells} limit. Take the top categories in SQL or bucket the axis.`,
      { categories: x.labels.length, series: seriesNames.length, limit: limits.maxCells },
    );
  }

  const xIndex = new Map(x.labels.map((item, index) => [item, index]));
  const seriesIndex = new Map(seriesNames.map((item, index) => [item, index]));
  const matrix = new Map<string, { value: number; row: unknown[]; series: string }>();
  const values: number[] = [];
  const valueSamples = rows.slice(0, 5).map((row) => row[vi]);

  for (const row of rows) {
    const xLabel = label(row[xi]);
    const seriesLabel = si === undefined ? "value" : label(row[si]);
    const key = `${xLabel}\u0000${seriesLabel}`;
    if (matrix.has(key)) {
      throw new AppError(
        "CHART_DUPLICATE_CELL",
        `Point (${spec.x.field}=${xLabel}${si === undefined ? "" : `, ${spec.series!.field}=${seriesLabel}`}) appears more than once. ` +
          "Aggregate in SQL first (one row per category/series) or add a series field.",
        { x: xLabel, series: si === undefined ? null : seriesLabel },
      );
    }
    const value = toNumber(row[vi], spec.value.field, valueSamples);
    values.push(value);
    matrix.set(key, { value, row, series: seriesLabel });
  }

  const sorted = [...values].sort((a, b) => a - b);
  const valueMin = sorted[0]!;
  const valueMax = sorted[sorted.length - 1]!;

  const buildOption = (chartType: "bar" | "line"): Record<string, unknown> => {
    const series = seriesNames.map((name) => ({
      name,
      type: chartType,
      data: x.labels.map((xLabel) => matrix.get(`${xLabel}\u0000${name}`)?.value ?? null),
      ...(chartType === "line" ? { connectNulls: false, showSymbol: x.labels.length <= 60 } : {}),
      ...(seriesNames.length > 1 ? { stack: chartType === "bar" ? "total" : undefined } : {}),
    }));
    const option: Record<string, unknown> = {
      title: spec.title ? { text: spec.title, left: "center" } : undefined,
      tooltip: { trigger: "axis" },
      legend: seriesNames.length > 1 ? { bottom: 0 } : undefined,
      grid: {
        left: 64,
        right: 32,
        top: spec.title ? 56 : 24,
        bottom: seriesNames.length > 1 ? 64 : 32,
        containLabel: true,
      },
      xAxis: { type: "category", data: x.labels, name: spec.x!.title ?? spec.x!.field, nameLocation: "middle", nameGap: 30 },
      yAxis: { type: "value", name: spec.value!.title ?? spec.value!.field },
      series,
    };
    stripUndefined(option);
    return option;
  };

  const warnings = [...x.warnings];
  const missing = points - matrix.size;

  const top: ChartTop[] = [...matrix.entries()]
    .map(([, point]) => ({
      ref: cellRef(
        base.chart_id,
        si === undefined
          ? [[spec.x!.field, label(point.row[xi])]]
          : [
              [spec.x!.field, label(point.row[xi])],
              [spec.series!.field, point.series],
            ],
      ),
      label:
        si === undefined
          ? `${spec.x!.field}=${label(point.row[xi])}`
          : `${spec.series!.field}=${point.series} ${spec.x!.field}=${label(point.row[xi])}`,
      value: point.value,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, 3);

  const compiled: CompiledChart = {
    compiler_version: COMPILER_VERSION,
    spec_version: SPEC_VERSION,
    engine: "echarts",
    engine_version: ECHARTS_VERSION,
    renderer: "echarts",
    option: buildOption(type),
    warnings,
  };
  const alternateType: "bar" | "line" = type === "bar" ? "line" : "bar";
  const alternates: NonNullable<Artifact["alternates"]> = [
    { type: alternateType, option: buildOption(alternateType) },
  ];

  const used: Array<{ index: number; role: ArtifactColumn["role"] }> = [
    { index: xi, role: "x" },
    { index: vi, role: "value" },
  ];
  if (si !== undefined) used.push({ index: si, role: "series" });
  const data = projectData(
    columns,
    rows,
    used,
    si === undefined ? [spec.x.field] : [spec.x.field, spec.series!.field],
  );

  const text = [
    `chart_id=${base.chart_id} ${type} ${x.labels.length}×${seriesNames.length} points=${matrix.size} missing=${missing}`,
    `value ${formatNumber(valueMin)}–${formatNumber(valueMax)}`,
    top.length > 0
      ? `top: ${top.map((item) => `ref=${item.ref} value=${formatNumber(item.value)}`).join("; ")}`
      : "top: none",
    `source ${base.source.result_id} rows=${base.source.row_count} truncated=${base.source.truncated}`,
  ].join("\n");

  return {
    data,
    compiled,
    alternates,
    summary: {
      chart_id: base.chart_id,
      type,
      shape: `${x.labels.length}×${seriesNames.length}`,
      cells: matrix.size,
      missing,
      value_min: valueMin,
      value_max: valueMax,
      clip: null,
      top,
      text,
    },
    spec_hash: specHash(spec),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/** ECharts treats `undefined` as "unset"; JSON drops it, which keeps snapshots byte-stable. */
function stripUndefined(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) delete (value as Record<string, unknown>)[key];
    else stripUndefined(item);
  }
}
