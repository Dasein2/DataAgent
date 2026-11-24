import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BudgetConfig } from "../config.js";
import type { SessionCapabilities } from "../db/types.js";
import type { ArtifactService } from "../artifacts/service.js";
import type { ChartSpec } from "../artifacts/types.js";
import { AppError, isAppError } from "../errors.js";
import type { ColumnMeta } from "../db/engines/base.js";
import { cellText } from "../db/engines/base.js";
import type { DbSession } from "../db/session.js";
import { analysisTools, recoveryHint } from "./analysis-tools.js";

const TOOL_TEXT_BUDGET = 12_000;

export const SOURCE_TOOLS = new Set(["query_execute", "query_explain", "catalog_overview", "catalog_search", "object_describe", "data_profile", "business_lookup", "dataset_create", "dataset_list", "dataset_drop", "business_analyze"]);

export interface ToolRuntime {
  db: DbSession;
  budgets: BudgetConfig;
  /** Chart artifacts are stored and compiled by the service, never by the model. */
  artifacts: ArtifactService;
  currentTaskId(): string | undefined;
  taskStatus(): Record<string, unknown>;
  cancelActive(): Promise<boolean>;
  sourceBlocked?(): boolean;
  business?: import("../business/service.js").BusinessAnalysis;
}

function textOutput(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: structured ?? {},
    structuredContent: structured as never,
  };
}

function errorOutput(error: unknown) {
  if (isAppError(error)) {
    return {
      content: [{ type: "text" as const, text: `Error ${error.code}: ${error.message}\nHint: ${recoveryHint(error)}\n${JSON.stringify(error.details ?? {})}` }],
      details: { code: error.code, hint: recoveryHint(error), ...error.details },
      structuredContent: { code: error.code, message: error.message, hint: recoveryHint(error), details: error.details } as never,
      isError: true,
    };
  }
  const message = (error as Error).message ?? String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { code: "INTERNAL_ERROR" },
    structuredContent: { code: "INTERNAL_ERROR", message } as never,
    isError: true,
  };
}

