// Offline by default. See docs/Doris试点放行手册.md before using --plan or --smoke.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { compileMetric, validateCatalog } from "./doris-pilot/planner.js";
import { BusinessAnalysis, BusinessCatalogStore } from "./doris-pilot/service.js";
import { readBusinessView } from "../src/business/view.js";
import { CatalogDraft, Day, Id, MetricRequest, parseResultValueRef } from "../src/business/types.js";
import type { AppConfig } from "../src/config.js";
import { guardSql } from "../src/db/guard.js";
import { DbSession, type DbOperation } from "../src/db/session.js";
import type { SourceRequest } from "../src/db/source-operations.js";
import { ConnectionConfig } from "../src/db/types.js";
import { AppError } from "../src/errors.js";
import { ResultStore } from "../src/results/store.js";

const text = z.string().trim().min(1).max(200);
const decimal = z.string().max(100).regex(/^-?\d+(?:\.\d+)?$/);
const value = decimal.nullable();
const expectedDay = z.strictObject({
  day: Day, total: value, baseline: value, change: value,
  numerator: value.optional(), denominator: value.optional(),
  groups: z.array(z.strictObject({ label: text, total: value, baseline: value, change: value })).max(200).optional(),
  deductions: z.array(decimal).max(200).optional(),
});
const Manifest = z.strictObject({
  database: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,63}$/u), snapshot_ref: text,
  reference_ref: text, catalog: CatalogDraft,
  cases: z.array(z.strictObject({
    id: Id, request: MetricRequest, status: z.enum(["verified", "limited", "unconfirmed"]), empty: z.boolean().optional(),
    days: z.array(expectedDay).min(1).max(366),
  })).min(1).max(20),
});
const Target = z.strictObject({
  authorization_ref: text, snapshot_ref: text,
  version_comment: z.string().trim().regex(/\bdoris\b/i).max(200),
  connection: ConnectionConfig.extend({
    engine: z.literal("doris"), environment: z.literal("non_production"),
    allowWeakReadOnly: z.literal(false).default(false), workspace: z.never().optional(),
    businessContextIds: z.never().optional(),
  }).strict(),
});

type Manifest = z.infer<typeof Manifest>;
type Report = Awaited<ReturnType<typeof readBusinessView>>;
type Mode = "plan" | "smoke";
const versionSql = "SELECT @@version_comment AS doris_version";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
class PilotCheckError extends Error {}

export function prepareDorisPilot(input: unknown) {
  const manifest = Manifest.parse(input);
  validateCatalog(manifest.catalog);
  if (manifest.catalog.tables.some(t => t.schema !== manifest.database)) throw new PilotCheckError("Every table must belong to the frozen database");
  const ids = new Set<string>();
  const version = { id: "biz_pilot_check", at: "", reviewer: "Isolated compatibility check only", catalog: manifest.catalog };
  const cases = manifest.cases.map(test => {
    if (ids.has(test.id)) throw new PilotCheckError(`Duplicate case: ${test.id}`);
    ids.add(test.id);
    const days = test.request.grain === "period" ? 1 : (Date.parse(test.request.window.end) - Date.parse(test.request.window.start)) / 86400_000;
    if (test.days.length !== days || test.days.some((entry, i) => entry.day !== new Date(Date.parse(test.request.window.start) + i * 86400_000).toISOString().slice(0, 10))) {
      throw new PilotCheckError(`${test.id}: reference must include every requested day in order`);
    }
    const plan = compileMetric(version, test.request);
    const guard = guardSql(plan.sql, { engine: "doris", allowedScopes: [manifest.database] });
    if (!guard.ok || !guard.parsed || guard.kind !== "select") throw new PilotCheckError(`${test.id}: generated SQL did not pass a parsed read-only guard`);
    return { ...test, sql: plan.sql, sql_sha256: hash(plan.sql) };
  });
  return { manifest, cases, manifest_sha256: hash(JSON.stringify(manifest)) };
}

// Compare decimals as strings, not floats: e.g. 70.000 and 70 are the same, but adjacent BIGINTs are not.
function normalize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const raw = v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "").replace(/^(-?)0+(?=\d)/, "$1");
  return raw === "-0" ? "0" : raw;
}

