import { Type } from "typebox";
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
      name: "object_describe_batch",
      label: "Describe multiple tables",
      description:
        "Describe up to 20 named tables in one call using cached bounded metadata workers. Each item may report its own error.",
      parameters: Type.Object({
        objects: Type.Array(
          Type.Object({
            name: Type.String(),
            schema: Type.Optional(Type.String()),
          }),
          { minItems: 1, maxItems: 20 },
        ),
      }),
      executionMode: "parallel",
      annotations,
      execute: async (_id, p) => output(await db.describeMany(p.objects)),
    }),
    defineTool({
      name: "result_summary",
      label: "Summarize stored result",
      description:
        "Bounded streaming statistics over stored rows only: nulls, capped distinct counts, candidate frequencies and approximate numeric ranges. Not source-table statistics. Does not rescan source.",
      parameters: Type.Object({ result_id: id }),
      executionMode: "parallel",
      annotations,
      execute: async (_id, p) => output(await db.resultSummary(p.result_id)),
    }),
    defineTool({
      name: "result_transform",
      label: "Analyze stored rows with SQL",
      description:
        "Execute safe PostgreSQL SELECT on local table data. Aggregate, pivot, sort or TopN+Other explicitly; creates an immutable derived result_id with parent lineage. Decimal text precision is preserved. Incomplete input is rejected unless explicitly accepted.",
      parameters: Type.Object({
        result_id: id,
        sql,
        allow_partial: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        const m = await db.resultSql(p.result_id, p.sql, p.allow_partial, runtime.currentTaskId());
        return output({
          result_id: m.id,
          rows: m.rowCount,
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
        "Pin an already stored complete result under a local snapshot name. Does not extract source data. Only bounded inputs are accepted. Query with snapshot_query using table data.",
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
      name: "snapshot_query",
      label: "Query local snapshot",
      description:
        "Read-only analytical SQL over a pinned local snapshot as table data. Creates a derived result with lineage and no source queries.",
      parameters: Type.Object({ snapshot_id: id, sql }),
      executionMode: "sequential",
      annotations: { ...annotations, readOnlyHint: false },
      execute: async (_id, p) => {
        const m = await db.snapshotQuery(p.snapshot_id, p.sql, runtime.currentTaskId());
        return output({
          result_id: m.id,
          columns: m.columns,
          preview: m.preview,
          lineage: m.lineage,
        });
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
        "Hide an obsolete chart from the working list without deleting immutable evidence or breaking report refs. Does not reset the per-task artifact budget.",
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
        "Create an immutable chart revision with a new title; old chart ids/refs remain valid. This is not an in-place mutation.",
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
