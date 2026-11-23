import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { analysisOptions } from "../analysis/options.js";
import { TtlCache } from "../analysis/cache.js";
import { MetadataPool } from "../analysis/pool.js";
import { rowMasker, checkLocalSize } from "../analysis/privacy.js";
import { localSql, ownedResult, summarize } from "../analysis/results.js";
import { SnapshotStore } from "../analysis/snapshots.js";
import { reusableSql } from "../analysis/reuse.js";
import type { AppConfig, BudgetConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ResultMeta, ResultStore } from "../results/store.js";
import { createEngine } from "./engines/index.js";
import type { Engine, ObjectFilter, QueryStats } from "./engines/base.js";
import { describeEngine, getProfile, type EngineProfile } from "./engines/profiles.js";
import { guardSql, type GuardResult } from "./guard.js";
import { resolveQueryTimeout } from "./query-timeout.js";
import type {
  ConnectionConfig,
  ObjectDescription,
  ObjectRef,
  ProfileResult,
  SessionCapabilities,
  WorkspaceAccess,
} from "./types.js";

export interface DatasetRecord {
  ownerSessionId?: string;
  name: string;
  kind: "view" | "table";
  sql: string;
  createdAt: string;
  status: "building" | "ready" | "failed";
  rows?: number | null;
  error?: string;
}

export interface SessionSnapshot {
  session_id: string;
  engine: string;
  database: string;
  host: string;
  label?: string;
  environment: string;
  capabilities: SessionCapabilities;
  queries: { used: number; limit: number };
  datasets: number;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  status: "ready" | "closed" | "unavailable";
  unavailable_reason?: string;
}

interface AuditEvent {
  ts: string;
  session_id: string;
  action: string;
  outcome: "ok" | "denied" | "error" | "cancelled";
  code?: string;
  sql?: string;
  duration_ms?: number;
  rows?: number;
  bytes?: number;
  truncated?: string;
  result_id?: string;
  dataset?: string;
  detail?: string;
}

const QUERYABLE_KINDS = new Set(["table", "view", "materialized_view", "foreign_table"]);
const DATASET_NAME = /^ds_[a-z0-9_]{1,37}$/;

export class DbSession {
  private engine!: Engine;
  private capabilities!: SessionCapabilities;
  private allowedScopes: string[] = [];
  private defaultCatalogScope = "";
  private readonly datasets = new Map<string, DatasetRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private queryCount = 0;
  private metadataCache!: TtlCache;
  private metadataPool?: MetadataPool<Engine>;
  private readonly queryCache = new Map<string, { id: string; at: number }>();
  /** Tracks the in-flight statement so cancel() can classify it instead of reporting success. */
  private activeQuery?: { controller: AbortController; cancelled: boolean };
  private closed = false;
  private cancellation?: Promise<boolean>;
  private lastUsedAt = new Date();
  private readonly auditFile: string;
  private readonly registryFile: string;

  private constructor(
    readonly id: string,
    private readonly config: ConnectionConfig,
    private readonly app: AppConfig,
    private readonly results: ResultStore,
    readonly createdAt = new Date(),
  ) {
    this.auditFile = join(app.dataDir, "audit", `${id}.ndjson`);
    this.registryFile = join(app.dataDir, "sessions", `${id}.datasets.json`);
  }

  static async open(options: {
    config: ConnectionConfig;
    app: AppConfig;
    results: ResultStore;
    sessionId?: string;
  }): Promise<DbSession> {
    const session = new DbSession(
      options.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      options.config,
      options.app,
      options.results,
    );
    await mkdir(join(options.app.dataDir, "audit"), { recursive: true });
    await mkdir(join(options.app.dataDir, "sessions"), { recursive: true });
    await session.bootstrap();
    return session;
  }

