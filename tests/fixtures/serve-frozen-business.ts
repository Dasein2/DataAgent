// Manual desktop/mobile acceptance: node --import tsx tests/fixtures/serve-frozen-business.ts
// Binds to loopback only; no credentials, external model, or source DB are used.
import { createServer } from "node:http";
import { AnalysisService, callerKey } from "../../src/agent/service.js";
import { createHttpApp } from "../../src/api/http.js";
import { TtlCache } from "../../src/analysis/cache.js";
import { DbSession } from "../../src/db/session.js";
import { describeEngine, getProfile } from "../../src/db/engines/profiles.js";
import { sourceRequest } from "../../src/db/source-operations.js";
import { ConnectionConfig } from "../../src/db/types.js";
import type { RowSink } from "../../src/db/engines/base.js";
import { testConfig, cleanup } from "../support.js";
import { catalog, data, queryFrozen, trend } from "./frozen-business.js";

const config = await testConfig();
config.sessionTtlMs = 30 * 60_000; config.analysis = { preflight: "off" }; config.budgets.maxResultRows = 2_000;
const counts = { source_select: 0, metadata: 0, model: 0 };
const model = createServer((_req, res) => { counts.model++; res.writeHead(503).end("Fixture does not use model generation"); });
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
config.model = { provider: "frozen", modelId: "unused", api: "openai-completions", apiKey: "fixture", thinkingLevel: "off", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` };
const db = await data();
// Keep the two-day reference values unchanged; add eight complete days for zoom QA.
await db.exec(`INSERT INTO sales.orders
  SELECT 1, 100000 + day * 1000 + channel * 100 + seq, DATE '2026-11-11' + day, channel, 'paid', 1
  FROM generate_series(0,7) AS day, generate_series(1,3) AS channel, LATERAL generate_series(1,10 + day + channel) AS seq`);
const profile = getProfile("doris");
DbSession.open = async ({ config: connection, app, results }) => {
  const session = new (DbSession as any)("sess_frozenpay", connection, app, results) as DbSession;
  const metadata = <T>(fn: () => Promise<T>) => sourceRequest("metadata", () => { counts.metadata++; return fn(); });
  Object.assign(session, { allowedScopes: ["sales"], defaultCatalogScope: "sales", metadataCache: new TtlCache(300_000), capabilities: {
    engine: "doris", engineLabel: "Doris fixture", engineProfile: describeEngine(profile), serverVersion: "frozen rows, not Doris", environment: "non_production", sourceAccess: "read_only", readOnlyProof: "grants", workspaceAccess: "none", notes: [], features: { explain: false },
  }, engine: {
    profile,
    businessPermissionKey: () => metadata(async () => "frozen-read-only"),
    describeObject: (schema: string, name: string) => metadata(async () => {
      const { rows } = await db.query<{ name: string; type: string }>("SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [schema, name]);
      return { object: { schema, name, kind: "table" }, columns: rows.map(c => ({ ...c, type: c.type === "numeric" ? "decimal(20,2)" : c.type, nullable: false })), primaryKey: [], foreignKeys: [], indexes: [] };
    }),
    query: (sql: string, _limits: unknown, sink: RowSink) => sourceRequest("source_select", async () => {
      counts.source_select++;
      const result = await queryFrozen(db, sql);
      const columns = result.fields.map(f => ({ name: f.name, type: "text" }));
      sink.onColumns?.(columns);
      const rows = result.rows.map(row => row.map(v => v instanceof Date ? v.toISOString().slice(0, 10) : v));
      for (const row of rows) await sink.onRow(row);
      return { columns, rowCount: rows.length, bytes: JSON.stringify(rows).length, durationMs: 1, truncated: "none", warnings: [] };
    }),
    close: async () => {}, cancel: async () => false,
  } });
  return session;
};
const service = await AnalysisService.create(config);
const session = await service.createSession(ConnectionConfig.parse({ engine: "doris", host: "frozen-fixture", port: 9030, database: "sales", user: "frozen", password: "", environment: "non_production" }), callerKey(config.apiToken));
session.setTitle("支付订单 · 冻结验收");
const draft = await session.business!.draft(catalog);
await session.business!.publish(draft.id, "构造数据，仅用于验收");
await session.business!.enable(true);
const full = await session.business!.analyze(trend);
const totals = await session.business!.analyze({ ...trend, dimension: undefined });
const extended = await session.business!.analyze({ ...trend, window: { ...trend.window, start: "2026-11-11" } });
const app = await createHttpApp(service);
const server = createServer((req, res) => {
  if (req.url === "/__fixture") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...counts, ids: { full: full.result_id, totals: totals.result_id, extended: extended.result_id }, session: session.id }));
  } else app(req, res);
});
const port = Number(process.argv[2] ?? 18763);
await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
console.log(`http://127.0.0.1:${port}/`, { token: config.apiToken, full: full.result_id, totals: totals.result_id, extended: extended.result_id });
async function close() {
  server.close(); model.close(); await service.shutdown(); await db.close(); await cleanup(config);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
