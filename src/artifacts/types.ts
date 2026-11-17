import type { ColumnMeta } from "../db/engines/base.js";

/**
 * Chart artifacts: an immutable record of "what was drawn" plus the small aggregated dataset it was
 * drawn from. Everything else (PNG, SVG, CSV, dashboards, reports) is a rendering of this record,
 * which is why the record keeps the *long-format* rows instead of a finished chart option: the same
 * rows can be re-read as a bar, a line or a heatmap, and any number in a later report can be
 * addressed by a stable ref instead of being copied as text.
 */

/** Bump when the stored spec shape changes; artifacts keep the version they were written with. */
export const SPEC_VERSION = 1;
/** Bump when the compiler output changes, so old artifacts keep rendering as they did. */
export const COMPILER_VERSION = "chartc-1";
/** Version of the ECharts option dialect the compiled snapshots were produced for. */
export const ECHARTS_VERSION = "5.5.1";

export type ChartType = "bar" | "line" | "heatmap" | "table";
export const CHART_TYPES: readonly ChartType[] = ["bar", "line", "heatmap", "table"];

export type ValueFormat = "integer" | "decimal" | "percent" | "compact";

export interface AxisSpec {
  field: string;
  /**
   * How labels are ordered when `order` is absent. There is deliberately no "string" default:
   * sorting "10" next to "2" is the classic broken category axis, so the caller states numeric or
   * label explicitly, or accepts the SQL row order.
   */
  sort?: "numeric" | "label";
  /** Explicit category universe, e.g. the seven weekdays. Defines the axis even for empty cells. */
  order?: Array<string | number>;
  title?: string;
}

export interface ValueSpec {
  field: string;
  title?: string;
  format?: ValueFormat;
}

export interface SeriesSpec {
  field: string;
}

export interface ColorSpec {
  scale?: "sequential" | "diverging";
  /** Clip the colour ramp so one outlier does not flatten every other cell into one shade. */
  clip?: "none" | "p95" | "p99";
}

export interface ChartSpec {
  result_id: string;
  type: ChartType;
  title?: string;
  /** Category axis (bar/line) or the first heatmap axis. */
  x?: AxisSpec;
  /** Second heatmap axis. */
  y?: AxisSpec;
  /** Multi-series field for bar/line: one SQL column, not a pivot by the caller. */
  series?: SeriesSpec;
  value?: ValueSpec;
  color?: ColorSpec;
}

export type ColumnRole = "x" | "y" | "value" | "series" | "column";

export interface ArtifactColumn extends ColumnMeta {
  role: ColumnRole;
}

/**
 * Long-format snapshot of the rows the chart was built from, restricted to the columns that the
 * spec uses. `row_key` names the columns that address a single point; it is what refs resolve
 * against.
 */
export interface ArtifactData {
  columns: ArtifactColumn[];
  row_key: string[];
  rows: unknown[][];
}

export interface ArtifactSource {
  result_id: string;
  sql: string;
  session_id: string;
  task_id?: string;
  executed_at: string;
  row_count: number;
  truncated: "none" | "rows" | "bytes";
}

export interface CompiledChart {
  compiler_version: string;
  spec_version: number;
  engine: "echarts";
  engine_version: string;
  /** `table` artifacts are rendered from the snapshot by the client, not by ECharts. */
  renderer: "echarts" | "table";
  option: Record<string, unknown> | null;
  warnings: string[];
}

export interface ChartTop {
  /** Stable address of this number inside the artifact, for reports and drill-down. */
  ref: string;
  label: string;
  value: number;
}

export interface ChartSummary {
  chart_id: string;
  type: ChartType;
  /** e.g. "7×24" for a heatmap grid, "24×2" for categories × series. */
  shape: string;
  cells: number;
  missing: number;
  value_min: number | null;
  value_max: number | null;
  clip: { kind: "p95" | "p99"; at: number } | null;
  top: ChartTop[];
  /** Deterministic one-liner handed back to the model. Numbers appear with their refs. */
  text: string;
}

export interface Artifact {
  id: string;
  session_id: string;
  task_id?: string;
  kind: "chart";
  status: "ready" | "failed";
  spec: ChartSpec;
  spec_version: number;
  spec_hash: string;
  data?: ArtifactData;
  compiled?: CompiledChart;
  /**
   * The same data compiled as the other chart types that share its field roles, so the console can
   * switch bar↔line without another round trip and without invoking the model.
   */
  alternates?: Array<{ type: ChartType; option: Record<string, unknown> | null }>;
  summary?: ChartSummary;
  source: ArtifactSource;
  created_at: string;
  error?: string;
}

export interface ChartCompileLimits {
  maxCells: number;
  maxRows: number;
}

export interface ChartCompileInput {
  artifact_id: string;
  spec: ChartSpec;
  columns: ColumnMeta[];
  rows: unknown[][];
  source: ArtifactSource;
  limits: ChartCompileLimits;
}