  private async bootstrap(): Promise<void> {
    this.engine = createEngine(this.config, {
      allowPrivateNetwork: this.app.allowPrivateNetwork,
      applicationName: `data-agent/${this.id}`,
    });
    try {
      await this.engine.connect();
    } catch (error) {
      await this.engine.close().catch(() => undefined);
      // Policy refusals (READONLY_UNVERIFIED, CONNECTION_TARGET_BLOCKED) must keep their code so a
      // client can branch on it instead of parsing a wrapped CONNECTION_FAILED message.
      if (error instanceof AppError) throw error;
      throw new AppError("CONNECTION_FAILED", `Database connection failed: ${(error as Error).message}`);
    }

    const settings = analysisOptions(this.app);
    this.metadataCache = new TtlCache(settings.metadataTtlMs);
    this.metadataPool = new MetadataPool(settings.metadataConcurrency, async () => {
      const engine = createEngine(
        { ...this.config, workspace: undefined },
        { allowPrivateNetwork: this.app.allowPrivateNetwork, applicationName: `data-agent/${this.id}/metadata` },
      );
      try {
        await engine.connect();
        return engine;
      } catch (error) {
        await engine.close().catch(() => undefined);
        throw error;
      }
    });
    const profile = this.engine.profile;
    const readOnly = this.engine.readOnlyStatus();
    this.allowedScopes = await this.engine.listScopes().catch(() => []);
    const defaultScope = await this.engine.defaultScope().catch(() => this.config.database);
    this.defaultCatalogScope = defaultScope;
    if (!this.allowedScopes.includes(defaultScope)) this.allowedScopes.unshift(defaultScope);

    const environment = this.config.environment;
    let workspaceAccess: WorkspaceAccess = "none";
    let workspaceNote: string | undefined;
    let workspaceName: string | undefined;
    let workspaceMode: "schema" | "database" | undefined;

    if (this.config.workspace) {
      workspaceName = this.config.workspace.name;
      workspaceMode = this.config.workspace.mode ?? profile.workspaceMode;
      const probe = await this.engine.probeWorkspace(workspaceName, workspaceMode);
      if (probe.ok) {
        workspaceAccess = environment === "production" ? "views_only" : "tables_and_views";
      } else {
        workspaceNote = probe.note ?? "workspace is not writable";
        workspaceAccess = "none";
      }
    } else {
      workspaceNote =
        "No database workspace configured; source querying, local analysis and chart artifacts remain available.";
    }

    this.capabilities = {
      engine: this.config.engine,
      engineLabel: profile.label,
      engineProfile: describeEngine(profile),
      environment,
      serverVersion: readOnly.serverVersion,
      readOnlyProof: readOnly.proof,
      notes: readOnly.notes,
      sourceAccess: "read_only",
      queryTimeout: resolveQueryTimeout(this.config, this.app.budgets, this.engine.queryTimeoutStatus?.()),
      timezone: this.config.timezone,
      timezoneNote:
        "Timezone is an analysis intent, not a database session override. Use explicit SQL timezone conversion; verify source timestamps and watermarks.",
      workspaceAccess,
      workspaceName,
      workspaceMode,
      workspaceNote,
      features: {
        cancel: this.engine.cancelSupported,
        explain: profile.explain !== "none",
        explainAnalyze: profile.explainAnalyze,
        streaming: true,
      },
    };

    await this.loadRegistry().catch(() => undefined);
    await this.audit({
      action: "session_open",
      outcome: "ok",
      detail: `engine=${this.config.engine} environment=${environment} workspace=${workspaceAccess} proof=${readOnly.proof} version=${readOnly.serverVersion || "unknown"}`,
    });
  }

  get capabilitiesView(): SessionCapabilities {
    return this.capabilities;
  }

