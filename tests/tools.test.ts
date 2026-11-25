import assert from "node:assert/strict";
import { it } from "node:test";
import { Check } from "typebox/value";
import { createDatabaseTools, selectTools, toolCatalog, type ToolRuntime } from "../src/agent/tools.js";
import type { SessionCapabilities } from "../src/db/types.js";
import { AppError } from "../src/errors.js";

const caps = {
  features: { cancel: true, explain: true, explainAnalyze: true, streaming: true },
  workspaceAccess: "none",
} satisfies Pick<SessionCapabilities, "features" | "workspaceName" | "workspaceAccess">;

it("always exposes analysis and management tools and gates workspace tools and EXPLAIN", () => {
  const catalog = toolCatalog();
  const names = (capabilities: Pick<SessionCapabilities, "features" | "workspaceName" | "workspaceAccess">) =>
    selectTools(catalog, capabilities).map((t) => t.name).sort();
  const base = names(caps);
  assert.deepEqual(base, [
    "ask_user", "catalog_overview", "catalog_search", "chart_archive", "chart_create", "chart_list", "chart_revise",
    "data_profile", "job_cancel", "job_get", "object_describe", "query_execute", "query_explain",
    "result_compute", "result_read", "result_transform", "session_info", "snapshot_create", "snapshot_drop", "snapshot_list",
  ]);
  const writable = { ...caps, workspaceName: "analysis_ws", workspaceAccess: "views_only" as const };
  assert.deepEqual(selectTools(catalog, writable, true), catalog);
  assert.deepEqual(names({ ...writable, workspaceAccess: "none" }), base);
  assert.deepEqual(names({ ...caps, workspaceAccess: "views_only" }), base);
  const noPlan = { ...caps, features: { ...caps.features, explain: false } };
  assert.deepEqual(names(noPlan), base.filter((name) => name !== "query_explain"));
  for (const old of ["object_describe_batch", "result_summary", "snapshot_query"]) {
    assert.ok(!catalog.some((t) => t.name === old));
  }
});

function tool(name: string, db: Partial<ToolRuntime["db"]>) {
  return createDatabaseTools({
    db, budgets: { maxTurns: 10, maxQueries: 20, cellChars: 200 }, currentTaskId: () => "task_fixture", taskStatus: () => ({}),
  } as unknown as ToolRuntime).find((t) => t.name === name)!;
}

it("describes one or more objects through the same entry point and retains per-item errors", async () => {
  const orders = { name: "orders", schema: "sales" };
  const missing = { name: "missing" };
  const describe = tool("object_describe", {
    describeMany: async (objects) => objects.map((item) => item.name === orders.name ? {
      ...item,
      description: {
        object: { ...orders, kind: "table" as const, rowEstimate: 100 },
        columns: [{ name: "order_id", type: "int", nullable: false, ordinal: 1 }],
        primaryKey: ["order_id"], indexes: [], foreignKeys: [],
      },
    } : { ...item, error: "not found" }),
  });
  const single = { objects: [orders] };
  const multiple = { objects: [orders, missing] };
  for (const input of [single, multiple]) {
    assert.ok(Check(describe.parameters, input));
    const response = await describe.execute("call", input, undefined, undefined, {} as never);
    const { objects } = response.structuredContent as { objects: Array<{ name: string; error?: string }> };
    assert.deepEqual(objects.map((item) => item.name), input.objects.map((item) => item.name));
    assert.match(response.content.map((part) => "text" in part ? part.text : "").join("\n"), /order_id int NOT NULL/);
    if (input === multiple) assert.equal(objects[1]?.error, "not found");
  }
  assert.ok(!Check(describe.parameters, orders));
  assert.ok(!Check(describe.parameters, { objects: [] }));
  assert.ok(!Check(describe.parameters, { objects: Array(21).fill(orders) }));
});

