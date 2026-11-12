import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BudgetConfig } from "../config.js";
import { AppError, isAppError } from "../errors.js";
import type { ColumnMeta } from "../db/engines/base.js";
import { cellText } from "../db/engines/base.js";
import type { DbSession } from "../db/session.js";

const TOOL_TEXT_BUDGET = 12_000;

export interface ToolRuntime {
  db: DbSession;
  budgets: BudgetConfig;
  currentTaskId(): string | undefined;
  taskStatus(): Record<string, unknown>;
  cancelActive(): Promise<boolean>;
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
      content: [{ type: "text" as const, text: `Error ${error.code}: ${error.message}` }],
      details: { code: error.code },
      structuredContent: { code: error.code, message: error.message } as never,
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
      "SQL is validated before execution: only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN are accepted, source writes are rejected. " +
      "The full result is stored and can be paged with result_read.",
    promptSnippet: "Run one read-only SQL statement and get a result_id for paging",
    promptGuidelines: [
      "Send exactly one statement per call; multiple statements are rejected.",
      "Add a LIMIT to exploratory queries over large tables.",
      "If the output says truncated, use result_read instead of assuming the data ends there.",
    ],
    parameters: Type.Object({
      sql: Type.String({ description: "One read-only SQL statement" }),
      label: Type.Optional(Type.String({ description: "Short label for the result, e.g. 'monthly revenue'" })),
      max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000, description: "Row cap for this call" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params, signal) => {
      try {
        const meta = await db.query(params.sql, {
          label: params.label,
          taskId: runtime.currentTaskId(),
          maxRows: params.max_rows,
          signal,
        });
        const preview = renderTable(meta.columns, meta.preview, cellChars);
        const text = [
          `result_id=${meta.id}`,
          `stored_rows=${meta.rowCount} truncated=${meta.truncated} duration_ms=${meta.durationMs} bytes=${meta.bytes}`,
          meta.truncated !== "none"
            ? `NOTE: the stored result was capped (${meta.truncated}). Use result_read(result_id="${meta.id}", offset=...) for more rows.`
            : "",
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
          next_offset: meta.truncated === "none" ? null : meta.previewRows,
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
      "Page through the full rows of a previous query_execute result. Returns rows plus next_offset (null at the end).",
    promptSnippet: "Page through a stored query result by result_id",
    promptGuidelines: ["Start with offset 0 and follow next_offset until it is null."],
    parameters: Type.Object({
      result_id: Type.String({ description: "result_id returned by query_execute or query_explain" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Row offset, default 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: "Rows to return, default 50" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const page = await db.readResult(params.result_id, params.offset ?? 0, params.limit ?? 50);
        const text = [
          `result_id=${page.id} rows=${page.rows.length} offset=${page.offset} total_rows=${page.rowCount} next_offset=${page.nextOffset ?? "null"}`,
          "",
          renderTable(page.columns, page.rows, cellChars),
        ].join("\n");
        return textOutput(clampText(text), {
          result_id: page.id,
          offset: page.offset,
          next_offset: page.nextOffset,
          row_count: page.rowCount,
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
          `source_access=${capabilities.sourceAccess} read_only_proof=${capabilities.readOnlyProof}`,
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
      "Search tables, views and other relations by name or schema. Returns qualified names, kind and an estimated row count. This searches names only; use object_describe for columns.",
    promptSnippet: "Find tables/views by name or schema",
    promptGuidelines: [
      "Start with broad search terms (e.g. 'order', 'customer'); refine with schema when names collide.",
      "Estimated row counts may be stale; they are not exact counts.",
    ],
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Substring to match against object or schema name" })),
      schema: Type.Optional(Type.String({ description: "Restrict to this schema/database" })),
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
          schema: params.schema,
          kinds: params.kinds as never,
          limit: params.limit ?? 100,
        });
        const lines = objects.map(
          (object) =>
            `${object.schema}.${object.name} [${object.kind}]${object.rowEstimate !== null && object.rowEstimate !== undefined ? ` ~${object.rowEstimate} rows` : ""}${object.comment ? ` — ${object.comment}` : ""}`,
        );
        return textOutput(clampText(lines.length ? lines.join("\n") : "No matching relations."), { objects });
      } catch (error) {
        return errorOutput(error);
      }
    },
  });

  const objectDescribe = defineTool({
    name: "object_describe",
    label: "Describe table or view",
    description:
      "Describe one relation: columns with types/nullability/defaults, primary key, indexes, foreign keys, and kind. Use before writing SQL.",
    promptSnippet: "Describe columns, keys and indexes of a table or view",
    promptGuidelines: ["Pass the schema/database when the object is not in the default scope."],
    parameters: Type.Object({
      name: Type.String({ description: "Relation name" }),
      schema: Type.Optional(Type.String({ description: "Schema (PostgreSQL) or database (MySQL)" })),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const described = await db.describe(params.schema ?? null, params.name);
        const lines = [
          `${described.object.schema}.${described.object.name} (${described.object.kind})${described.object.rowEstimate !== null ? ` ~${described.object.rowEstimate} rows` : ""}${described.object.comment ? ` — ${described.object.comment}` : ""}`,
          `primary_key: ${described.primaryKey.length ? described.primaryKey.join(", ") : "(none)"}`,
          "",
          "columns:",
          ...described.columns.map(
            (column) =>
              `- ${column.name} ${column.type}${column.nullable ? "" : " NOT NULL"}${column.default !== null && column.default !== undefined ? ` DEFAULT ${column.default}` : ""}${column.comment ? ` — ${column.comment}` : ""}`,
          ),
        ];
        if (described.indexes.length) {
          lines.push("", "indexes:", ...described.indexes.map((index) => `- ${index.name}${index.unique ? " UNIQUE" : ""} (${index.columns.join(", ")})`));
        }
        if (described.foreignKeys.length) {
          lines.push("", "foreign_keys:", ...described.foreignKeys.map((fk) => `- ${fk.name} (${fk.columns.join(", ")}) -> ${fk.references}`));
        }
        return textOutput(clampText(lines.join("\n")), { object: described.object, columns: described.columns, primary_key: described.primaryKey });
      } catch (error) {
        return errorOutput(error);
      }
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
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const profile = await db.profile(params.schema ?? null, params.name, params.sample_rows ?? 50);
        const lines = [
          `${profile.object.schema}.${profile.object.name} estimated_rows=${profile.rowCount ?? "unknown"} sampled=${profile.sampled}`,
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
      sql: Type.String({ description: "One read-only SQL statement" }),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_id, params) => {
      try {
        const { result, plan } = await db.explain(params.sql);
        const text = [
          `result_id=${result.id}`,
          `estimated_cost=${plan.estimatedCost ?? "n/a"} estimated_rows=${plan.estimatedRows ?? "n/a"}`,
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
      "Cancel the query currently executing on this session's database connection, using a separate control connection. The session stays usable afterwards.",
    promptSnippet: "Cancel the query that is currently running",
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

  return [
    sessionInfo,
    catalogSearch,
    objectDescribe,
    dataProfile,
    queryExplain,
    queryExecute,
    jobGet,
    jobCancel,
    resultRead,
    datasetCreate,
    datasetList,
    datasetDrop,
  ];
}

export function describeToolError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return (error as Error).message;
}
