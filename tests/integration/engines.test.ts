import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { AppConfig } from "../../src/config.js";
import { DbSession } from "../../src/db/session.js";
import type { ConnectionConfig } from "../../src/db/types.js";
import { ResultStore } from "../../src/results/store.js";
import { PostgresEngine } from "../../src/db/engines/postgres.js";

/**
 * Real-database conformance. Skipped unless a DSN is provided, either through the environment or
 * through tests/.env.test (which also works when the Node binary lives on another OS and cannot
 * inherit shell variables):
 *
 *   DATA_AGENT_TEST_PG=postgres://ro_analyst:ro@127.0.0.1:55432/analytics
 *   DATA_AGENT_TEST_MYSQL=mysql://ro_analyst:ro@127.0.0.1:53306/analytics
 *
 * Languages are seeded with scripts/seed/{postgres,mysql}.sql; `npm run test:integration:local`
 * boots scripts/pglite-server.mjs so PostgreSQL conformance needs no Docker.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "..", ".env.test");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*\S)\s*$/.exec(line);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
}

function testApp(dataDir: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    apiToken: "",
    dataDir,
    sessionTtlMs: 60_000,
    maxSessions: 2,
    allowPrivateNetwork: true,
    env: "development",
    model: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "medium" },
    budgets: {
      maxTurns: 5,
      maxQueries: 20,
      taskTimeoutMs: 60_000,
      queryTimeoutMs: 15_000,
      maxResultRows: 10_000,
      previewRows: 5,
      cellChars: 200,
      maxResultBytes: 8 * 1024 * 1024,
      maxDatasets: 10,
      maxChartRows: 5_000,
      maxChartCells: 3_600,
      maxArtifactsPerTask: 12,
    },
  };
}

function parseDsn(dsn: string, engine: "postgres" | "mysql", environment: "production" | "non_production"): ConnectionConfig {
  const url = new URL(dsn);
  return {
    engine,
    host: url.hostname,
    port: Number(url.port || (engine === "mysql" ? 3306 : 5432)),
    database: url.pathname.replace(/^\//, "") || "analytics",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    environment,
    workspace: { name: url.searchParams.get("workspace") ?? "analysis_ws" },
  };
}

async function withSession(engine: "postgres" | "mysql", dsn: string, fn: (session: DbSession) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), `data-agent-it-${engine}-`));
  const app = testApp(dataDir);
  const session = await DbSession.open({
    config: parseDsn(dsn, engine, "non_production"),
    app,
    results: new ResultStore(join(dataDir, "results")),
  });
  try {
    await fn(session);
  } finally {
    await session.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

it("PostgreSQL returns to idle after read-only queries, failures and early stream termination", {
  skip: !process.env.DATA_AGENT_TEST_PG, timeout: 15_000,
}, async () => {
  const engine = new PostgresEngine(parseDsn(process.env.DATA_AGENT_TEST_PG!, "postgres", "non_production"), { applicationName: "chart-transaction-test" });
  try {
    await engine.connect();
    let status = "";
    // Observe actual protocol messages rather than assuming a successful query means COMMIT ran.
    (engine as any).client.connection.on("readyForQuery", (message: { status: string }) => { status = message.status; });
    const limits = { timeoutMs: 5000, maxRows: 2, maxBytes: 100_000, maxCellChars: 1000 };
    const rows: unknown[][] = [];
    const sink = { onRow: (row: unknown[]) => { rows.push(row); } };
    await engine.query("SHOW transaction_read_only", limits, sink);
    assert.equal(rows[0]?.[0], "on");
    assert.equal(status, "I", "no transaction may remain open after a successful query");
    await assert.rejects(() => engine.query("SELECT 1 / 0", limits, sink));
    assert.equal(status, "I", "a failed query must roll back");
    const capped = await engine.query("SELECT * FROM generate_series(1, 10)", limits, sink);
    assert.equal(capped.truncated, "rows");
    assert.equal(status, "I", "closing a cursor at the row cap must roll back");
    await engine.explain("SELECT 42", limits);
    assert.equal(status, "I", "buffered metadata/explain queries must commit");
  } finally { await engine.close(); }
});

const suites: Array<[string, "postgres" | "mysql", string | undefined]> = [
  ["PostgreSQL", "postgres", process.env.DATA_AGENT_TEST_PG],
  ["MySQL", "mysql", process.env.DATA_AGENT_TEST_MYSQL],
];

for (const [label, engine, dsn] of suites) {
  const hint = engine === "postgres" ? "DATA_AGENT_TEST_PG" : "DATA_AGENT_TEST_MYSQL";
  describe(`${label} session conformance`, { skip: dsn ? false : `set ${hint} (or tests/.env.test) to run` }, () => {
    it("reports read-only capabilities", async () => {
      await withSession(engine, dsn!, async (session) => {
        const snapshot = session.snapshot();
        assert.equal(snapshot.capabilities.sourceAccess, "read_only");
        assert.equal(snapshot.engine, engine);
        assert.ok(snapshot.capabilities.workspaceAccess !== "none", "workspace must be provisioned and writable");
      });
    });

    it("executes a SELECT and stores the full result", async () => {
      await withSession(engine, dsn!, async (session) => {
        const meta = await session.query("SELECT * FROM sales ORDER BY id");
        assert.ok(meta.rowCount >= 5, `expected seeded rows, got ${meta.rowCount}`);
        const page = await session.readResult(meta.id, 0, 2);
        assert.equal(page.rows.length, 2);
        assert.equal(page.nextOffset, 2);
      });
    });

    it("rejects writes before they reach the server", async () => {
      await withSession(engine, dsn!, async (session) => {
        await assert.rejects(() => session.query("DELETE FROM sales"), /read-only|not allowed|forbidden/i);
        await assert.rejects(() => session.query("UPDATE sales SET amount = 0"), /read-only|not allowed|forbidden/i);
        await assert.rejects(() => session.query("SELECT 1; DROP TABLE sales"), /single SQL statement/i);
      });
    });

    it("creates, queries and drops an analysis view", async () => {
      await withSession(engine, dsn!, async (session) => {
        const record = await session.createDataset(
          "ds_region_totals",
          "SELECT region, COUNT(*) AS orders, SUM(amount) AS total FROM sales GROUP BY region",
          "view",
        );
        assert.equal(record.status, "ready");
        const listed = await session.listDatasets();
        assert.ok(listed.some((dataset) => dataset.name === "ds_region_totals" && dataset.exists));

        const meta = await session.query(
          engine === "postgres"
            ? 'SELECT * FROM analysis_ws."ds_region_totals" ORDER BY region'
            : "SELECT * FROM analysis_ws.ds_region_totals ORDER BY region",
        );
        assert.ok(meta.rowCount > 0);

        await session.dropDataset("ds_region_totals");
        const after = await session.listDatasets();
        assert.ok(!after.some((dataset) => dataset.name === "ds_region_totals"));
      });
    });

    it("refuses to create a dataset in production as a table", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `data-agent-it-${engine}-prod-`));
      const session = await DbSession.open({
        config: parseDsn(dsn!, engine, "production"),
        app: testApp(dataDir),
        results: new ResultStore(join(dataDir, "results")),
      });
      try {
        assert.equal(session.snapshot().capabilities.workspaceAccess, "views_only");
        await assert.rejects(() => session.createDataset("ds_should_fail", "SELECT 1 AS n", "table"), /view/i);
      } finally {
        await session.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("searches columns/comments, batches metadata and returns a bounded overview", async () => {
      await withSession(engine, dsn!, async (session) => {
        const objects = await session.catalogSearch({ search: "region", searchColumns: true });
        assert.ok(objects.some(o => o.name === "sales"));
        const batch = await session.describeMany([{ name: "sales" }]);
        assert.ok("description" in batch[0]!);
        const sales = batch[0]!.description!;
        assert.deepEqual(sales.primaryKey, ["id"]);
        assert.ok(sales.indexes.some(i => i.columns.includes("id") && i.unique));
        const overview = await session.catalogOverview(undefined, 5);
        assert.ok(overview.tables.length > 0);
        assert.match(overview.scope, /bounded/);
      });
    });

    it("browses scopes and paginates filtered objects with column match details", async () => {
      await withSession(engine, dsn!, async (session) => {
        const catalog = await session.catalogScopes();
        assert.ok(catalog.scopes.includes(catalog.default_scope));
        assert.ok(catalog.scopes.includes("analysis_ws"));
        const options = { schema: catalog.default_scope, limit: 1, offset: 0, refresh: false };
        assert.equal(catalog.table_counts?.[catalog.default_scope], 1, "only sales, not the view or sequence");
        const workspaceTables = catalog.table_counts?.analysis_ws;
        assert.equal(typeof workspaceTables, "number");
        assert.equal(catalog.table_counts?.information_schema, undefined);
        const first = await session.catalogPage(options);
        assert.equal(first.nextOffset, 1);
        const second = await session.catalogPage({ ...options, offset: first.nextOffset! });
        assert.notEqual(first.objects[0]?.name, second.objects[0]?.name);
        const views = await session.catalogPage({ ...options, kinds: ["view"] });
        assert.equal(views.objects[0]?.name, "sales_by_region");
        assert.equal(views.nextOffset, null);
        const name = "ds_catalog_count";
        await session.createDataset(name, "SELECT 1 AS n", "table");
        try {
          const updated = await session.catalogScopes(true);
          assert.equal(updated.table_counts?.analysis_ws, workspaceTables! + 1);
          assert.equal((await session.catalogScopes()).table_counts?.analysis_ws, workspaceTables! + 1);
        } finally {
          await session.dropDataset(name);
        }
        const searched = await session.catalogPage({ search: "region", searchColumns: true, limit: 100, offset: 0, refresh: false });
        assert.equal(searched.objects[0]?.name, "sales_by_region", "name match before column hit");
        assert.deepEqual(searched.objects.find((o) => o.name === "sales")?.columnMatch, { name: "region", count: 1 });
        const literal = await session.catalogPage({ ...options, search: "sales%", searchColumns: true });
        assert.deepEqual(literal.objects, [], "percent is a literal substring, not a wildcard");
        const blocked = await session.catalogPage({ ...options, schema: "information_schema" });
        assert.deepEqual(blocked, { objects: [], nextOffset: null });
      });
    });

    it("explains a query", async () => {
      await withSession(engine, dsn!, async (session) => {
        const { plan } = await session.explain("SELECT * FROM sales WHERE region = 'EU'");
        assert.ok(plan.planText.length > 0);
      });
    });

    it("cancels a running query through the control connection", {
      skip: engine === "postgres" && process.env.DATA_AGENT_TEST_PGLITE === "1"
        ? "PGlite multiplexes one backend; cancellation requires a real PostgreSQL server" : false,
      timeout: 30_000,
    }, async () => {
      await withSession(engine, dsn!, async (session) => {
        // A deliberately expensive but permissible statement: no blocked functions, so this
        // exercises the cancellation channel rather than the guard.
        const heavy =
          engine === "postgres"
            ? "SELECT count(*) FROM generate_series(1, 2000000000)"
            : "SELECT count(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c";
        const started = Date.now();
        const running = session.query(heavy).then(
          () => "finished" as const,
          (error: unknown) => error as Error,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const cancelled = await session.cancel();
        assert.equal(cancelled, true, "cancel() must reach the server");
        const outcome = await running;
        assert.ok(outcome instanceof Error, "the query must fail after cancellation");
        assert.ok(Date.now() - started < 25_000, "cancellation must interrupt the query promptly");
        const next = await session.query("SELECT 42 AS answer");
        assert.equal(Number(next.preview[0]?.[0]), 42, "statement cancellation must leave the session usable");
      });
    });

    it("recovers after a server error and a row-capped stream", async () => {
      await withSession(engine, dsn!, async (session) => {
        await assert.rejects(() => session.query("SELECT * FROM missing_chart_fixture_table"));
        const capped = await session.query("SELECT * FROM sales ORDER BY id", { maxRows: 2 });
        assert.equal(capped.truncated, "rows");
        assert.equal(capped.rowCount, 2);
        const next = await session.query("SELECT 42 AS answer");
        assert.equal(Number(next.preview[0]?.[0]), 42);
      });
    });

    it("enforces the query budget", async () => {
      await withSession(engine, dsn!, async (session) => {
        for (let index = 0; index < 3; index += 1) await session.query("SELECT 1");
        const snapshot = session.snapshot();
        assert.equal(snapshot.queries.used, session.capabilitiesView.features.explain ? 6 : 3);
        assert.equal(snapshot.queries.limit, 20);
      });
    });
  });
}