it("blocks identical failed exploration and allows only one field/dialect correction per task", async () => {
  let task = "task_first";
  const dispatched: string[] = [];
  const db = {
    query: async (sql: string) => {
      dispatched.push(sql);
      throw new AppError(sql.includes("denied") ? "SQL_SCOPE_VIOLATION" : sql.includes("field") ? "SQL_FIELD_ERROR" : "SQL_DIALECT_ERROR", "fixture rejection");
    },
  };
  const execute = createDatabaseTools({ db, budgets: { maxTurns: 10, maxQueries: 20, cellChars: 200 }, currentTaskId: () => task, taskStatus: () => ({}) } as unknown as ToolRuntime).find(t => t.name === "query_execute")!.execute;
  const run = async (sql: string) => (await execute("call", { sql }, undefined, undefined, {} as never)).details as { code: string; source_blocked?: boolean };
  assert.equal((await run("SELECT denied")).code, "SQL_SCOPE_VIOLATION");
  assert.equal((await run("  SELECT denied ; ")).source_blocked, true);
  assert.equal((await run("SELECT field")).code, "SQL_FIELD_ERROR");
  assert.equal((await run("SELECT field;")).source_blocked, true);
  assert.equal((await run("SELECT bad_syntax")).code, "SQL_DIALECT_ERROR");
  assert.equal((await run("SELECT 1")).source_blocked, true);
  task = "task_second";
  assert.equal((await run("SELECT field")).code, "SQL_FIELD_ERROR");
  assert.deepEqual(dispatched, ["SELECT denied", "SELECT field", "SELECT bad_syntax", "SELECT field"]);
});

it("reads stored rows and summaries via explicit result_read modes", async () => {
  const calls: unknown[][] = [];
  const read = tool("result_read", {
    resultSummary: async (id) => {
      calls.push(["summary", id]);
      return { rows: 4 } as Awaited<ReturnType<ToolRuntime["db"]["resultSummary"]>>;
    },
    readResult: async (id, offset, limit) => {
      calls.push(["rows", id, offset, limit]);
      return {
        id, offset, rowCount: 4, nextOffset: null, columns: [{ name: "amount", type: "int" }], rows: [[42]],
        truncated: "rows", createdAt: "2026-01-01T00:00:00.000Z", sql: "SELECT amount FROM sales",
      };
    },
  });
  const rows = await read.execute("call", { result_id: "res_fixture", offset: 3, limit: 1 }, undefined, undefined, {} as never);
  assert.equal((rows.details as { result_id: string }).result_id, "res_fixture");
  assert.equal((rows.details as { truncated: string }).truncated, "rows");
  const summary = await read.execute("call", { result_id: "res_fixture", mode: "summary" }, undefined, undefined, {} as never);
  assert.deepEqual(summary.structuredContent, { rows: 4 });
  assert.deepEqual(calls, [["rows", "res_fixture", 3, 1], ["summary", "res_fixture"]]);
});

it("routes local transforms by source kind, preserves lineage and forbids partial snapshots", async () => {
  const calls: unknown[][] = [];
  const sql = "SELECT COUNT(*) FROM data";
  const meta = {
    id: "res_derived", rowCount: 1, preview: [[1]], columns: [], lineage: { parent_result_id: "res_fixture" },
  } as Awaited<ReturnType<ToolRuntime["db"]["snapshotQuery"]>>;
  const transform = tool("result_transform", {
    resultSql: async (...args) => { calls.push(["result", ...args]); return meta; },
    snapshotQuery: async (...args) => { calls.push(["snapshot", ...args]); return meta; },
  });
  const inputs = [
    { source: { kind: "result", id: "res_fixture" }, sql },
    { source: { kind: "result", id: "res_fixture" }, sql, allow_partial: true },
    { source: { kind: "snapshot", id: "snp_fixture" }, sql },
  ];
  for (const input of inputs) {
    assert.ok(Check(transform.parameters, input));
    const response = await transform.execute("call", input, undefined, undefined, {} as never);
    assert.equal(response.isError, undefined);
    assert.deepEqual((response.details as { lineage: unknown }).lineage, meta.lineage);
  }
  const invalid = await transform.execute("call", { ...inputs[2], allow_partial: true }, undefined, undefined, {} as never);
  assert.equal(invalid.isError, true);
  assert.equal((invalid.details as { code: string }).code, "INVALID_INPUT");
  assert.ok(!Check(transform.parameters, { source: { kind: "table", id: "t" }, sql }));
  assert.ok(!Check(transform.parameters, { result_id: "res_fixture", sql }));
  assert.deepEqual(calls, [
    ["result", "res_fixture", sql, false, "task_fixture"],
    ["result", "res_fixture", sql, true, "task_fixture"],
    ["snapshot", "snp_fixture", sql, "task_fixture"],
  ]);
});