export async function compareDorisReport(test: Manifest["cases"][number], report: Report, readCell: (row: number, column: number) => Promise<unknown>) {
  const differences: string[] = [];
  if (report.status !== test.status) differences.push(`status: expected ${test.status}, got ${report.status}`);
  if (test.empty !== undefined && report.empty !== test.empty) differences.push("empty result flag");
  if (report.days.length !== test.days.length) differences.push("day count");
  for (const [i, expected] of test.days.entries()) {
    const day = report.days[i];
    if (!day || day.day !== expected.day) { differences.push(`${expected.day}: missing or out of order`); continue; }
    const compare = async (field: string, want: string | null, cell: { value: string; ref: string } | null | undefined) => {
      if (normalize(want) !== normalize(cell?.value)) differences.push(`${day.day}: ${field}`);
      if (!cell) return;
      const ref = parseResultValueRef(cell.ref);
      const stored = ref?.id === report.result_id ? await readCell(ref.row, ref.column) : undefined;
      if ((typeof stored !== "string" && typeof stored !== "number") || normalize(String(stored)) !== normalize(cell.value)) differences.push(`${day.day}: ${field} evidence`);
    };
    await compare("total", expected.total, day.current?.value);
    await compare("baseline", expected.baseline, day.comparison?.value);
    if (normalize(day.change) !== normalize(expected.change)) differences.push(`${day.day}: change`);
    if (expected.numerator !== undefined) await compare("numerator", expected.numerator, day.current?.numerator);
    if (expected.denominator !== undefined) await compare("denominator", expected.denominator, day.current?.denominator);
    if (expected.groups) {
      if (day.channels.length !== expected.groups.length) differences.push(`${day.day}: group count`);
      for (const group of expected.groups) {
        const found = day.channels.filter(ch => ch.label === group.label);
        if (found.length !== 1) { differences.push(`${day.day}: group ${group.label} missing or ambiguous`); continue; }
        await compare(`${group.label} total`, group.total, found[0]!.current?.value);
        await compare(`${group.label} baseline`, group.baseline, found[0]!.comparison?.value);
        if (normalize(found[0]!.change) !== normalize(group.change)) differences.push(`${day.day}: ${group.label} change`);
      }
    }
    if (expected.deductions) {
      if (!isDeepStrictEqual(day.deductions.map(c => normalize(c.value)).sort(), expected.deductions.map(normalize).sort())) differences.push(`${day.day}: deductions`);
      for (const cell of day.deductions) await compare("deduction", cell.value, cell);
    }
  }
  return differences;
}

function appConfig(dataDir: string, mode: Mode): AppConfig {
  return {
    host: "127.0.0.1", port: 0, apiToken: "", dataDir, sessionTtlMs: 600_000, maxSessions: 1,
    allowPrivateNetwork: true, allowModelEdit: false, env: "development",
    model: { provider: "unused", modelId: "unused", thinkingLevel: "off" },
    budgets: { maxTurns: 1, maxQueries: 61, taskTimeoutMs: 60_000, queryTimeoutMs: 15_000, maxQueryTimeoutMs: 15_000,
      maxResultRows: 2_000, previewRows: 1, cellChars: 200, maxResultBytes: 4_000_000, maxDatasets: 0,
      maxChartRows: 2_000, maxChartCells: 2_000, maxArtifactsPerTask: 1 },
    analysis: { preflight: mode === "plan" ? "enforce" : "warn" },
  };
}