function clampText(value: string, max = TOOL_TEXT_BUDGET): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${value.slice(0, head)}\n… [${value.length - head - tail} characters omitted] …\n${value.slice(-tail)}`;
}

export function normalizeChartSpec(spec: ChartSpec): ChartSpec {
  const seriesField = spec.series?.field?.trim();
  return {
    ...spec,
    y: spec.y?.field?.trim() ? spec.y : undefined,
    series: seriesField && seriesField !== spec.x?.field ? spec.series : undefined,
  };
}

function renderTable(columns: ColumnMeta[], rows: unknown[][], cellChars: number): string {
  if (columns.length === 0) return "(no columns)";
  const header = columns.map((column) => column.name).join("\t");
  const types = columns.map((column) => column.type).join("\t");
  const body = rows
    .map((row) => row.map((cell) => cellText(cell, cellChars).replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n")).join("\t"))
    .join("\n");
  return `types:\t${types}\n${header}\n${body}`;
}

function qualifiedName(runtime: ToolRuntime, name: string): string {
  const workspace = runtime.db.capabilitiesView.workspaceName;
  const { quote } = runtime.db.engineProfile;
  return workspace ? `${quote}${workspace}${quote}.${quote}${name}${quote}` : name;
}

export function createDatabaseTools(runtime: ToolRuntime): ToolDefinition[] {
  const { db, budgets } = runtime;
  const cellChars = budgets.cellChars;

  const queryExecute = defineTool({
    name: "query_execute",
    label: "Execute read-only SQL",
    description:
      "Execute one read-only SQL statement and return a preview plus a result handle. " +
      "SQL is validated before execution: only SELECT/WITH/SHOW/DESCRIBE are accepted, and source writes are rejected. " +
      "Use result_read to inspect the rows saved within the storage cap.",
    promptSnippet: "Run one read-only SQL statement and get a result_id for paging",
    promptGuidelines: [
      "Send exactly one statement per call; multiple statements are rejected.",
      "Add a LIMIT to exploratory queries over large tables.",
      "result_read pages stored rows only. A truncated result is incomplete; rerun a reduced or aggregated source query.",
      "LIMIT bounds returned rows, not scan cost. Prefer selective date/partition filters.",
    ],
    parameters: Type.Object({
      sql: Type.String({ description: "One read-only SQL statement" }),
      label: Type.Optional(Type.String({ description: "Short label for the result, e.g. 'monthly revenue'" })),
      max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Stored row cap; does not limit source scan cost" })),
      dry_run: Type.Optional(Type.Boolean({ description: "Return cost estimates without executing SELECT. Preflight consumes a query budget slot." })),
      reuse: Type.Optional(Type.Boolean({ description: "Opt in to recent exact-SQL session result reuse; reports original execution time and age. Off by default." })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params, signal) => {
      try {
        if (params.dry_run) { const inspection = await db.preflight(params.sql, signal); return textOutput(JSON.stringify(inspection), inspection); }
        const meta = await db.query(params.sql, {
          label: params.label,
          taskId: runtime.currentTaskId(),
          maxRows: params.max_rows,
          signal,
          reuse: params.reuse,
        });
        const preview = renderTable(meta.columns, meta.preview.slice(0, 5), cellChars);
        const text = [
          `result_id=${meta.id}`,
          `stored_rows=${meta.rowCount} truncated=${meta.truncated} duration_ms=${meta.durationMs} bytes=${meta.bytes}`,
          meta.truncated !== "none"
            ? `INCOMPLETE: stored result capped (${meta.truncated}). result_read cannot recover unstored rows; rerun a reduced/aggregated query.`
            : "",
          `executed_at=${meta.createdAt} timezone=${meta.timezone ?? "unspecified"} cached=${Boolean(meta.cached)} cache_age_ms=${meta.cacheAgeMs ?? 0}`,
          ...(meta.warnings ?? []),
          "Query completion time is not source-data freshness or a cross-query snapshot.",
          "",
          preview,
        ]
          .filter(Boolean)
          .join("\n");
        return textOutput(clampText(text), {
          result_id: meta.id,
          row_count: meta.rowCount,
          truncated: meta.truncated,
          columns: meta.columns,
          next_offset: meta.rowCount > Math.min(meta.preview.length, 5) ? Math.min(meta.preview.length, 5) : null,
          warnings: meta.warnings, cached: Boolean(meta.cached), executed_at: meta.createdAt, cache_age_ms: meta.cacheAgeMs ?? 0,
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const resultRead = defineTool({
    name: "result_read",
    label: "Read stored result rows",
    description:
      "Inspect stored result rows without querying the source. Use mode=rows to page/project exact rows, " +
      "or mode=summary for bounded statistics (null counts, capped distinct counts, candidate frequencies and approximate numeric ranges). " +
      "These statistics describe saved rows only, not the source table.",
    promptSnippet: "Inspect exact rows or summary statistics for a stored result_id",
    promptGuidelines: ["Use mode=summary for statistics or result_transform for custom aggregations; do not page through all rows to compute in context."],
    parameters: Type.Object({
      result_id: Type.String({ description: "Handle of a saved result, such as the result_id returned by query_execute or result_transform" }),
      columns: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
      mode: Type.Optional(Type.Union([Type.Literal("rows"), Type.Literal("summary")], { description: "rows (default) pages/projects rows. summary describes all stored rows, ignoring paging and projection parameters." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Row offset, default 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: "Rows to return, default 50" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        if (params.mode === "summary") { const summary = await db.resultSummary(params.result_id); return textOutput(clampText(JSON.stringify(summary)), summary); }
        const page = await db.readResult(params.result_id, params.offset ?? 0, params.limit ?? 50);
        if (params.columns) {
          const indexes = params.columns.map(name => { const matches = page.columns.map((c, i) => c.name === name ? i : -1).filter(i => i >= 0); if (matches.length !== 1) throw new AppError("INVALID_INPUT", `Column ${name} is missing or ambiguous`); return matches[0]!; });
          page.columns = indexes.map(i => page.columns[i]!); page.rows = page.rows.map(row => indexes.map(i => row[i]));
        }
        const text = [
          `result_id=${page.id} rows=${page.rows.length} offset=${page.offset} stored_rows=${page.rowCount} truncated=${page.truncated} next_offset=${page.nextOffset ?? "null"}`,
          "",
          renderTable(page.columns, page.rows, cellChars),
        ].join("\n");
        return textOutput(clampText(text), {
          result_id: page.id,
          offset: page.offset,
          next_offset: page.nextOffset,
          row_count: page.rowCount,
          truncated: page.truncated,
          columns: page.columns,
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const sessionInfo = defineTool({
    name: "session_info",
    label: "Describe analysis session",
    description:
      "Return the session's engine, environment, read-only/workspace capabilities, available schemas, dataset count and remaining query budget.",
    promptSnippet: "Show engine, capabilities, schemas and budget for this session",
    parameters: Type.Object({}),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async () => {
      try {
        const snapshot = db.snapshot();
        const capabilities = snapshot.capabilities;
        const text = [
          `session_id=${snapshot.session_id}`,
          `engine=${snapshot.engine} (${capabilities.engineLabel}) environment=${snapshot.environment} database=${snapshot.database}`,
          `server_version=${capabilities.serverVersion || "unknown"}`,
          ...(capabilities.queryTimeout ? [`query_timeout=${JSON.stringify(capabilities.queryTimeout)}`] : []),
          `source_access=${capabilities.sourceAccess} read_only_proof=${capabilities.readOnlyProof}`,
          `timezone=${capabilities.timezone ?? "unspecified"} ${capabilities.timezoneNote ?? ""}`,
          `features=${Object.entries(capabilities.features)
            .map(([name, enabled]) => `${name}:${enabled ? "yes" : "no"}`)
            .join(" ")}`,
          `workspace=${capabilities.workspaceName ?? "none"} access=${capabilities.workspaceAccess}${capabilities.workspaceNote ? ` (${capabilities.workspaceNote})` : ""}`,
          `datasets=${snapshot.datasets}`,
          `queries_used=${snapshot.queries.used} queries_limit=${snapshot.queries.limit}`,
          `schemas=${db.scopesView.slice(0, 40).join(", ")}`,
          ...(capabilities.notes.length > 0 ? [`notes=${capabilities.notes.join(" | ")}`] : []),
        ].join("\n");
        return textOutput(text, {
          session_id: snapshot.session_id,
          engine: snapshot.engine,
          query_timeout: capabilities.queryTimeout,
          environment: snapshot.environment,
          capabilities,
          queries: snapshot.queries,
          schemas: db.scopesView,
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const catalogSearch = defineTool({
    name: "catalog_search",
    label: "Search catalog",
    description:
      "Search tables/views by name, schema or comments, optionally matching column names/comments. Returns candidate objects, not content matches. Use object_describe to inspect columns.",
    promptSnippet: "Find tables/views by name or schema",
    promptGuidelines: [
      "Start with broad search terms (e.g. 'order', 'customer'); refine with schema when names collide.",
      "Estimated row counts may be stale; they are not exact counts.",
    ],
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Substring to match against object or schema name" })),
      schema: Type.Optional(Type.String({ description: "Restrict to this schema/database" })),
      search_columns: Type.Optional(Type.Boolean()),
      refresh: Type.Optional(Type.Boolean({ description: "Bypass metadata TTL cache" })),
      kinds: Type.Optional(
        Type.Array(Type.Union([Type.Literal("table"), Type.Literal("view"), Type.Literal("materialized_view"), Type.Literal("foreign_table"), Type.Literal("sequence")]), {
          description: "Restrict by relation kind",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const objects = await db.catalogSearch({
          search: params.search,
          searchColumns: params.search_columns,
          refresh: params.refresh,
          schema: params.schema,
          kinds: params.kinds as never,
          limit: params.limit ?? 100,
        });
        const lines = objects.map(
          (object) =>
            `${object.schema}.${object.name} [${object.kind}]${object.rowEstimate !== null && object.rowEstimate !== undefined ? ` ~${object.rowEstimate} rows` : ""}${object.comment ? ` — ${object.comment}` : ""}${(object.rowEstimate ?? 0) > 1_000_000 ? " [LARGE: use selective filters; LIMIT does not cap scans]" : ""}${object.matchedColumns?.length ? " columns=" + object.matchedColumns.map(c => c.name + ":" + c.type + (c.comment ? "(" + c.comment + ")" : "")).join(", ") : ""}`,
        );
        return textOutput(clampText(lines.length ? lines.join("\n") : "No matching relations."), { objects });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const objectDescribe = defineTool({
    name: "object_describe",
    label: "Describe tables or views",
    description:
      "Describe 1–20 named relations before writing SQL: column types, nullability, defaults, keys and indexes. Each relation may return its own error.",
    promptSnippet: "Inspect columns, keys and indexes of known tables or views",
    promptGuidelines: ["Use a one-item objects array for a single table. Qualify the schema/database if needed."],
    parameters: Type.Object({
      objects: Type.Array(Type.Object({
        name: Type.String({ description: "Relation name" }),
        schema: Type.Optional(Type.String({ description: "Schema (PostgreSQL) or database (MySQL)" })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20, description: "Named relations with optional schema; use one array item for a single relation" }),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      const objects = await db.describeMany(params.objects);
      const sections = objects.map((item) => {
        if ("error" in item) {
          return `${item.schema ? `${item.schema}.` : ""}${item.name}: ${item.error}`;
        }
        const described = item.description;
        const { object, columns, primaryKey, partitionKey, indexes, foreignKeys } = described;
        const lines = [
          `${object.schema}.${object.name} (${object.kind})${object.rowEstimate != null ? ` ~${object.rowEstimate} rows` : ""}${object.comment ? ` — ${object.comment}` : ""}`,
          `primary_key: ${primaryKey.join(", ") || "(none)"}`,
          `partition_key: ${partitionKey ?? "unknown/not partitioned"}`,
          ...(object.rowEstimate != null && object.rowEstimate > 1_000_000 ? ["LARGE TABLE: use selective date/partition filters; LIMIT does not bound aggregate scan cost."] : []),
          "columns:",
          ...columns.map((column) =>
            `- ${column.name} ${column.type}${column.nullable ? "" : " NOT NULL"}${column.default != null ? ` DEFAULT ${column.default}` : ""}${column.comment ? ` — ${column.comment}` : ""}`),
          ...indexes.map((index) => `index: ${index.name}${index.unique ? " UNIQUE" : ""} (${index.columns.join(", ")})`),
          ...foreignKeys.map((fk) => `foreign_key: ${fk.name} (${fk.columns.join(", ")}) -> ${fk.references}${fk.referencedColumns?.length ? ` (${fk.referencedColumns.join(", ")})` : ""}`),
        ];
        return lines.join("\n");
      });
      return textOutput(clampText(sections.join("\n\n")), { objects });
    },
  });

  const dataProfile = defineTool({
    name: "data_profile",
    label: "Profile data",
    description:
      "Sample a relation and summarise each column: null count, distinct count, numeric min/max, and a few sample values. Sampling is bounded; null/distinct figures describe the sample, not the full table.",
    promptSnippet: "Sample a table and summarise nulls, distinct values and ranges",
    promptGuidelines: ["Increase sample_rows when a column's distribution matters; the cap is 200."],
    parameters: Type.Object({
      name: Type.String({ description: "Relation name" }),
      schema: Type.Optional(Type.String({ description: "Schema or database" })),
      sample_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Rows to sample, default 50" })),
      sampling: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("random")], { description: "head is cheap but biased; random can scan/sort the full table and is disabled in production" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const profile = await db.profile(params.schema ?? null, params.name, params.sample_rows ?? 50, undefined, params.sampling);
        const lines = [
          `${profile.object.schema}.${profile.object.name} estimated_rows=${profile.rowCount ?? "unknown"} sampled=${profile.sampled} method=${profile.sampleMethod ?? "head"} sample_rows=${profile.sampleRows ?? "unknown"}`,
          "column\ttype\tnulls\tdistinct\tmin\tmax\tsamples",
          ...profile.columns.map((column) =>
            [
              column.name,
              column.type,
              column.nulls,
              column.distinct ?? "n/a",
              column.min ?? "n/a",
              column.max ?? "n/a",
              column.samples.map((sample) => cellText(sample, 40)).join(" | "),
            ].join("\t"),
          ),
        ];
        if (profile.sampled) lines.push("", "Note: null/distinct counts are based on the sample only.");
        return textOutput(clampText(lines.join("\n")), { profile });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const queryExplain = defineTool({
    name: "query_explain",
    label: "Explain query plan",
    description:
      "Return the database's execution plan for a read-only SQL statement. Use it to check row estimates and scans before running an expensive query. Cost numbers are engine estimates, not measured resource use.",
    promptSnippet: "Inspect the execution plan for a read-only query",
    parameters: Type.Object({
      sql: Type.String({ description: "One SELECT statement; EXPLAIN is added by the service" }),
      analyze: Type.Optional(Type.Boolean({ description: "Explicitly execute PostgreSQL EXPLAIN ANALYZE under read-only timeout; consumes budget and may be expensive" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params, signal) => {
      try {
        const { result, plan } = await db.explain(params.sql, { analyze: params.analyze, signal });
        const text = [
          `result_id=${result.id}`,
          `estimated_cost=${plan.estimatedCost ?? "n/a"} estimated_rows=${plan.estimatedRows ?? "n/a"} scan_rows=${plan.estimatedScanRows ?? "n/a"} analyzed=${Boolean(plan.analyzed)}`,
          plan.warnings.length ? `warnings: ${plan.warnings.join("; ")}` : "",
          "",
          plan.planText,
        ]
          .filter(Boolean)
          .join("\n");
        return textOutput(clampText(text), {
          result_id: result.id,
          estimated_cost: plan.estimatedCost,
          estimated_rows: plan.estimatedRows,
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const datasetCreate = defineTool({
    name: "dataset_create",
    label: "Create analysis dataset",
    description:
      "Persist an intermediate analysis result as a view (or a table on non-production sessions with table access). " +
      "Pass a name and a SELECT statement; the service generates and runs the DDL. " +
      "Production sessions can create views only.",
    promptSnippet: "Save a SELECT as a reusable analysis view/table in the workspace",
    promptGuidelines: [
      "Name datasets ds_<lowercase_snake_case>, e.g. ds_monthly_revenue.",
      "The SELECT must be deterministic enough to be reusable; avoid LIMIT unless intentional.",
      "Reuse the returned qualified name in later SQL.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Dataset name, must start with ds_" }),
      select_sql: Type.String({ description: "SELECT or WITH ... SELECT statement that defines the dataset" }),
      kind: Type.Optional(Type.Union([Type.Literal("view"), Type.Literal("table")], { description: "Default: view" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const record = await db.createDataset(params.name, params.select_sql, params.kind ?? "view");
        const qualified = qualifiedName(runtime, record.name);
        return textOutput(
          `created ${record.kind} ${qualified}\nstatus=${record.status}\nUse ${qualified} in later queries. Drop it with dataset_drop when finished.`,
          { dataset: record, qualified_name: qualified },
        );
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const datasetList = defineTool({
    name: "dataset_list",
    label: "List analysis datasets",
    description: "List datasets in this session's workspace, including their kind, status, whether the object still exists, and the defining SQL.",
    promptSnippet: "List analysis views/tables created in this session",
    parameters: Type.Object({}),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async () => {
      try {
        const datasets = await db.listDatasets();
        if (datasets.length === 0) return textOutput("No datasets in this session.", { datasets: [] });
        const lines = datasets.map(
          (dataset) =>
            `${qualifiedName(runtime, dataset.name)} [${dataset.kind}] status=${dataset.status} exists=${dataset.exists}${dataset.error ? ` error=${dataset.error}` : ""}\n  sql: ${dataset.sql.replace(/\s+/g, " ").slice(0, 300)}`,
        );
        return textOutput(clampText(lines.join("\n")), { datasets });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const datasetDrop = defineTool({
    name: "dataset_drop",
    label: "Drop analysis dataset",
    description: "Drop a dataset created by this service in the session workspace. Source objects can never be dropped.",
    promptSnippet: "Drop an analysis view/table created in this session",
    parameters: Type.Object({
      name: Type.String({ description: "Dataset name (ds_...)" }),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        await db.dropDataset(params.name);
        return textOutput(`dropped ${params.name}`, { dropped: params.name });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const jobGet = defineTool({
    name: "job_get",
    label: "Get job status",
    description:
      "Report the status of the current analysis task and its query budget. P0 executes queries synchronously; there are no detached database jobs.",
    promptSnippet: "Show current task status and query usage",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "Task id; defaults to the current task" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const status = runtime.taskStatus();
        const snapshot = db.snapshot();
        const text = [
          `task_id=${String(status.task_id ?? params.job_id ?? "none")}`,
          `status=${String(status.status ?? "unknown")}`,
          `queries_used=${snapshot.queries.used} queries_limit=${snapshot.queries.limit}`,
          "queries run synchronously; no detached jobs are created in this version",
        ].join("\n");
        return textOutput(text, { ...status, queries: snapshot.queries });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const jobCancel = defineTool({
    name: "job_cancel",
    label: "Cancel running query",
    description:
      "Cancel this session's currently running SQL only when requested by the user. This does not stop the analysis task.",
    promptSnippet: "Cancel the currently running SQL when requested",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "Task id; defaults to the current task" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    execute: async () => {
      try {
        const cancelled = await runtime.cancelActive();
        return textOutput(cancelled ? "cancel requested" : "no running query to cancel", { cancelled });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const axisParams = (role: string, extra: Record<string, unknown> = {}) =>
    Type.Object(
      {
        field: Type.String({ description: `Column name for the ${role} axis` }),
        sort: Type.Optional(
          Type.Union([Type.Literal("numeric"), Type.Literal("label")], {
            description: "How to order the categories. Omit to keep SQL row order.",
          }),
        ),
        order: Type.Optional(
          Type.Array(Type.Union([Type.String(), Type.Number()]), {
            description: "Explicit category order, e.g. [\"周一\",…,\"周日\"]",
            maxItems: 500,
          }),
        ),
        title: Type.Optional(Type.String({ description: "Axis title shown on the chart" })),
        ...extra,
      },
      { additionalProperties: false },
    );

  const chartCreate = defineTool({
    name: "chart_create",
    label: "Create chart artifact",
    description:
      "Turn a result_id into an immutable chart artifact that the console renders. The result must already be " +
      "the shape of the chart (one row per point): this layer never aggregates, never sorts strings implicitly " +
      "and never invents missing points. Types: bar, line, area, pie/donut (x,value), scatter (numeric x,y,value), kpi (one value row), heatmap (x,y,value), table. Value sorting and stack modes must be explicit. Use result_transform for TopN+Other; chart_create never aggregates.",
    promptSnippet: "Chart a result as bar | line | heatmap | table and return the artifact id plus refs",
    promptGuidelines: [
      "Aggregate in SQL first (GROUP BY the axes). Duplicate points are rejected, not summed.",
      "heatmap needs an explicit order or sort; there is no implicit string sort.",
    ],
    parameters: Type.Object(
      {
        result_id: Type.String({ description: "Result id returned by query_execute" }),
        type: Type.Union([
          Type.Literal("bar"),
          Type.Literal("line"),
          Type.Literal("heatmap"),
          Type.Literal("table"), Type.Literal("area"), Type.Literal("pie"), Type.Literal("donut"), Type.Literal("scatter"), Type.Literal("kpi"),
        ]),
        title: Type.Optional(Type.String({ description: "Chart title" })),
        value_sort: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
        unit: Type.Optional(Type.String({ maxLength: 40 })),
        x: Type.Optional(axisParams("x (category)")),
        y: Type.Optional(axisParams("y (category, heatmap only)")),
        series: Type.Optional(
          Type.Object(
            {
              field: Type.String({ description: "Column that splits rows into series (long format, not a pivot)" }),
              stack: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("stacked"), Type.Literal("percent")])),
              title: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        value: Type.Optional(
          Type.Object(
            {
              field: Type.String({ description: "Numeric column plotted as the value" }),
              format: Type.Optional(
                Type.Union([
                  Type.Literal("integer"),
                  Type.Literal("decimal"),
                  Type.Literal("percent"),
                  Type.Literal("compact"),
                ]),
              ),
              title: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        color: Type.Optional(
          Type.Object(
            {
              scale: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("diverging")])),
              clip: Type.Optional(
                Type.Union([Type.Literal("none"), Type.Literal("p95"), Type.Literal("p99")], {
                  description: "Clamp the colour ramp so one outlier does not flatten it",
                }),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    // Writes an artifact file, but is idempotent: the same spec on the same result reuses one artifact.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const spec = normalizeChartSpec({
          result_id: params.result_id,
          type: params.type,
          title: params.title,
          x: params.x,
          y: params.y,
          series: params.series,
          value: params.value,
          color: params.color,
          value_sort: params.value_sort, unit: params.unit,
        });
        const { artifact, reused } = await runtime.artifacts.createChart({
          sessionId: db.id,
          taskId: runtime.currentTaskId(),
          spec,
        });
        const summary = artifact.summary!;
        const warnings = artifact.compiled?.warnings ?? [];
        const text = clampText(
          [
            summary.text,
            reused ? "note: identical spec on the same result; the existing artifact was reused" : "",
            warnings.length > 0 ? `warnings:\n- ${warnings.join("\n- ")}` : "",
            artifact.alternates && artifact.alternates.length > 0
              ? `alternates: ${artifact.alternates.map((item) => item.type).join(", ")} (the console can switch figure type without another tool call)`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return textOutput(text, {
          chart_id: artifact.id,
          type: artifact.spec.type,
          shape: summary.shape,
          cells: summary.cells,
          missing: summary.missing,
          reused,
          refs: summary.top.map((item) => ({ ref: item.ref, value: item.value })),
          warnings,
          alternates: (artifact.alternates ?? []).map((item) => item.type),
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const tools: ToolDefinition[] = [
    ...analysisTools(runtime),
    sessionInfo,
    catalogSearch,
    objectDescribe,
    dataProfile,
    queryExplain,
    queryExecute,
    jobGet,
    jobCancel,
    resultRead,
    chartCreate,
    datasetCreate,
    datasetList,
    datasetDrop,
  ];
  const parallel = new Set(["session_info", "catalog_search", "result_read", "job_get", "job_cancel"]);
  let retryTask: string | undefined, sqlErrors = 0;
  const failedPlans = new Set<string>();
  return tools.map(tool => {
    const execute = tool.execute;
    return { ...tool, executionMode: parallel.has(tool.name) ? "parallel" : tool.executionMode,
      execute: async (...args: Parameters<typeof execute>) => {
        let result;
        const taskId = runtime.currentTaskId();
        if (retryTask !== taskId) { retryTask = taskId; sqlErrors = 0; failedPlans.clear(); }
        const input = args[1] as { sql?: string } | undefined;
        const key = tool.name === "query_execute" && typeof input?.sql === "string" && taskId ? input.sql.trim().replace(/;$/, "").trimEnd() : undefined;
        try {
          if (SOURCE_TOOLS.has(tool.name) && runtime.sourceBlocked?.())
            throw new AppError("SESSION_UNAVAILABLE", "Source tools are paused. Use saved evidence or reconnect.", { source_blocked: true });
          if (key && (failedPlans.has(key) || sqlErrors >= 2))
            throw new AppError("INVALID_INPUT", "Failed exploration cannot be repeated; stop or request clarification", { source_blocked: true });
          result = await execute(...args);
        } catch (error) { result = errorOutput(error); }
        const code = (result.details as { code?: string })?.code;
        if (key && code) {
          failedPlans.add(key);
          if (code === "SQL_DIALECT_ERROR" || code === "SQL_FIELD_ERROR") sqlErrors++;
        }
        let budget: Record<string, unknown> = {};
        try { const snap = db.snapshot(); const task = runtime.taskStatus(); budget = { queries_remaining: Math.max(0, snap.queries.limit - snap.queries.used), turns_remaining: Math.max(0, Number(task.max_turns ?? budgets.maxTurns) - Number(task.turns ?? 0)) }; } catch { /* metadata-only catalog */ }
        const warning = typeof budget.queries_remaining === "number" && budget.queries_remaining <= Math.ceil(budgets.maxQueries * .2) ? "Budget low: converge on findings using stored evidence." : "";
        const content = [...result.content, { type: "text" as const, text: `budget=${JSON.stringify(budget)}${warning ? " " + warning : ""}` }];
        return { ...result, content, details: { ...(result.details as object ?? {}), budget } };
      },
    } as ToolDefinition;
  });
}

/** Filter by session capabilities at creation. Visibility is not authorization; execution checks still apply. */
export function selectTools<T extends { name: string }>(
  tools: readonly T[],
  caps: Pick<SessionCapabilities, "features" | "workspaceName" | "workspaceAccess">,
  businessEnabled = false,
): T[] {
  return tools.filter(({ name }) => {
    if (name.startsWith("business_")) return businessEnabled;
    if (name === "query_explain") return caps.features.explain;
    if (name.startsWith("dataset_")) return Boolean(caps.workspaceName) && caps.workspaceAccess !== "none";
    return true;
  });
}

export interface ToolParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** True when the tool cannot change data or the connection (`readOnlyHint`). */
  readOnly: boolean;
  destructive: boolean;
  /** Serialised against the session connection, so concurrent calls queue up. */
  sequential: boolean;
  parameters: ToolParameterInfo[];
}

/**
 * Every factory closes over its runtime and only touches it inside `execute()`, so an inert stub is
 * enough to describe the complete catalogue without an analysis session.
 */
const METADATA_ONLY_RUNTIME = {
  db: {},
  budgets: {},
  artifacts: {},
  currentTaskId: () => undefined,
  taskStatus: () => ({}),
  cancelActive: async () => false,
} as unknown as ToolRuntime;

function describeParameters(schema: unknown): ToolParameterInfo[] {
  const object = schema as { properties?: Record<string, Record<string, unknown>>; required?: string[] } | undefined;
  const required = new Set(object?.required ?? []);
  return Object.entries(object?.properties ?? {}).map(([name, raw]) => {
    const type = Array.isArray(raw?.type) ? (raw.type as string[]).join(" | ") : String(raw?.type ?? "any");
    const description = typeof raw?.description === "string" ? raw.description : undefined;
    return { name, type, required: required.has(name), description };
  });
}

/** Describe a selected session toolset, or the full service catalogue when no tools are supplied. */
export function toolCatalog(tools: readonly ToolDefinition[] = createDatabaseTools(METADATA_ONLY_RUNTIME)): ToolInfo[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    readOnly: Boolean(tool.annotations?.readOnlyHint),
    destructive: Boolean(tool.annotations?.destructiveHint),
    sequential: tool.executionMode === "sequential",
    parameters: describeParameters(tool.parameters),
  }));
}

export function describeToolError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return (error as Error).message;
}