  /** Per-call limits may shorten, never extend the connection policy. */
  private queryTimeoutMs(requested?: number): number {
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0))
      throw new AppError("INVALID_INPUT", "Query timeout must be a positive finite number");
    const policy = this.capabilities?.queryTimeout ?? resolveQueryTimeout(this.config, this.app.budgets);
    return Math.max(1, Math.floor(Math.min(requested ?? policy.effectiveMs, policy.effectiveMs)));
  }

  /** Declared capability table for this session's engine (data, not code). */
  get engineProfile(): EngineProfile {
    return getProfile(this.config.engine);
  }

  get scopesView(): string[] {
    return this.allowedScopes;
  }

  get expiresAt(): Date {
    return new Date(this.lastUsedAt.getTime() + this.app.sessionTtlMs);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  snapshot(): SessionSnapshot {
    return {
      session_id: this.id,
      engine: this.config.engine,
      database: this.config.database,
      host: this.config.host,
      label: this.config.label,
      environment: this.capabilities.environment,
      capabilities: this.capabilities,
      queries: { used: this.queryCount, limit: this.app.budgets.maxQueries },
      datasets: this.datasets.size,
      created_at: this.createdAt.toISOString(),
      last_used_at: this.lastUsedAt.toISOString(),
      expires_at: this.expiresAt.toISOString(),
      status: this.closed ? "closed" : this.engine.unavailableReason ? "unavailable" : "ready",
      unavailable_reason: this.engine.unavailableReason,
    };
  }

  touch(): void {
    this.lastUsedAt = new Date();
  }

  /** Serialises every database operation for this pinned connection. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError("SESSION_CLOSED", "Session is closed"));
    const guarded = () => {
      if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
      if (this.engine.unavailableReason) throw new AppError("SESSION_UNAVAILABLE", this.engine.unavailableReason);
      return operation();
    };
    const next = this.tail.then(guarded, guarded);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.touch();
    return next;
  }

  private guard(sql: string, options?: { requireSelect?: boolean }): GuardResult {
    if (this.capabilities === undefined) throw new AppError("INTERNAL_ERROR", "Session is not ready");
    const result = guardSql(sql, {
      engine: this.config.engine,
      allowedScopes: this.allowedScopes,
      workspace: this.capabilities.workspaceName,
    });
    if (!result.ok) {
      throw new AppError(
        (result.code ?? "SQL_FORBIDDEN_STATEMENT") as never,
        result.reason ?? "SQL statement is not allowed",
      );
    }
    const explainAllowed = !options?.requireSelect;
    if (options?.requireSelect && result.kind !== "select") {
      throw new AppError("SOURCE_WRITE_FORBIDDEN", "dataset_create accepts a SELECT (or WITH ... SELECT) query only");
    }
    if (!explainAllowed && result.kind !== "select") {
      throw new AppError("INVALID_INPUT", "Only SELECT statements are allowed here");
    }
    return result;
  }

  async query(
    sql: string,
    options: {
      label?: string;
      taskId?: string;
      maxRows?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      reuse?: boolean;
      skipPreflight?: boolean;
    } = {},
  ): Promise<ResultMeta> {
    return this.run(() =>
      this.results.serializeWrite(this.id, async () => {
        const guard = this.guard(sql);
        const timeoutMs = this.queryTimeoutMs(options.timeoutMs);
        if (guard.kind === "explain")
          throw new AppError(
            "INVALID_INPUT",
            "Use query_explain for plans; EXPLAIN ANALYZE must be explicitly requested and budgeted there",
          );
        const settings = analysisOptions(this.app);
        const key = JSON.stringify([sql, options.maxRows ?? this.app.budgets.maxResultRows]);
        const reusable = guard.kind === "select" && reusableSql(sql, this.engineProfile.dialect);
        if (options.reuse && reusable) {
          const hit = this.queryCache.get(key);
          if (hit && Date.now() - hit.at < settings.resultCacheTtlMs) {
            const meta = await this.results.get(hit.id);
            if (meta && !meta.error) {
              await this.audit({ action: "query_cache_hit", outcome: "ok", result_id: meta.id });
              return { ...meta, cached: true, cacheAgeMs: Date.now() - hit.at };
            }
          }
        }
        const warnings = [...guard.warnings];
        if (!options.skipPreflight && settings.preflight !== "off" && guard.kind === "select") {
          const inspection = await this.preflightDirect(sql, options.signal);
          warnings.push(...inspection.warnings);
          if (inspection.blocked && settings.preflight === "enforce")
            throw new AppError(
              "QUERY_COST_EXCEEDED",
              "Estimated scan/cost exceeds policy. Add selective filters/partition pruning or reduce the workload; LIMIT alone does not limit scans.",
              inspection as unknown as Record<string, unknown>,
            );
        }
        this.assertQueryBudget();
        const usage = (await this.results.listBySession(this.id)).reduce((n, r) => n + r.bytes, 0);
        if (usage >= settings.maxSessionBytes)
          throw new AppError(
            "RESULT_ROW_LIMIT",
            "Session storage quota exhausted; create a new session or purge unneeded history.",
          );
        const writer = await this.results.create({
          sessionId: this.id,
          sql,
          previewRows: this.app.budgets.previewRows,
          taskId: options.taskId,
          label: options.label,
        });
        const controller = new AbortController();
        const state = { controller, cancelled: false };
        this.activeQuery = state;
        let timedOut = false;
        const onOuterAbort = () => {
          state.cancelled = true;
          controller.abort();
          void this.cancelEngine();
        };
        options.signal?.addEventListener("abort", onOuterAbort, { once: true });
        if (options.signal?.aborted) onOuterAbort();
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          void this.cancelEngine();
        }, timeoutMs);
        timer.unref?.();

        try {
          if (state.cancelled) throw new AppError("QUERY_CANCELLED", "Query cancelled before execution");
          this.queryCount += 1;
          const stats: QueryStats = await this.engine.query(
            sql,
            {
              timeoutMs,
              maxRows: Math.min(options.maxRows ?? this.app.budgets.maxResultRows, this.app.budgets.maxResultRows),
              maxBytes: Math.min(this.app.budgets.maxResultBytes, settings.maxSessionBytes - usage),
              maxCellChars: 8_000,
              signal: controller.signal,
            },
            (() => {
              let mask = (row: unknown[]) => row;
              let outputBytes = 0;
              return {
                onColumns: (columns: import("./engines/base.js").ColumnMeta[]) => {
                  writer.setColumns(
                    columns.map((c) => {
                      const mode = settings.masking.find((r) => r.column.toLowerCase() === c.name.toLowerCase())?.mode;
                      return mode && mode !== "deny" ? { ...c, type: "text" } : c;
                    }),
                  );
                  mask = rowMasker(columns, settings.masking, this.id);
                },
                onRow: (row: unknown[]) => {
                  const masked = mask(row);
                  outputBytes += Buffer.byteLength(JSON.stringify(masked)) + 1;
                  if (outputBytes > Math.min(this.app.budgets.maxResultBytes, settings.maxSessionBytes - usage))
                    throw new AppError("RESULT_ROW_LIMIT", "Stored output exceeds byte quota after masking");
                  return writer.append(masked);
                },
              };
            })(),
          );
          if (state.cancelled) {
            throw new AppError("QUERY_CANCELLED", "Query cancelled by caller");
          }
          if (timedOut) throw new AppError("QUERY_TIMEOUT", `Query exceeded ${timeoutMs} ms and was cancelled`);
          const meta = await writer.finish(stats.truncated, stats.durationMs);
          meta.warnings = [...warnings, ...stats.warnings];
          meta.timezone = this.config.timezone;
          meta.privacy = {
            masked_columns: meta.columns
              .filter((c) => settings.masking.some((r) => r.column.toLowerCase() === c.name.toLowerCase()))
              .map((c) => c.name),
            boundary: "output-name-defense-in-depth",
          };
          await this.results.saveMeta(meta);
          if (reusable) {
            this.queryCache.set(key, { id: meta.id, at: Date.now() });
            if (this.queryCache.size > 128) this.queryCache.delete(this.queryCache.keys().next().value!);
          }
          await this.audit({
            action: "query_execute",
            outcome: "ok",
            sql,
            duration_ms: stats.durationMs,
            rows: stats.rowCount,
            bytes: stats.bytes,
            truncated: stats.truncated,
            result_id: meta.id,
          });
          return meta;
        } catch (error) {
          const message = (error as Error).message;
          await writer.abort(message).catch(() => undefined);
          const cancelled = state.cancelled || Boolean(options.signal?.aborted);
          const code = timedOut ? "QUERY_TIMEOUT" : cancelled ? "QUERY_CANCELLED" : "INTERNAL_ERROR";
          await this.audit({
            action: "query_execute",
            outcome: cancelled ? "cancelled" : "error",
            code,
            sql,
            detail: message,
          });
          if (cancelled) throw new AppError("QUERY_CANCELLED", "Query cancelled by caller");
          if (timedOut) throw new AppError("QUERY_TIMEOUT", `Query exceeded ${timeoutMs} ms and was cancelled`);
          if (error instanceof AppError) throw error;
          if (guard.kind === "select") throw new AppError("INTERNAL_ERROR", `Query failed: ${message}`);
          throw new AppError("INTERNAL_ERROR", `Statement failed: ${message}`);
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onOuterAbort);
          await this.cancellation;
          if (this.activeQuery === state) this.activeQuery = undefined;
        }
      }),
    );
  }

  async explain(
    sql: string,
    options: { timeoutMs?: number; analyze?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ result: ResultMeta; plan: Awaited<ReturnType<Engine["explain"]>> }> {
    return this.run(() =>
      this.results.serializeWrite(this.id, async () => {
        this.assertQueryBudget();
        this.guard(sql, { requireSelect: true });
        if (options.analyze && analysisOptions(this.app).preflight !== "off") {
          const estimate = await this.preflightDirect(sql, options.signal);
          if (estimate.blocked && analysisOptions(this.app).preflight === "enforce")
            throw new AppError("QUERY_COST_EXCEEDED", "EXPLAIN ANALYZE estimate exceeds policy", estimate);
        }
        this.assertQueryBudget();
        if (!this.capabilities.features.explain || (options.analyze && !this.capabilities.features.explainAnalyze))
          throw new AppError("FEATURE_UNSUPPORTED", "Requested plan capability is unavailable on this engine");
        this.queryCount += 1;
        const timeoutMs = this.queryTimeoutMs(options.timeoutMs);
        const plan = await this.planDirect(sql, timeoutMs, options.analyze, options.signal);
        const settings = analysisOptions(this.app);
        const usage = (await this.results.listBySession(this.id)).reduce((sum, r) => sum + r.bytes, 0);
        if (usage + Buffer.byteLength(JSON.stringify([plan.planText])) + 1 > settings.maxSessionBytes)
          throw new AppError("RESULT_ROW_LIMIT", "Plan exceeds remaining session result storage quota");
        const writer = await this.results.create({
          sessionId: this.id,
          sql,
          previewRows: 5,
          label: "EXPLAIN",
        });
        const row = [plan.planText];
        writer.setColumns([{ name: "plan", type: "json" }]);
        await writer.append(row);
        const meta = await writer.finish("none", 0);
        await this.audit({ action: "query_explain", outcome: "ok", sql, result_id: meta.id });
        return { result: meta, plan };
      }),
    );
  }

  private catalogScopeNames(): string[] {
    return [...new Set([...this.allowedScopes, this.capabilities.workspaceName].filter((scope): scope is string => Boolean(scope)))];
  }

  async catalogScopes(refresh = false) {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    const scopes = this.catalogScopeNames();
    // Counts are advisory UI metadata: an engine error must not make the tree inaccessible
    // or turn an unknown count into zero. Cache only successful counts.
    const table_counts = await this.metadataCache.get("catalog-table-counts", () =>
      this.metadata((engine) => engine.catalogTableCounts(scopes)), refresh).catch(() => null);
    return { scopes, default_scope: this.defaultCatalogScope, table_counts };
  }

  async catalogPage(options: Omit<ObjectFilter, "scopes" | "includeMatchDetails" | "limit" | "offset"> & {
    limit: number;
    offset: number;
    refresh: boolean;
  }) {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    const { refresh, limit, offset, ...filter } = options;
    const scopes = this.catalogScopeNames();
    const allowed = filter.schema === undefined ? scopes : scopes.filter((scope) => scope === filter.schema);
    const objects = await this.metadataCache.get(`catalog-page:${JSON.stringify({ filter, limit, offset })}`, () =>
      this.metadata(async (engine) => {
        const listed = allowed.length ? await engine.listObjects({
          ...filter, scopes: allowed, limit: limit + 1, offset, includeMatchDetails: true,
        }) : [];
        const visible = listed.filter((object) => allowed.includes(object.schema));
        await this.audit({ action: "catalog_search", outcome: "ok",
          detail: JSON.stringify({ schema: filter.schema, search: filter.search, offset, returned: Math.min(limit, visible.length) }) });
        return visible;
      }), refresh);
    return { objects: objects.slice(0, limit), nextOffset: objects.length > limit ? offset + limit : null };
  }

  async catalogSearch(options: {
    search?: string;
    searchColumns?: boolean;
    refresh?: boolean;
    schema?: string;
    kinds?: Array<"table" | "view" | "materialized_view" | "foreign_table" | "sequence">;
    limit?: number;
  }): Promise<ObjectRef[]> {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    return this.metadataCache.get(
      `catalog:${JSON.stringify({ ...options, refresh: undefined })}`,
      () =>
        this.metadata(async (engine) => {
          const objects = await engine.listObjects({
            search: options.search,
            searchColumns: options.searchColumns,
            schema: options.schema,
            kinds: options.kinds,
            limit: Math.max(1, Math.min(200, options.limit ?? 50)),
          });
          if (options.searchColumns && options.search) {
            const needle = options.search.toLowerCase();
            // Enrich only a bounded set; database-side filtering already searched the full catalog.
            for (const object of objects.slice(0, 12)) {
              if (!this.isInScope(object.schema)) continue;
              try {
                const described = await engine.describeObject(object.schema, object.name);
                object.matchedColumns = described.columns
                  .filter((c) => (c.name + " " + (c.comment ?? "")).toLowerCase().includes(needle))
                  .slice(0, 12)
                  .map((c) => ({ name: c.name, type: c.type, comment: c.comment }));
              } catch {
                /* metadata enrichment is best effort */
              }
            }
          }
          await this.audit({
            action: "catalog_search",
            outcome: "ok",
            detail: JSON.stringify({ search: options.search, schema: options.schema, returned: objects.length }),
          });
          return objects.filter((object) => this.isInScope(object.schema));
        }),
      options.refresh,
    );
  }

  async describe(schema: string | null, name: string, refresh = false): Promise<ObjectDescription> {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    return this.metadataCache.get(
      `describe:${JSON.stringify([schema, name])}`,
      () =>
        this.metadata(async (engine) => {
          const described = await engine.describeObject(schema, name);
          if (!this.isInScope(described.object.schema)) {
            throw new AppError(
              "SQL_SCOPE_VIOLATION",
              `Object ${described.object.schema}.${name} is outside the session scope`,
            );
          }
          await this.audit({
            action: "object_describe",
            outcome: "ok",
            detail: `${described.object.schema}.${name}`,
          });
          return described;
        }),
      refresh,
    );
  }

  async profile(
    schema: string | null,
    name: string,
    sampleRows = 50,
    timeoutMs?: number,
    method: "head" | "random" = "head",
  ): Promise<ProfileResult> {
    const result = await this.run(async () => {
      this.assertQueryBudget();
      this.queryCount++;
      const described = await this.engine.describeObject(schema, name);
      if (!this.isInScope(described.object.schema)) {
        throw new AppError(
          "SQL_SCOPE_VIOLATION",
          `Object ${described.object.schema}.${name} is outside the session scope`,
        );
      }
      if (!QUERYABLE_KINDS.has(described.object.kind)) {
        throw new AppError("INVALID_INPUT", `Cannot profile a ${described.object.kind}`);
      }
      if (method === "random" && this.capabilities.environment === "production")
        throw new AppError(
          "FEATURE_UNSUPPORTED",
          "Random ORDER BY sampling may scan/sort the full table and is disabled in production. Use a selective source query or head sample.",
        );
      const profile = await this.engine.profileObject(
        described.object.schema,
        name,
        Math.max(1, Math.min(200, sampleRows)),
        this.queryTimeoutMs(timeoutMs),
        method,
      );
      await this.audit({
        action: "data_profile",
        outcome: "ok",
        detail: `${described.object.schema}.${name} sample=${sampleRows}`,
      });
      const mask = rowMasker(described.columns, analysisOptions(this.app).masking, this.id);
      profile.columns.forEach((column, i) => {
        if (analysisOptions(this.app).masking.some((r) => r.column.toLowerCase() === column.name.toLowerCase())) {
          column.samples = column.samples.map((v) => mask(described.columns.map((_, j) => (j === i ? v : null)))[i]);
          column.min = undefined;
          column.max = undefined;
        }
      });
      return profile;
    });
    return result;
  }

  async readResult(resultId: string, offset: number, limit: number) {
    const meta = await this.results.get(resultId);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} was not found`);
    if (meta.sessionId !== this.id) throw new AppError("FORBIDDEN", "Result belongs to another session");
    if (meta.error) throw new AppError("RESULT_FAILED", `Query did not complete successfully: ${meta.error}`);
    const page = await this.results.read(resultId, offset, limit, this.app.budgets.cellChars);
    if (!page) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} was not found`);
    return page;
  }

  async resultSummary(id: string) {
    return summarize(this.results, await ownedResult(this.results, id, this.id), analysisOptions(this.app));
  }

  async resultSql(id: string, sql: string, allowPartial = false, taskId?: string) {
    return localSql(this.results, await ownedResult(this.results, id, this.id), sql, analysisOptions(this.app), {
      allowPartial,
      taskId,
    });
  }

  private get snapshots() {
    return new SnapshotStore(join(this.app.dataDir, "snapshots"));
  }
  async snapshotCreate(resultId: string, name: string) {
    return this.results.serializeWrite(this.id, async () => {
      const meta = await ownedResult(this.results, resultId, this.id);
      checkLocalSize(meta.rowCount, meta.bytes, analysisOptions(this.app));
      if (meta.truncated !== "none")
        throw new AppError("RESULT_FAILED", "Cannot pin an incomplete result as a local snapshot");
      return this.snapshots.create(this.id, resultId, name);
    });
  }
  async snapshotList() {
    return this.snapshots.list(this.id);
  }
  async snapshotDrop(id: string) {
    return this.results.serializeWrite(this.id, () => this.snapshots.drop(this.id, id));
  }
  async snapshotQuery(id: string, sql: string, taskId?: string) {
    const snapshot = (await this.snapshots.list(this.id)).find((s) => s.id === id);
    if (!snapshot) throw new AppError("NOT_FOUND", "Snapshot not found in this session");
    return this.resultSql(snapshot.result_id, sql, false, taskId);
  }

  async listResults(): Promise<ResultMeta[]> {
    return this.results.listBySession(this.id);
  }

  async createDataset(
    name: string,
    selectSql: string,
    kind: "view" | "table",
    taskId?: string,
  ): Promise<DatasetRecord> {
    return this.run(async () => {
      if (!DATASET_NAME.test(name)) {
        throw new AppError("DATASET_NAME_INVALID", "Dataset name must match ds_[a-z0-9_]{1,37} (lowercase)");
      }
      if (!this.capabilities.workspaceName || this.capabilities.workspaceAccess === "none") {
        throw new AppError(
          "WORKSPACE_UNAVAILABLE",
          this.capabilities.workspaceNote ?? "This session has no writable workspace",
        );
      }
      if (this.capabilities.environment === "production" && kind === "table") {
        throw new AppError(
          "WORKSPACE_PRODUCTION_VIEWS_ONLY",
          "Production sessions may create views only; persisted tables are not allowed",
        );
      }
      if (kind === "table" && this.capabilities.workspaceAccess !== "tables_and_views") {
        throw new AppError("WORKSPACE_PRODUCTION_VIEWS_ONLY", "This session may create views only");
      }
      if (this.datasets.size >= this.app.budgets.maxDatasets) {
        throw new AppError("DATASET_LIMIT_REACHED", `Session already has ${this.datasets.size} datasets`);
      }
      this.guard(selectSql, { requireSelect: true });

      const existing = this.datasets.get(name);
      if (existing?.status === "ready") {
        throw new AppError("DATASET_ALREADY_EXISTS", `Dataset ${name} already exists; drop it or pick another name`);
      }
      const live = await this.engine.listDatasets(this.capabilities.workspaceName);
      if (live.some((dataset) => dataset.name === name)) {
        throw new AppError("DATASET_ALREADY_EXISTS", `Workspace object ${name} already exists; choose another name`);
      }

      const record: DatasetRecord = {
        ownerSessionId: this.id,
        name,
        kind,
        sql: selectSql,
        createdAt: new Date().toISOString(),
        status: "building",
      };
      this.datasets.set(name, record);
      await this.saveRegistry();
      await this.audit({
        action: "dataset_create",
        outcome: "ok",
        dataset: `${name} (${kind})`,
        sql: selectSql,
        detail: "building",
      });

      try {
        if (kind === "view") {
          await this.engine.createView(this.capabilities.workspaceName, name, selectSql);
        } else {
          await this.engine.createTable(this.capabilities.workspaceName, name, selectSql);
        }
        record.status = "ready";
        this.metadataCache?.clear();
        this.queryCache.clear();
        await this.saveRegistry();
        await this.audit({ action: "dataset_create", outcome: "ok", dataset: `${name} (${kind})`, detail: "ready" });
        return record;
      } catch (error) {
        record.status = "failed";
        record.error = (error as Error).message;
        await this.saveRegistry();
        // Never delete on an uncertain CREATE outcome: the conflicting object may belong to
        // another session. Failed records do not grant deletion rights.
        await this.audit({
          action: "dataset_create",
          outcome: "error",
          code: "DATASET_FAILED",
          dataset: name,
          detail: record.error,
        });
        throw new AppError("DATASET_FAILED", `Could not create dataset ${name}: ${record.error}`);
      }
    });
  }

  async listDatasets(): Promise<Array<DatasetRecord & { exists: boolean }>> {
    return this.run(async () => {
      const workspace = this.capabilities.workspaceName;
      const live = workspace ? await this.engine.listDatasets(workspace).catch(() => []) : [];
      const liveNames = new Set(live.map((dataset) => dataset.name));
      const output: Array<DatasetRecord & { exists: boolean }> = [];
      for (const record of this.datasets.values()) {
        output.push({ ...record, exists: liveNames.has(record.name) });
        liveNames.delete(record.name);
      }
      return output.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async dropDataset(name: string): Promise<void> {
    return this.run(async () => {
      const record = this.datasets.get(name);
      const live = this.capabilities.workspaceName
        ? await this.engine.listDatasets(this.capabilities.workspaceName).catch(() => [])
        : [];
      const object = live.find((dataset) => dataset.name === name);
      if (!record || record.ownerSessionId !== this.id || record.status !== "ready") {
        throw new AppError(
          "FORBIDDEN",
          `Dataset ${name} is not an owned, successfully created dataset of this session`,
        );
      }
      if (!object) throw new AppError("NOT_FOUND", `Dataset ${name} was not found`);
      if (!DATASET_NAME.test(name)) {
        throw new AppError("DATASET_NAME_INVALID", "Only service-created ds_* datasets can be dropped");
      }
      const kind = record.kind;
      await this.engine.dropDataset(this.capabilities.workspaceName!, name, kind);
      this.datasets.delete(name);
      this.metadataCache?.clear();
      this.queryCache.clear();
      await this.saveRegistry();
      await this.audit({ action: "dataset_drop", outcome: "ok", dataset: `${name} (${kind})` });
    });
  }

  async cancel(): Promise<boolean> {
    const active = this.activeQuery;
    if (active) {
      active.cancelled = true;
      active.controller.abort();
    }
    if (!this.engine.cancelSupported) {
      await this.audit({ action: "query_cancel", outcome: "error", detail: "engine declares no cancellation channel" });
      return false;
    }
    const cancelled = await this.cancelEngine();
    await this.audit({ action: "query_cancel", outcome: cancelled ? "ok" : "error", detail: String(cancelled) });
    return cancelled;
  }

  private cancelEngine(): Promise<boolean> {
    if (this.cancellation) return this.cancellation;
    const pending = this.engine.cancel().catch(() => false);
    this.cancellation = pending;
    void pending.finally(() => {
      if (this.cancellation === pending) this.cancellation = undefined;
    });
    return pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => undefined);
    await this.metadataPool?.close();
    this.metadataCache?.clear();
    this.queryCache.clear();
    await this.engine.close().catch(() => undefined);
    await this.audit({ action: "session_close", outcome: "ok" });
  }

  private metadata<T>(operation: (engine: Engine) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError("SESSION_CLOSED", "Session is closed"));
    this.touch();
    if (this.engine.unavailableReason)
      return Promise.reject(new AppError("SESSION_UNAVAILABLE", this.engine.unavailableReason));
    return this.metadataPool ? this.metadataPool.run(operation) : this.run(() => operation(this.engine));
  }

  private async planDirect(sql: string, timeoutMs: number, analyze = false, signal?: AbortSignal) {
    const state = { controller: new AbortController(), cancelled: false };
    this.activeQuery = state;
    let timedOut = false;
    let cancelling: Promise<boolean> | undefined;
    const interrupt = () => {
      state.controller.abort();
      cancelling ??= this.cancelEngine();
    };
    const cancel = () => {
      state.cancelled = true;
      interrupt();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, timeoutMs);
    try {
      if (signal?.aborted) throw new AppError("QUERY_CANCELLED", "Plan inspection cancelled");
      const plan = await this.engine.explain(
        sql,
        { timeoutMs, maxRows: 10, maxBytes: 1_000_000, maxCellChars: 8000, signal: state.controller.signal },
        analyze,
      );
      if (state.cancelled) throw new AppError("QUERY_CANCELLED", "Plan inspection cancelled");
      if (timedOut) throw new AppError("QUERY_TIMEOUT", "Plan inspection timed out");
      return plan;
    } catch (error) {
      if (state.cancelled) throw new AppError("QUERY_CANCELLED", "Plan inspection cancelled");
      if (timedOut) throw new AppError("QUERY_TIMEOUT", "Plan inspection timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      await cancelling;
      await this.cancellation;
      if (this.activeQuery === state) this.activeQuery = undefined;
    }
  }

  private async preflightDirect(sql: string, signal?: AbortSignal) {
    const settings = analysisOptions(this.app);
    if (!this.capabilities.features?.explain)
      return {
        supported: false,
        blocked: settings.preflight === "enforce",
        warnings: ["Cost estimates unavailable on this engine; timeout/row/byte limits still apply."],
      };
    this.assertQueryBudget();
    this.queryCount++;
    try {
      const plan = await this.planDirect(sql, this.queryTimeoutMs(5000), false, signal);
      const unknown = plan.estimatedScanRows == null && plan.estimatedCost == null;
      const blocked =
        (plan.estimatedScanRows ?? 0) > settings.maxEstimatedScanRows ||
        (plan.estimatedCost ?? 0) > settings.maxEstimatedCost ||
        (unknown && settings.preflight === "enforce");
      await this.audit({
        action: "query_preflight",
        outcome: blocked ? "denied" : "ok",
        sql,
        detail: JSON.stringify({ estimated_scan_rows: plan.estimatedScanRows, estimated_cost: plan.estimatedCost }),
      });
      return {
        supported: true,
        blocked,
        estimated_scan_rows: plan.estimatedScanRows,
        estimated_cost: plan.estimatedCost,
        estimated_output_rows: plan.estimatedRows,
        warnings: [
          ...plan.warnings,
          ...(blocked ? ["Estimated source scan/cost exceeds policy. LIMIT does not bound scan cost."] : []),
          "EXPLAIN estimates are advisory; query completion time is not data freshness.",
        ],
      };
    } catch (error) {
      if (error instanceof AppError && ["QUERY_CANCELLED", "QUERY_TIMEOUT"].includes(error.code)) throw error;
      if (this.engine.unavailableReason) throw new AppError("SESSION_UNAVAILABLE", this.engine.unavailableReason);
      return {
        supported: true,
        blocked: settings.preflight === "enforce",
        warnings: [`Cost preflight failed: ${(error as Error).message}`],
      };
    }
  }

  async preflight(sql: string, signal?: AbortSignal) {
    return this.run(async () => {
      this.guard(sql, { requireSelect: true });
      return this.preflightDirect(sql, signal);
    });
  }

  async describeMany(objects: Array<{ schema?: string; name: string }>) {
    if (objects.length > 20) throw new AppError("INVALID_INPUT", "Describe at most 20 objects per batch");
    return Promise.all(
      objects.map(async (object) => {
        try {
          return { ...object, description: await this.describe(object.schema ?? null, object.name) };
        } catch (error) {
          return { ...object, error: (error as Error).message };
        }
      }),
    );
  }

  async catalogOverview(schema?: string, limit = 12) {
    const objects = await this.catalogSearch({ schema, limit: Math.min(50, limit) });
    const descriptions = await this.describeMany(objects.slice(0, 20));
    const tables = descriptions.filter((d): d is typeof d & { description: ObjectDescription } => "description" in d);
    const relationships: Array<{
      from: string;
      to: string;
      target_columns?: string[];
      evidence: string;
      verified: boolean;
    }> = [];
    for (const { description: d } of tables) {
      for (const fk of d.foreignKeys)
        relationships.push({
          from: `${d.object.schema}.${d.object.name}(${fk.columns.join(",")})`,
          to: fk.references,
          target_columns: fk.referencedColumns,
          evidence: "declared foreign key; still validate JOIN cardinality and filtering",
          verified: true,
        });
      for (const col of d.columns.filter((c) => c.name.endsWith("_id"))) {
        const stem = col.name.slice(0, -3);
        for (const { description: target } of tables)
          if (target !== d && [stem, stem + "s"].includes(target.object.name) && target.primaryKey.length === 1)
            relationships.push({
              from: `${d.object.schema}.${d.object.name}.${col.name}`,
              to: `${target.object.schema}.${target.object.name}.${target.primaryKey[0]}`,
              evidence: "name heuristic only; validate uniqueness/cardinality before JOIN",
              verified: false,
            });
      }
    }
    return {
      tables: tables.map(({ description: d }) => ({
        ...d.object,
        columns: d.columns.length,
        primary_key: d.primaryKey,
        partition_key: d.partitionKey,
        time_columns: d.columns.filter((c) => /date|time/i.test(c.type)).map((c) => c.name),
        large_table: (d.object.rowEstimate ?? 0) > 1_000_000,
      })),
      relationships,
      scope: "bounded catalog sample, not a complete inventory",
      failures: descriptions.filter((d) => "error" in d),
    };
  }

  private assertQueryBudget(): void {
    if (this.queryCount >= this.app.budgets.maxQueries) {
      throw new AppError(
        "QUERY_BUDGET_EXCEEDED",
        `Session query budget of ${this.app.budgets.maxQueries} is exhausted`,
      );
    }
  }

  private isInScope(schema: string): boolean {
    if (this.allowedScopes.includes(schema)) return true;
    if (this.capabilities.workspaceName === schema) return true;
    // The account can only see what it can read; report an explicit denial instead of guessing.
    return this.allowedScopes.length === 0;
  }

  private async loadRegistry(): Promise<void> {
    try {
      const raw = await readFile(this.registryFile, "utf8");
      const records = JSON.parse(raw) as DatasetRecord[];
      for (const record of records) {
        if (record.ownerSessionId !== this.id) continue;
        if (record.status === "building") {
          record.status = "failed";
          record.error = "creation interrupted";
        }
        this.datasets.set(record.name, record);
      }
    } catch {
      /* first open of this session */
    }
  }

  private async saveRegistry(): Promise<void> {
    await writeFile(this.registryFile, JSON.stringify([...this.datasets.values()], null, 2), "utf8");
  }

  private async audit(event: Omit<AuditEvent, "ts" | "session_id">): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), session_id: this.id, ...event })}\n`;
    await appendFile(this.auditFile, line, "utf8").catch(() => undefined);
  }
}
