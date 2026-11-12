import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, BudgetConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ResultMeta, ResultStore } from "../results/store.js";
import { createEngine } from "./engines/index.js";
import type { Engine, QueryStats } from "./engines/base.js";
import { describeEngine, getProfile, type EngineProfile } from "./engines/profiles.js";
import { guardSql, type GuardResult } from "./guard.js";
import type {
  ConnectionConfig,
  ObjectDescription,
  ObjectRef,
  ProfileResult,
  SessionCapabilities,
  WorkspaceAccess,
} from "./types.js";

export interface DatasetRecord {
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
  status: "ready" | "closed";
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
  private readonly datasets = new Map<string, DatasetRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private queryCount = 0;
  /** Tracks the in-flight statement so cancel() can classify it instead of reporting success. */
  private activeQuery?: { controller: AbortController; cancelled: boolean };
  private closed = false;
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

  static async open(
    options: {
      config: ConnectionConfig;
      app: AppConfig;
      results: ResultStore;
      sessionId?: string;
    },
  ): Promise<DbSession> {
    const session = new DbSession(options.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`, options.config, options.app, options.results);
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
      throw new AppError("CONNECTION_FAILED", `Database connection failed: ${(error as Error).message}`);
    }

    const profile = this.engine.profile;
    const readOnly = this.engine.readOnlyStatus();
    this.allowedScopes = await this.engine.listScopes().catch(() => []);
    const defaultScope = await this.engine.defaultScope().catch(() => this.config.database);
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
      workspaceNote = "No workspace configured; analysis artifacts are disabled.";
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
      status: this.closed ? "closed" : "ready",
    };
  }

  touch(): void {
    this.lastUsedAt = new Date();
  }

  /** Serialises every database operation for this pinned connection. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError("SESSION_CLOSED", "Session is closed"));
    const next = this.tail.then(operation, operation);
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
      throw new AppError(
        "SOURCE_WRITE_FORBIDDEN",
        "dataset_create accepts a SELECT (or WITH ... SELECT) query only",
      );
    }
    if (!explainAllowed && result.kind !== "select") {
      throw new AppError("INVALID_INPUT", "Only SELECT statements are allowed here");
    }
    return result;
  }

  async query(
    sql: string,
    options: { label?: string; taskId?: string; maxRows?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ResultMeta> {
    return this.run(async () => {
      this.assertQueryBudget();
      const guard = this.guard(sql);
      const writer = await this.results.create({
        sessionId: this.id,
        sql,
        previewRows: this.app.budgets.previewRows,
        taskId: options.taskId,
        label: options.label,
      });
      const timeoutMs = Math.min(options.timeoutMs ?? this.app.budgets.queryTimeoutMs, this.app.budgets.queryTimeoutMs);
      const controller = new AbortController();
      const state = { controller, cancelled: false };
      this.activeQuery = state;
      let timedOut = false;
      const onOuterAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void this.engine.cancel();
      }, timeoutMs);
      timer.unref?.();

      try {
        this.queryCount += 1;
        const stats: QueryStats = await this.engine.query(
          sql,
          {
            timeoutMs,
            maxRows: Math.min(options.maxRows ?? this.app.budgets.maxResultRows, this.app.budgets.maxResultRows),
            maxBytes: this.app.budgets.maxResultBytes,
            maxCellChars: 8_000,
            signal: controller.signal,
          },
          {
            onColumns: (columns) => writer.setColumns(columns),
            onRow: (row) => writer.append(row),
          },
        );
        if (state.cancelled) {
          throw new AppError("QUERY_CANCELLED", "Query cancelled by caller");
        }
        const meta = await writer.finish(stats.truncated, stats.durationMs);
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
        if (guard.kind === "select") throw new AppError("INTERNAL_ERROR", `Query failed: ${message}`);
        throw new AppError("INTERNAL_ERROR", `Statement failed: ${message}`);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onOuterAbort);
        if (this.activeQuery === state) this.activeQuery = undefined;
      }
    });
  }

  async explain(sql: string, options: { timeoutMs?: number } = {}): Promise<{ result: ResultMeta; plan: Awaited<ReturnType<Engine["explain"]>> }> {
    return this.run(async () => {
      this.assertQueryBudget();
      this.guard(sql);
      this.queryCount += 1;
      const timeoutMs = Math.min(options.timeoutMs ?? this.app.budgets.queryTimeoutMs, this.app.budgets.queryTimeoutMs);
      const plan = await this.engine.explain(sql, {
        timeoutMs,
        maxRows: 10,
        maxBytes: 1_000_000,
        maxCellChars: 8_000,
      });
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
    });
  }

  async catalogSearch(options: {
    search?: string;
    schema?: string;
    kinds?: Array<"table" | "view" | "materialized_view" | "foreign_table" | "sequence">;
    limit?: number;
  }): Promise<ObjectRef[]> {
    return this.run(async () => {
      const objects = await this.engine.listObjects({
        search: options.search,
        schema: options.schema,
        kinds: options.kinds,
        limit: Math.max(1, Math.min(200, options.limit ?? 50)),
      });
      await this.audit({
        action: "catalog_search",
        outcome: "ok",
        detail: JSON.stringify({ search: options.search, schema: options.schema, returned: objects.length }),
      });
      return objects.filter((object) => this.isInScope(object.schema));
    });
  }

  async describe(schema: string | null, name: string): Promise<ObjectDescription> {
    return this.run(async () => {
      const described = await this.engine.describeObject(schema, name);
      if (!this.isInScope(described.object.schema)) {
        throw new AppError("SQL_SCOPE_VIOLATION", `Object ${described.object.schema}.${name} is outside the session scope`);
      }
      await this.audit({
        action: "object_describe",
        outcome: "ok",
        detail: `${described.object.schema}.${name}`,
      });
      return described;
    });
  }

  async profile(schema: string | null, name: string, sampleRows = 50, timeoutMs?: number): Promise<ProfileResult> {
    return this.run(async () => {
      const described = await this.engine.describeObject(schema, name);
      if (!this.isInScope(described.object.schema)) {
        throw new AppError("SQL_SCOPE_VIOLATION", `Object ${described.object.schema}.${name} is outside the session scope`);
      }
      if (!QUERYABLE_KINDS.has(described.object.kind)) {
        throw new AppError("INVALID_INPUT", `Cannot profile a ${described.object.kind}`);
      }
      const profile = await this.engine.profileObject(
        described.object.schema,
        name,
        Math.max(1, Math.min(200, sampleRows)),
        timeoutMs ?? this.app.budgets.queryTimeoutMs,
      );
      await this.audit({
        action: "data_profile",
        outcome: "ok",
        detail: `${described.object.schema}.${name} sample=${sampleRows}`,
      });
      return profile;
    });
  }

  async readResult(resultId: string, offset: number, limit: number) {
    const meta = await this.results.get(resultId);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} was not found`);
    if (meta.sessionId !== this.id) throw new AppError("FORBIDDEN", "Result belongs to another session");
    const page = await this.results.read(resultId, offset, limit, this.app.budgets.cellChars);
    if (!page) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} was not found`);
    return page;
  }

  async listResults(): Promise<ResultMeta[]> {
    return this.results.listBySession(this.id);
  }

  async createDataset(name: string, selectSql: string, kind: "view" | "table", taskId?: string): Promise<DatasetRecord> {
    return this.run(async () => {
      if (!DATASET_NAME.test(name)) {
        throw new AppError(
          "DATASET_NAME_INVALID",
          "Dataset name must match ds_[a-z0-9_]{1,37} (lowercase)",
        );
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

      const record: DatasetRecord = {
        name,
        kind,
        sql: selectSql,
        createdAt: new Date().toISOString(),
        status: "building",
      };
      this.datasets.set(name, record);
      await this.saveRegistry();
      await this.audit({ action: "dataset_create", outcome: "ok", dataset: `${name} (${kind})`, sql: selectSql, detail: "building" });

      try {
        if (kind === "view") {
          await this.engine.createView(this.capabilities.workspaceName, name, selectSql);
        } else {
          await this.engine.createTable(this.capabilities.workspaceName, name, selectSql);
        }
        record.status = "ready";
        await this.saveRegistry();
        await this.audit({ action: "dataset_create", outcome: "ok", dataset: `${name} (${kind})`, detail: "ready" });
        return record;
      } catch (error) {
        record.status = "failed";
        record.error = (error as Error).message;
        await this.saveRegistry();
        // MySQL-family DDL is not transactional: remove a half-created object when possible.
        if (!this.engine.profile.transactionalDdl) {
          await this.engine.dropDataset(this.capabilities.workspaceName, name, kind).catch(() => undefined);
        }
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
      for (const dataset of live) {
        if (!DATASET_NAME.test(dataset.name)) continue;
        output.push({
          name: dataset.name,
          kind: dataset.kind,
          sql: "(created outside this session)",
          createdAt: dataset.createdAt ?? new Date().toISOString(),
          status: "ready",
          rows: null,
          exists: true,
        });
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
      if (!record && !object) throw new AppError("NOT_FOUND", `Dataset ${name} was not found`);
      if (!DATASET_NAME.test(name)) {
        throw new AppError("DATASET_NAME_INVALID", "Only service-created ds_* datasets can be dropped");
      }
      const kind = record?.kind ?? object?.kind ?? "view";
      await this.engine.dropDataset(this.capabilities.workspaceName!, name, kind);
      this.datasets.delete(name);
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
    const cancelled = await this.engine.cancel().catch(() => false);
    await this.audit({ action: "query_cancel", outcome: cancelled ? "ok" : "error", detail: String(cancelled) });
    return cancelled;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => undefined);
    await this.engine.close().catch(() => undefined);
    await this.audit({ action: "session_close", outcome: "ok" });
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