export async function runDorisPilot(prepared: ReturnType<typeof prepareDorisPilot>, targetInput: unknown, mode: Mode, open: typeof DbSession.open = DbSession.open) {
  const target = Target.parse(targetInput);
  const { manifest, cases } = prepared;
  if (target.snapshot_ref !== manifest.snapshot_ref || target.connection.database !== manifest.database) throw new PilotCheckError("Target must match the manifest's frozen snapshot and database");
  const dataDir = await mkdtemp(join(tmpdir(), "data-agent-doris-pilot-"));
  const results = new ResultStore(join(dataDir, "results"));
  let store: BusinessCatalogStore | undefined, db: DbSession | undefined;
  try {
    store = new BusinessCatalogStore(join(dataDir, "catalog.sqlite"));
    db = await open({ config: { ...target.connection, timezone: manifest.catalog.timezone }, app: appConfig(dataDir, mode), results });
    const session = db;
    const caps = db.capabilitiesView;
    if (caps.engine !== "doris" || caps.readOnlyProof !== "grants" || caps.workspaceAccess !== "none" || caps.environment !== "non_production") throw new PilotCheckError("A direct read-only non-production Doris session is required");
    const setupRequests: SourceRequest[] = [], setupOperations: DbOperation[] = [];
    const business = new BusinessAnalysis(store, "isolated-doris-pilot", db, results);
    const { actualBuild, published } = await db.observeOperations(e => setupOperations.push(e), async () => {
      await session.businessPermissionKey();
      // VERSION() may return 5.7.99 independent of the server build. Verify before any business SQL.
      const build = await session.query(versionSql, { maxRows: 1, skipPreflight: true });
      const actualBuild = String(build.preview[0]?.[0] ?? "").trim();
      if (build.rowCount !== 1 || build.truncated !== "none" || actualBuild !== target.version_comment) throw new PilotCheckError("Doris @@version_comment does not match the authorized build");
      const draft = await business.draft(manifest.catalog);
      const published = await business.publish(draft.id, "Compatibility check only; not a business sign-off");
      if (mode === "smoke") await business.enable(true);
      return { actualBuild, published };
    }, e => setupRequests.push(e));
    const evidence = [];
    for (const test of cases) {
      const requests: SourceRequest[] = [], operations: DbOperation[] = [];
      const controller = new AbortController();
      const result: { id: string; sql_sha256: string; ok: boolean; error?: string; differences?: string[]; plan?: unknown; result_id?: string; verification?: string; select_ms?: number; rows?: number } = { id: test.id, sql_sha256: test.sql_sha256, ok: false };
      try {
        await db.observeOperations(e => {
          operations.push(e);
          // Abort after planDirect has settled, not during driver dispatch (which could send KILL).
          if (e.kind === "preflight" && e.code) controller.abort();
        }, async () => {
          if (mode === "plan") {
            const policy = await session.preflight(test.sql);
            // Explain failure is not a valid cost-policy result. An unknown but valid text plan is.
            if (!requests.some(e => e.kind === "preflight" && e.phase === "finished" && !e.code)) throw new Error("EXPLAIN unavailable or failed");
            const { plan } = await session.explain(test.sql, { timeoutMs: 5_000 });
            if (plan.planText === "(empty plan)") throw new Error("EXPLAIN returned an empty plan");
            result.plan = { policy, ...plan };
          } else {
            // Explicit warn-mode compatibility smoke on the bounded fixture. Never run after a failed EXPLAIN.
            const { plan } = await session.explain(test.sql, { timeoutMs: 5_000 });
            result.plan = plan;
            if (plan.planText === "(empty plan)") throw new Error("EXPLAIN returned an empty plan");
            const report = await business.analyze(test.request, { expectedVersion: published.id, signal: controller.signal });
            result.result_id = report.result_id;
            result.verification = report.status;
            const meta = await results.get(report.result_id);
            if (!meta || hash(meta.sql) !== test.sql_sha256) throw new Error("Saved result SQL differs from planned SQL");
            if (meta.truncated !== "none") throw new AppError("RESULT_ROW_LIMIT", "Compatibility smoke was truncated");
            result.select_ms = meta.durationMs; result.rows = meta.rowCount;
            const rows: unknown[][] = [];
            for await (const row of results.iterateRows(meta.id)) rows.push(row);
            result.differences = await compareDorisReport(test, report, async (row, column) => rows[row]?.[column]);
          }
        }, e => requests.push(e));
        const select = requests.filter(e => e.kind === "source_select" && e.phase === "started").length;
        const finishes = requests.filter(e => e.phase === "finished");
        result.ok = select === (mode === "plan" ? 0 : 1) && (result.differences?.length ?? 0) === 0 &&
          finishes.length * 2 === requests.length && !finishes.some(e => e.code);
      } catch (error) {
        // Driver errors can echo connection details, SQL or source values. Do not include messages.
        result.error = error instanceof AppError ? error.code : "PILOT_CHECK_FAILED";
      }
      evidence.push({ ...result, requests, operations });
      if (session.snapshot().status !== "ready") break;
    }
    return { mode, snapshot_ref: manifest.snapshot_ref, manifest_sha256: prepared.manifest_sha256, reference_ref: manifest.reference_ref, authorization_ref: target.authorization_ref,
      version_comment: actualBuild, read_only_proof: caps.readOnlyProof, timezone: manifest.catalog.timezone, sql_timeout_ms: caps.queryTimeout?.effectiveMs,
      historical_stream_failure: "not_tested", ok: evidence.length === cases.length && evidence.every(r => r.ok),
      setup: { requests: setupRequests, operations: setupOperations }, cases: evidence };
  } finally {
    try { await db?.close(); }
    finally {
      try { store?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

async function main() {
  const [path, flag, target, ...rest] = process.argv.slice(2);
  if (!path || rest.length || (flag && !["--plan", "--smoke"].includes(flag)) || (flag && !target)) throw new PilotCheckError("Usage: node --import tsx scripts/doris-pilot-check.ts MANIFEST.json [--plan|--smoke PRIVATE_TARGET.json]");
  const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const prepared = prepareDorisPilot(await json(path));
  const report = flag ? await runDorisPilot(prepared, await json(target!), flag === "--plan" ? "plan" : "smoke") : {
    mode: "offline", ok: true, snapshot_ref: prepared.manifest.snapshot_ref, manifest_sha256: prepared.manifest_sha256,
    cases: prepared.cases.map(({ id, sql_sha256 }) => ({ id, sql_sha256 })),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Exclude input values, secrets, paths and raw driver errors from CLI output.
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.code}`).join("; ")
      : error instanceof AppError ? error.code : error instanceof PilotCheckError ? error.message : "Invalid manifest/target, setup assertion failed, or required file unavailable";
    console.error(message);
    process.exitCode = 1;
  });
}
