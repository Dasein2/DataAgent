import { Type } from "typebox";
import { z } from "zod";
import { ResultOperation } from "../analysis/operations.js";
import { MetricRequest } from "../business/types.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "./tools.js";
import { AppError } from "../errors.js";

const id = Type.String({ minLength: 1, maxLength: 80 });
const sql = Type.String({
  minLength: 1,
  maxLength: 30_000,
  description:
    "One PostgreSQL-dialect SELECT over table data (the stored result). No source query, files or extensions.",
});
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
function output(value: unknown) {
  const text = JSON.stringify(value);
  return {
    content: [
      {
        type: "text" as const,
        text: text.length > 12_000 ? text.slice(0, 12_000) + "\n[Output clipped; narrow the request]" : text,
      },
    ],
    details: value as Record<string, unknown>,
  };
}

export function analysisTools(runtime: ToolRuntime): ToolDefinition[] {
  const { db } = runtime;
  return [
    defineTool({
      name: "result_compute",
      label: "Compute on a complete saved result",
      description: "Without querying the source, filter, group, sum, count, sort or compute share of a complete result by result_id. Use only when its scope, freshness, detail, and denominator satisfy the question. Each option is structured; do not pass SQL.",
      parameters: Type.Object({ result_id: id, operation: Type.Unsafe<ResultOperation>(z.toJSONSchema(ResultOperation, { io: "input" })) }, { additionalProperties: false }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        const m = await db.resultCompute(p.result_id, p.operation, runtime.currentTaskId());
        return output({ result_id: m.id, rows: m.rowCount, preview: m.preview.slice(0, 5), columns: m.columns, lineage: m.lineage, executed_at: m.createdAt, warnings: m.warnings });
      },
    }),
    defineTool({
      name: "business_lookup",
      label: "Find published business definitions",
      description: "For an enabled Doris domain, look up the metric or business vocabulary, candidate paths, and ambiguous attribution. Use a short meaningful phrase, not SQL. Ask only the distinction that changes the number. Catalog-only answers do not need a source SELECT.",
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 250 }) }),
      annotations,
      execute: async (_id, p) => output(await runtime.business?.lookup(p.question) ?? { candidates: [] }),
    }),
    defineTool({
      name: "business_analyze",
      label: "Run a published business metric",
      description: "Supply a published metric ID, explicit [start,end) window, optional same-length comparison, grain and optional published dimension/filters. No SQL input. Returns exact evidence; use the task report for charts and do not treat unsupported dimensions as verified.",
      parameters: Type.Unsafe<MetricRequest>(z.toJSONSchema(MetricRequest, { io: "input" })),
      executionMode: "sequential",
      annotations,
      execute: async (_id, p, signal) => {
        if (!runtime.business) throw new AppError("FEATURE_UNSUPPORTED", "Business metrics are unavailable");
        const report = await runtime.business.analyze(p, { taskId: runtime.currentTaskId(), signal });
        return output({ result_id: report.result_id, verification: report.status, reasons: report.reasons, metric: report.metric, version: report.version, timezone: report.timezone,
          coverage_through: report.complete_through, days: report.days.slice(-8).map(d => ({ ...d, channels: d.channels.slice(0, 5), deductions: d.deductions.slice(0, 5) })), total_period_rows: report.days.length });
      },
    }),
    defineTool({
      name: "catalog_overview",
      label: "Catalog overview",
      description:
        "Bounded overview of tables, time columns, primary keys and declared/inferred relationships. Inferred JOIN paths must be verified for uniqueness/cardinality.",
      parameters: Type.Object({
        schema: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      executionMode: "parallel",
      annotations,
      execute: async (_id, p) => output(await db.catalogOverview(p.schema, p.limit ?? 12)),
    }),
    defineTool({
      name: "result_transform",
      label: "Analyze stored rows with SQL",
      description:
        "Run PostgreSQL SELECT on a stored result or named snapshot as local table data, without querying the source. " +
        "Use for aggregation, filtering, sorting or TopN+Other. Returns a new result_id with parent lineage and preserves decimal precision. Snapshots must be complete.",
      parameters: Type.Object({
        source: Type.Object({
          kind: Type.Union([Type.Literal("result"), Type.Literal("snapshot")]),
          id,
        }, { description: "A result_id (kind=result) or snapshot_id (kind=snapshot)", additionalProperties: false }),
        sql,
        allow_partial: Type.Optional(Type.Boolean({ description: "Allow an incomplete result only with kind=result; default false" })),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        if (p.source.kind === "snapshot" && p.allow_partial) {
          throw new AppError("INVALID_INPUT", "allow_partial is only supported for a result source; snapshots must be complete");
        }
        const taskId = runtime.currentTaskId();
        const m = p.source.kind === "snapshot"
          ? await db.snapshotQuery(p.source.id, p.sql, taskId)
          : await db.resultSql(p.source.id, p.sql, p.allow_partial ?? false, taskId);
        return output({
          result_id: m.id,
          rows: m.rowCount,
          truncated: m.truncated,
          preview: m.preview,
          columns: m.columns,
          lineage: m.lineage,
          warnings: m.warnings,
        });
      },
    }),
    defineTool({
      name: "snapshot_create",
      label: "Pin local snapshot",
      description:
        "Name a complete, bounded stored result for repeated use in this session. Does not copy or refresh source data. Query with result_transform using kind=snapshot.",
      parameters: Type.Object({
        result_id: id,
        name: Type.String({ minLength: 1, maxLength: 120 }),
      }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => output(await db.snapshotCreate(p.result_id, p.name)),
    }),
    defineTool({
      name: "snapshot_list",
      label: "List local snapshots",
      description: "List this session's pinned local results and original creation times.",
      parameters: Type.Object({}),
      executionMode: "parallel",
      annotations,
      execute: async () => output(await db.snapshotList()),
    }),
    defineTool({
      name: "snapshot_drop",
      label: "Unpin local snapshot",
      description: "Remove a local snapshot name, not its source result or source database objects.",
      parameters: Type.Object({ snapshot_id: id }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        await db.snapshotDrop(p.snapshot_id);
        return output({ unpinned: p.snapshot_id });
      },
    }),
    defineTool({
      name: "chart_list",
      label: "List charts",
      description: "List chart artifacts in this session; immutable evidence survives archival.",
      parameters: Type.Object({
        include_archived: Type.Optional(Type.Boolean()),
      }),
      executionMode: "parallel",
      annotations,
      execute: async (_id, p) => output(await runtime.artifacts.listBySession(db.id, p.include_archived)),
    }),
    defineTool({
      name: "chart_archive",
      label: "Archive a chart",
      description:
        "When requested by the user, archive or restore a chart in the working list without breaking report refs. Does not reset the per-task artifact budget.",
      parameters: Type.Object({
        chart_id: id,
        archived: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        await runtime.artifacts.archive(p.chart_id, db.id, p.archived ?? true);
        return output({ chart_id: p.chart_id, archived: p.archived ?? true });
      },
    }),
    defineTool({
      name: "chart_revise",
      label: "Revise chart title",
      description:
        "When the user asks to rename a chart, create a revision with a new title. The original chart and its refs remain valid.",
      parameters: Type.Object({
        chart_id: id,
        title: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        const original = await runtime.artifacts.ownedBy(p.chart_id, db.id);
        const { artifact } = await runtime.artifacts.createChart({
          sessionId: db.id,
          taskId: runtime.currentTaskId(),
          spec: { ...original.spec, title: p.title },
        });
        return output({ chart_id: artifact.id, revises: original.id });
      },
    }),
  ];
}

export function recoveryHint(error: unknown): string {
  if (!(error instanceof AppError))
    return "Narrow the request and inspect session capabilities; do not repeat the same failing call.";
  switch (error.code) {
    case "QUERY_TIMEOUT":
      return "The connection SQL time limit was reached. Do not widen/repeat the scan. Check session_info; if unavailable, stop and request reconnect. Otherwise inspect partition filters/plan or summarize saved evidence. Timeout changes require connection settings, not SQL.";
    case "QUERY_COST_EXCEEDED":
      return "Add selective WHERE/partition filters or use a read replica. LIMIT does not reduce all scan costs.";
    case "QUERY_BUDGET_EXCEEDED":
      return "Stop querying; use stored results and state any missing evidence.";
    case "CHART_RESULT_TRUNCATED":
      return "Rerun a reduced/aggregated source query; paging cannot recover unstored rows.";
    case "FEATURE_UNSUPPORTED":
      return "Use session_info to inspect supported engine features and choose another method.";
    case "SESSION_UNAVAILABLE":
      return "Read stored results; reconnect before further source queries.";
    default:
      return "Check the error details, adjust parameters/SQL, and do not repeat the identical call.";
  }
}
