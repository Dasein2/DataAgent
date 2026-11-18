import { PGlite } from "@electric-sql/pglite";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors.js";
import type { ResultMeta, ResultStore } from "../results/store.js";
import { validateLocalSql } from "./local-guard.js";
import type { AnalysisOptions } from "./options.js";
import { checkLocalSize } from "./privacy.js";
import { TtlCache } from "./cache.js";

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const summaryCache = new TtlCache(300_000, 16);

export async function ownedResult(store: ResultStore, id: string, sessionId: string): Promise<ResultMeta> {
  const meta = await store.get(id);
  if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${id} not found`);
  if (meta.sessionId !== sessionId) throw new AppError("FORBIDDEN", "Result belongs to another session");
  if (meta.error) throw new AppError("RESULT_FAILED", "Result did not complete successfully");
  return meta;
}

/** Bounded streaming statistics. Numeric approximations never replace original decimal strings. */
export async function summarize(store: ResultStore, meta: ResultMeta, limits: AnalysisOptions) {
  checkLocalSize(meta.rowCount, meta.bytes, limits);
  if (meta.columns.length > 100)
    throw new AppError("RESULT_ROW_LIMIT", "Summary supports at most 100 columns; project fewer columns first");
  return summaryCache.get(store.directory + ":" + meta.sessionId + ":" + meta.id, async () => {
    const stats = meta.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nulls: 0,
      distinct: new Set<string>(),
      distinct_capped: false,
      numeric: 0,
      min: Infinity,
      max: -Infinity,
      sample: [] as number[],
      counts: new Map<string, number>(),
      incomplete_cells: 0,
    }));
    let count = 0;
    for await (const row of store.iterateRows(meta.id)) {
      count++;
      row.forEach((v, i) => {
        const s = stats[i];
        if (!s) return;
        if (v == null) {
          s.nulls++;
          return;
        }
        if (typeof v === "object" && (v as { truncated?: boolean }).truncated) s.incomplete_cells++;
        const serialized = JSON.stringify(v);
        if (serialized.length > 512) {
          s.incomplete_cells++;
          return;
        }
        const key = serialized;
        if (s.distinct.size < 1024) s.distinct.add(key);
        else if (!s.distinct.has(key)) s.distinct_capped = true;
        if (s.counts.has(key) || s.counts.size < 128) s.counts.set(key, (s.counts.get(key) ?? 0) + 1);
        if ((typeof v === "number" || (typeof v === "string" && NUMERIC.test(v))) && Number.isFinite(Number(v))) {
          const n = Number(v);
          s.numeric++;
          s.min = Math.min(s.min, n);
          s.max = Math.max(s.max, n);
          if (s.sample.length < 2048) s.sample.push(n);
        }
      });
    }
    return {
      result_id: meta.id,
      rows: count,
      truncated: meta.truncated,
      executed_at: meta.createdAt,
      timezone: meta.timezone ?? "unspecified",
      scope: "stored result only; not source-table statistics or data watermark",
      columns: stats.map((s) => {
        s.sample.sort((a, b) => a - b);
        return {
          name: s.name,
          type: s.type,
          nulls: s.nulls,
          null_rate: count ? s.nulls / count : null,
          distinct: s.distinct.size,
          distinct_is_lower_bound: s.distinct_capped,
          incomplete_cells: s.incomplete_cells,
          numeric_count: s.numeric,
          min_approx: s.numeric ? s.min : null,
          max_approx: s.numeric ? s.max : null,
          head_sample_median_approx: s.sample.length ? s.sample[Math.floor(s.sample.length / 2)] : null,
          top: [...s.counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, occurrences]) => ({
              value: JSON.parse(value),
              occurrences,
            })),
          top_scope: "exact counts for at most first 128 distinct values; not guaranteed global top-K",
        };
      }),
    };
  });
}

/** Isolated in-memory PostgreSQL dialect. No extensions/files/network/user SQL functions. */
export async function localSqlInProcess(
  store: ResultStore,
  meta: ResultMeta,
  sql: string,
  limits: AnalysisOptions,
  options: { taskId?: string; allowPartial?: boolean; outputId?: string } = {},
) {
  checkLocalSize(meta.rowCount, meta.bytes, limits);
  if (meta.truncated !== "none" && !options.allowPartial)
    throw new AppError(
      "CHART_RESULT_TRUNCATED",
      "Local analysis refuses incomplete input by default. Rerun a reduced source query or explicitly allow_partial.",
    );
  if (new Set(meta.columns.map((c) => c.name)).size !== meta.columns.length)
    throw new AppError("INVALID_INPUT", "Alias duplicate columns in source SQL before local analysis");
  validateLocalSql(sql);
  if (meta.columns.length > 100)
    throw new AppError("RESULT_ROW_LIMIT", "Local analysis accepts at most 100 input columns");
  const usage = (await store.listBySession(meta.sessionId)).reduce((n, r) => n + r.bytes, 0);
  if (usage >= limits.maxSessionBytes) throw new AppError("RESULT_ROW_LIMIT", "Session storage quota exhausted");
  const outputLimits = {
    ...limits,
    maxLocalBytes: Math.min(limits.maxLocalBytes, limits.maxSessionBytes - usage),
  };
  const db = new PGlite();
  const started = Date.now();
  try {
    await db.waitReady;
    const types = meta.columns.map((c) =>
      /^(?:(?:tiny|small|medium|big)?int[248]?|integer|numeric|decimal|float[48]?|double(?: precision)?|real)(?:\s*\(|\s+unsigned|$)/i.test(
        c.type,
      )
        ? "numeric"
        : /bool/i.test(c.type)
          ? "boolean"
          : "text",
    );
    await db.exec(`CREATE TABLE data (${meta.columns.map((c, i) => `${quote(c.name)} ${types[i]}`).join(",")});`);
    let batch: unknown[][] = [];
    const insert = async () => {
      if (!batch.length) return;
      const args = batch.flatMap((row) =>
        row.map((v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v))),
      );
      await db.query(
        `INSERT INTO data VALUES ${batch.map((_, r) => "(" + meta.columns.map((_, c) => "$" + (r * meta.columns.length + c + 1)).join(",") + ")").join(",")}`,
        args,
      );
      batch = [];
    };
    for await (const row of store.iterateRows(meta.id)) {
      if (row.some((v) => v && typeof v === "object" && (v as { truncated?: boolean }).truncated === true))
        throw new AppError(
          "RESULT_FAILED",
          "Local analysis refuses cell-level truncated input; select shorter/typed fields in source SQL",
        );
      batch.push(row);
      if (batch.length * meta.columns.length >= 1000) await insert();
    }
    await insert();
    await db.exec(
      "SET statement_timeout='5s'; SET work_mem='8MB'; SET max_parallel_workers_per_gather=0; BEGIN READ ONLY;",
    );
    const cleanSql = sql.trim().replace(/;\s*$/, "");
    const result = await db.query<unknown[]>(
      `SELECT * FROM (${cleanSql}) AS local_result LIMIT ${limits.maxLocalRows + 1}`,
      [],
      { rowMode: "array", parsers: { 20: (v) => v, 1700: (v) => v } },
    );
    if (result.rows.length > limits.maxLocalRows)
      throw new AppError("RESULT_ROW_LIMIT", "Local SQL output exceeds row cap; aggregate further");
    const writer = await store.create({
      id: options.outputId,
      sessionId: meta.sessionId,
      taskId: options.taskId,
      sql: cleanSql,
      label: "Local SQL on " + meta.id,
      previewRows: 5,
    });
    try {
      // Numeric/int8 parsers preserve text before values reach JavaScript floating point.
      const fields = result.fields.map((f) => ({
        name: f.name,
        type: [20, 21, 23, 700, 701, 1700].includes(f.dataTypeID) ? "numeric" : "text",
      }));
      if (new Set(fields.map((f) => f.name)).size !== fields.length)
        throw new AppError("INVALID_INPUT", "Local query must alias duplicate output columns");
      const precise = result;
      writer.setColumns(fields);
      let bytes = 0;
      for (const raw of precise.rows) {
        const row = raw.map((v) => (v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v)));
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        checkLocalSize(precise.rows.length, bytes, outputLimits);
        await writer.append(row);
      }
      const output = await writer.finish(meta.truncated, Date.now() - started);
      output.lineage = {
        parent_result_id: meta.id,
        operation: "local_sql",
        parameters: {
          sql: cleanSql,
          input_complete: meta.truncated === "none",
        },
      };
      output.timezone = meta.timezone;
      output.privacy = meta.privacy;
      output.warnings = [
        "Computed from stored rows only; numeric columns preserve decimal text. This is not a fresh source query.",
      ];
      await store.saveMeta(output);
      return output;
    } catch (error) {
      await writer.abort((error as Error).message);
      throw error;
    }
  } finally {
    await db.close();
  }
}

let localTail: Promise<unknown> = Promise.resolve();
let queued = 0;
/** One killable isolated process at a time: WASM cannot block the HTTP event loop indefinitely. */
export function localSql(
  store: ResultStore,
  meta: ResultMeta,
  sql: string,
  limits: AnalysisOptions,
  options: { taskId?: string; allowPartial?: boolean } = {},
): Promise<ResultMeta> {
  validateLocalSql(sql);
  checkLocalSize(meta.rowCount, meta.bytes, limits);
  if (queued >= 8)
    return Promise.reject(
      new AppError("TASK_QUEUE_FULL", "Local analysis queue is full; retry after current analyses finish"),
    );
  queued++;
  const run = () =>
    new Promise<ResultMeta>((resolve, reject) => {
      const js = new URL("./local-worker.js", import.meta.url);
      const source = !existsSync(fileURLToPath(js));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT|COMSPEC)$/i.test(key),
        ),
      );
      const child = fork(source ? new URL("./local-worker.ts", import.meta.url) : js, [], {
        env,
        execArgv: ["--max-old-space-size=256", ...(source ? ["--import", "tsx"] : [])],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const outputId = "res_" + randomUUID().replace(/-/g, "").slice(0, 20);
      let settled = false;
      const done = (error?: Error, result?: ResultMeta) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const exited =
          !child.pid || child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((r) => child.once("exit", () => r()));
        child.kill("SIGKILL");
        void exited
          .then(async () => {
            if (error) {
              await Promise.all([
                rm(store.metaPath(outputId), { force: true }),
                rm(store.dataPath(outputId), { force: true }),
              ]);
              reject(error);
            } else resolve(result!);
          })
          .catch(reject);
      };
      const timer = setTimeout(
        () => done(new AppError("QUERY_TIMEOUT", "Local analysis process exceeded 20 seconds and was terminated")),
        20_000,
      );
      child.on("error", (error) => done(error));
      child.on("exit", (code) => {
        if (!settled) done(new AppError("RESULT_FAILED", `Local analysis worker exited (${code})`));
      });
      child.on("message", (raw: any) => {
        if (raw.error) done(new AppError(raw.error.code ?? "RESULT_FAILED", raw.error.message, raw.error.details));
        else done(undefined, raw.result);
      });
      child.send({ root: store.directory, meta, sql, limits, options: { ...options, outputId } });
    });
  const serialized = () =>
    store.serializeWrite(meta.sessionId, async () => {
      if (!(await store.get(meta.id)))
        throw new AppError("RESULT_NOT_FOUND", "Input result was removed while local analysis was queued");
      return run();
    });
  const next = localTail.then(serialized, serialized).finally(() => {
    queued--;
  });
  localTail = next.catch(() => undefined);
  return next;
}
