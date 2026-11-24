import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { it, type TestContext } from "node:test";
import { ZodError } from "zod";
import { prepareDorisPilot, runDorisPilot } from "../scripts/doris-pilot-check.js";
import { DorisEngine } from "../src/db/engines/mysql.js";
import { data, queryFrozen } from "./fixtures/frozen-business.js";

const readManifest = async () => JSON.parse(await readFile(new URL("./fixtures/doris-pilot-cases.json", import.meta.url), "utf8"));
const build = "doris version doris-fixture-123";
const target = { authorization_ref: "local mock only", snapshot_ref: "synthetic-frozen-business-v1", version_comment: build,
  connection: { engine: "doris", host: "127.0.0.1", port: 9030, database: "sales", user: "reader", password: "not-real", environment: "non_production" } };

it("prepares a stable, offline manifest and rejects cross-snapshot plans and incomplete reference days", async () => {
  const source = await readManifest();
  const a = prepareDorisPilot(source), b = prepareDorisPilot(source);
  assert.equal(a.manifest_sha256, b.manifest_sha256);
  assert.deepEqual(a.cases.map(c => c.sql_sha256), b.cases.map(c => c.sql_sha256));
  assert.match(a.cases.find(c => c.id === "utc_half_open")!.sql, /CONVERT_TZ/);
  assert.throws(() => prepareDorisPilot({ ...source, database: "different" }), /frozen database/);
  source.cases[2].days.pop();
  assert.throws(() => prepareDorisPilot(source), /every requested day/);
});

it("rejects a production declaration, weak proof, workspace, or different snapshot before session open", async () => {
  const prepared = prepareDorisPilot(await readManifest());
  const open = async () => { assert.fail("must not open session"); };
  for (const change of [{ environment: "production" }, { allowWeakReadOnly: true }, { workspace: { name: "sales" } }]) {
    await assert.rejects(runDorisPilot(prepared, { ...target, connection: { ...target.connection, ...change } }, "smoke", open), ZodError);
  }
  await assert.rejects(runDorisPilot(prepared, { ...target, snapshot_ref: "wrong" }, "plan", open), /must match/);
});

const fields = (names: string[]) => names.map(name => ({ name, type: 253 }));
// Run the same DbSession / BusinessAnalysis / DorisEngine stack as the CLI, replacing the socket only.
function socket(t: TestContext, options: { build?: string; failExplainAt?: number; streamLoss?: boolean } = {}, fixture?: Awaited<ReturnType<typeof data>>) {
  const selects: string[] = [], buffered: string[] = [];
  const calls = { closes: 0, destroys: 0, explains: 0 };
  t.mock.method(DorisEngine.prototype as unknown as { newConnection(): Promise<unknown> }, "newConnection", async () => ({
    end: (done: () => void) => { calls.closes++; done(); },
    destroy: () => { calls.destroys++; },
    promise: () => ({ query: async ({ sql }: { sql: string }) => {
      buffered.push(sql);
      if (sql === "SELECT VERSION()") return [[["5.7.99"]], []];
      if (sql === "SELECT DATABASE()") return [[["sales"]], []];
      if (sql === "SHOW GRANTS") return [[["", "internal.sales: Select_priv"]], fields(["Roles", "DatabasePrivs"])];
      if (sql.startsWith("SHOW SESSION VARIABLES")) return [[["query_timeout", "30"]], []];
      if (sql.includes("information_schema.SCHEMATA")) return [[["sales"]], []];
      if (/information_schema\.(TABLES|COLUMNS)/.test(sql)) {
        const name = /TABLE_NAME = '([^']+)'/.exec(sql)?.[1];
        const columns = {
          orders: { tenant: "int", oid: "int", paid_on: "date", cid: "int", state: "string", amount: "decimal(20,2)" },
          refunds: { tenant: "int", oid: "int", rid: "int", posted_on: "date", state: "string", amount: "decimal(20,2)" },
          channels: { tenant: "int", cid: "int", label: "string" },
          utc_events: { id: "int", occurred_at: "datetime" },
        }[name!];
        assert.ok(columns, `unexpected table: ${name}`);
        return [sql.includes(".TABLES") ? [["table", null, null]] : Object.entries(columns).map(([col, type]) => [col, type, "NO"]), []];
      }
      if (sql.startsWith("SHOW CREATE TABLE")) return [[["", "CREATE TABLE fixture (...)\nDUPLICATE KEY(unknown)"]], []];
      if (sql.startsWith("EXPLAIN ")) {
        if (++calls.explains === options.failExplainAt) throw Object.assign(new Error("sensitive mock parser failure"), { code: "ER_PARSE_ERROR" });
        return [[["OlapScanNode\npartitions=1/3"]], []];
      }
      assert.fail(`unexpected buffered SQL: ${sql}`);
    } }),
    query: ({ sql }: { sql: string }) => {
      selects.push(sql);
      const version = sql === "SELECT @@version_comment AS doris_version";
      if (!version && options.streamLoss) return {};
      return { stream: () => {
        async function* rows(emitFields: (names: string[]) => void) {
          const payload = version ? { rows: [[options.build ?? build]], fields: [{ name: "doris_version" }] } : await queryFrozen(fixture!, sql);
          emitFields(payload.fields.map(f => f.name));
          for (const row of payload.rows) yield row.map(value => value instanceof Date ? value.toISOString().slice(0, 10) : value);
        }
        const stream: Readable = Readable.from(rows(names => stream.emit("fields", fields(names))));
        return stream;
      } };
    },
  }));
  return { calls, selects, buffered };
}

