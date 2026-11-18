import type { ChartCompileInput, ArtifactData, ChartTop } from "./types.js";
import type { CompiledArtifact } from "./charts.js";
import { cellRef, rowRef } from "./refs.js";
import { AppError } from "../errors.js";

/** Already validated row counts and completeness; no aggregation or silent data reduction. */
export function compileSpecialChart(
  input: ChartCompileInput,
  helpers: {
    number(v: unknown, field: string, samples: unknown[]): number;
    hash(spec: ChartCompileInput["spec"]): string;
    compiler: string;
    version: number;
    echarts: string;
  },
): CompiledArtifact {
  const { spec, rows, columns, artifact_id: id, source, limits } = input;
  const fail = (message: string): never => {
    throw new AppError("CHART_SPEC_INVALID", message);
  };
  const index = (name: string | undefined) => {
    const matches = columns.map((c, i) => (c.name === name ? i : -1)).filter((i) => i >= 0);
    if (matches.length !== 1) fail(`Field ${name ?? "(missing)"} must identify one column`);
    return matches[0]!;
  };
  const vi = index(spec.value?.field);
  const xi = spec.type === "kpi" ? undefined : index(spec.x?.field);
  const yi = spec.type === "scatter" ? index(spec.y?.field ?? spec.value?.field) : undefined;
  if (spec.series) fail("These chart types do not support series; shape the data explicitly first");
  if (rows.length > limits.maxCells) fail("Too many points; reduce in SQL or result_transform");
  const values = rows.map((r) => helpers.number(r[vi], spec.value!.field, []));
  let option: Record<string, unknown>;
  const used = [...new Set([xi, yi, vi].filter((n): n is number => n !== undefined))];
  const data: ArtifactData = {
    columns: used.map((i) => ({
      ...columns[i]!,
      role: i === vi ? "value" : i === xi ? "x" : "y",
    })),
    rows: rows.map((r) => used.map((i) => r[i])),
    row_key:
      spec.type === "kpi"
        ? []
        : spec.type === "scatter"
          ? [spec.x!.field, spec.y?.field ?? spec.value!.field]
          : [spec.x!.field],
  };
  const top: ChartTop[] = [];
  if (spec.type === "kpi") {
    if (rows.length !== 1) fail("KPI needs exactly one row; aggregate explicitly in SQL first");
    const precise = rows[0]![vi];
    option = {
      graphic: [
        {
          type: "text",
          left: "center",
          top: "middle",
          style: {
            text: String(precise) + (spec.unit ? " " + spec.unit : ""),
            fontSize: 36,
            fontWeight: 600,
            fill: "#31414b",
          },
        },
      ],
      title: { text: spec.title ?? spec.value!.field, left: "center" },
    };
    top.push({
      ref: rowRef(id, 0),
      label: spec.value!.field,
      value: values[0]!,
    });
  } else if (spec.type === "scatter") {
    if (!spec.y) fail("Scatter requires x and y numeric columns and a numeric value column (may equal y)");
    const points = rows.map((r) => [
      helpers.number(r[xi!], spec.x!.field, []),
      helpers.number(r[yi!], spec.y!.field, []),
    ]);
    const keys = new Set(points.map((p) => JSON.stringify(p)));
    if (keys.size !== points.length)
      fail("Scatter coordinate keys must be unique for stable refs; aggregate duplicates or choose a different shape");
    option = {
      title: { text: spec.title ?? "", left: "center" },
      grid: { containLabel: true, left: 48, right: 24, top: 50, bottom: 40 },
      tooltip: { trigger: "item" },
      xAxis: { type: "value", name: spec.x!.title ?? spec.x!.field },
      yAxis: { type: "value", name: spec.y!.title ?? spec.y!.field },
      series: [{ type: "scatter", symbolSize: 8, data: points }],
    };
  } else {
    if (values.some((v) => v < 0) || values.every((v) => v === 0))
      fail("Pie/donut requires non-negative values and a positive total");
    if (rows.length > 20) fail("Pie/donut has at most 20 categories. Use explicit TopN + Other SQL/transform first");
    const labels = rows.map((r) => String(r[xi!] ?? "NULL"));
    if (new Set(labels).size !== labels.length)
      throw new AppError("CHART_DUPLICATE_CELL", "Pie categories repeat; aggregate explicitly before charting");
    const points = rows.map((r, i) => ({
      name: labels[i]!,
      value: values[i]!,
    }));
    if (spec.value_sort) points.sort((a, b) => (a.value - b.value) * (spec.value_sort === "asc" ? 1 : -1));
    option = {
      title: { text: spec.title ?? "", left: "center" },
      tooltip: { trigger: "item" },
      legend: { bottom: 0, type: "scroll" },
      series: [
        {
          type: "pie",
          radius: spec.type === "donut" ? ["42%", "68%"] : "68%",
          data: points,
        },
      ],
    };
    for (const p of points
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, 3))
      top.push({
        ref: cellRef(id, [[spec.x!.field, p.name]]),
        label: p.name,
        value: p.value,
      });
  }
  return {
    data,
    compiled: {
      compiler_version: helpers.compiler,
      spec_version: helpers.version,
      engine: "echarts",
      engine_version: helpers.echarts,
      renderer: "echarts",
      option,
      warnings: ["Plot coordinates may be rounded; immutable snapshot keeps original numeric strings."],
    },
    alternates: [],
    spec_hash: helpers.hash(spec),
    summary: {
      chart_id: id,
      type: spec.type,
      shape: `${rows.length}`,
      cells: rows.length,
      missing: 0,
      value_min: Math.min(...values),
      value_max: Math.max(...values),
      clip: null,
      top,
      text: `chart_id=${id} type=${spec.type} points=${rows.length}\nsource=${source.result_id}\n${top.map((t) => `ref=${t.ref} value=${t.value}`).join("\n")}`,
    },
  };
}