it("fails the build check even if the protocol version is 5.7.99, without inspecting a business table", async t => {
  const s = socket(t, { build: "doris version doris-unapproved" });
  await assert.rejects(runDorisPilot(prepareDorisPilot(await readManifest()), target, "plan"), /does not match the authorized build/);
  assert.deepEqual(s.selects, ["SELECT @@version_comment AS doris_version"]);
  assert.equal(s.buffered.some(sql => sql.includes("information_schema.TABLES") || sql.startsWith("EXPLAIN")), false);
  assert.equal(s.calls.closes, 1);
});

it("previews text plans without a business SELECT and shows enforce blocking absent estimates", async t => {
  const s = socket(t);
  const report = await runDorisPilot(prepareDorisPilot(await readManifest()), target, "plan");
  assert.equal(report.ok, true);
  assert.equal(report.historical_stream_failure, "not_tested");
  assert.equal(s.selects.length, 1); // build probe only
  assert.equal(s.calls.closes, 1);
  for (const test of report.cases) {
    assert.equal(test.requests.filter(e => e.kind === "preflight" && e.phase === "started").length, 2);
    assert.equal((test.plan as { policy: { blocked: boolean } }).policy.blocked, true);
  }
});

it("runs the frozen smoke through the real stack and detects an independent reference mismatch", async t => {
  const fixture = await data();
  t.after(() => fixture.close());
  await fixture.exec(`CREATE TABLE sales.utc_events(id int, occurred_at timestamp);
    INSERT INTO sales.utc_events VALUES (1,'2026-11-18 15:59:59'), (2,'2026-11-18 16:00:00'), (3,'2026-11-19 15:59:59'),
      (4,'2026-11-19 16:00:00'), (5,'2026-11-20 16:00:00')`);
  const s = socket(t, {}, fixture);
  const manifest = await readManifest();
  const report = await runDorisPilot(prepareDorisPilot(manifest), target, "smoke");
  assert.equal(report.ok, true, JSON.stringify(report.cases.map(c => [c.id, c.error, c.differences])));
  assert.deepEqual(report.cases.map(c => c.verification), ["verified", "verified", "verified", "unconfirmed"]);
  assert.equal(s.selects.length, 5);
  assert.equal(s.calls.closes, 1);
  for (const c of report.cases) assert.equal(c.requests.filter(r => r.kind === "source_select" && r.phase === "started").length, 1);
  manifest.cases = [manifest.cases[0]];
  manifest.cases[0].days[0].total = "340";
  const mismatch = await runDorisPilot(prepareDorisPilot(manifest), target, "smoke");
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.cases[0]?.differences, ["2026-11-01: total"]);
});

it("does not dispatch after a failed first EXPLAIN or a failed warn-mode preflight", async t => {
  const manifest = await readManifest();
  manifest.cases = [manifest.cases[0]];
  const prepared = prepareDorisPilot(manifest);
  for (const failExplainAt of [1, 2]) {
    const badPlan = socket(t, { failExplainAt });
    const refused = await runDorisPilot(prepared, target, "smoke");
    assert.equal(refused.ok, false);
    assert.equal(badPlan.calls.explains, failExplainAt);
    assert.equal(badPlan.selects.length, 1);
    assert.equal(refused.cases[0]?.requests.some(r => r.kind === "control"), false);
    assert.doesNotMatch(JSON.stringify(refused), /sensitive mock/);
    t.mock.restoreAll();
  }
});

it("stops subsequent compatibility cases after simulated stream loss", async t => {
  const lost = socket(t, { streamLoss: true });
  const stopped = await runDorisPilot(prepareDorisPilot(await readManifest()), target, "smoke");
  assert.equal(stopped.ok, false);
  assert.equal(stopped.historical_stream_failure, "not_tested");
  assert.equal(stopped.cases.length, 1);
  assert.equal(stopped.cases[0]?.error, "SESSION_UNAVAILABLE");
  assert.equal(lost.selects.length, 2);
  assert.ok(lost.calls.destroys >= 1);
});
