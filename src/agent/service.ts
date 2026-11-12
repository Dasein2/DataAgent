import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { ConnectionConfig, SessionCapabilities } from "../db/types.js";
import { AppError } from "../errors.js";
import { DbSession } from "../db/session.js";
import { ResultStore, type ResultPage } from "../results/store.js";
import { EventBroker, type TaskEvent } from "./events.js";
import { createModelHandle, type ModelHandle } from "./model.js";
import { AnalysisSession, type TaskRecord } from "./runtime.js";
import { HistoryStore, connectionKey } from "./history.js";
import { ProfileStore } from "../db/profiles-store.js";

export interface ConnectionTestResult {
  ok: boolean;
  engine: ConnectionConfig["engine"];
  database: string;
  environment: ConnectionConfig["environment"];
  capabilities: SessionCapabilities;
  scopes: string[];
  serverVersion?: string;
  latencyMs: number;
}

export function callerKey(token: string, headerIdentity?: string): string {
  const identity = (headerIdentity ?? "").trim().toLowerCase().slice(0, 64);
  if (identity && /^[a-z0-9._:-]+$/.test(identity)) return identity;
  return createHash("sha256").update(token || "anonymous").digest("hex").slice(0, 16);
}

/**
 * Owns the model runtime, the result store, and the live analysis sessions.
 * Credentials arrive per request and live only inside a session's engine.
 */
export class AnalysisService {
  private readonly sessions = new Map<string, AnalysisSession>();
  private readonly broker: EventBroker;
  readonly history: HistoryStore;
  readonly profiles: ProfileStore;
  private sweeper?: ReturnType<typeof setInterval>;
  private closed = false;

  private constructor(
    private readonly app: AppConfig,
    private readonly model: ModelHandle,
    readonly results: ResultStore,
  ) {
    this.history = new HistoryStore(join(app.dataDir, "history"));
    this.broker = new EventBroker(5_000, this.history);
    this.profiles = new ProfileStore(join(app.dataDir, "connections.json"), app.profileSecretKey);
  }

  static async create(app: AppConfig): Promise<AnalysisService> {
    const model = await createModelHandle(app);
    const service = new AnalysisService(app, model, new ResultStore(`${app.dataDir}/results`));
    service.sweeper = setInterval(() => void service.sweepExpired(), 30_000);
    service.sweeper.unref?.();
    return service;
  }

  get config(): AppConfig {
    return this.app;
  }

  /** Credentials were resolved at startup; without this every task ends in TASK_FAILED. */
  get modelReady(): boolean {
    return this.model.hasAuth;
  }

  // ------------------------------------------------------------- connections

  async testConnection(config: ConnectionConfig): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    const db = await DbSession.open({ config, app: this.app, results: this.results });
    try {
      const snapshot = db.snapshot();
      return {
        ok: true,
        engine: snapshot.engine as ConnectionConfig["engine"],
        database: snapshot.database,
        environment: snapshot.environment as ConnectionConfig["environment"],
        capabilities: snapshot.capabilities,
        scopes: db.scopesView,
        serverVersion: snapshot.capabilities.serverVersion,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      await db.close();
    }
  }

  // ---------------------------------------------------------------- sessions

  async createSession(config: ConnectionConfig, ownerKey: string, sessionId?: string): Promise<AnalysisSession> {
    if (this.closed) throw new AppError("INTERNAL_ERROR", "Service is shutting down");
    if (sessionId) {
      const previous = this.history.getSession(sessionId, ownerKey);
      if (previous.connectionKey !== connectionKey(config)) {
        throw new AppError("INVALID_INPUT", "Reconnect must use the same database, account, environment and workspace as the original session");
      }
      const active = this.sessions.get(sessionId);
      if (active?.isBusy) throw new AppError("INVALID_INPUT", "Cancel the running task before reconnecting");
      if (active) await this.closeSession(sessionId, ownerKey);
    }
    await this.sweepExpired();
    if (this.sessions.size >= this.app.maxSessions) {
      throw new AppError(
        "SESSION_LIMIT_REACHED",
        `Service already holds ${this.sessions.size} sessions (limit ${this.app.maxSessions}); close one or retry later`,
      );
    }
    const session = await AnalysisSession.create({
      config,
      app: this.app,
      results: this.results,
      model: this.model,
      broker: this.broker,
      ownerKey,
      history: this.history,
      sessionId,
    });
    this.sessions.set(session.id, session);
    this.history.saveSession(ownerKey, session.snapshot(), connectionKey(config));
    return session;
  }

  getSession(sessionId: string, ownerKey: string): AnalysisSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerKey !== ownerKey) {
      throw new AppError("NOT_FOUND", `Session ${sessionId} not found`);
    }
    session.touch();
    return session;
  }

  listSessions(ownerKey: string) {
    const snapshots = new Map(this.history.listSessions(ownerKey).map((snapshot) => [snapshot.session_id, snapshot]));
    for (const session of this.sessions.values()) {
      if (session.ownerKey === ownerKey) snapshots.set(session.id, session.snapshot());
    }
    return [...snapshots.values()];
  }

  sessionSnapshot(sessionId: string, ownerKey: string) {
    const session = this.sessions.get(sessionId);
    if (session) return this.getSession(sessionId, ownerKey).snapshot();
    return this.history.getSession(sessionId, ownerKey).snapshot;
  }

  async listResults(sessionId: string, ownerKey: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    return this.results.listBySession(sessionId);
  }

  async closeSession(sessionId: string, ownerKey: string): Promise<void> {
    const session = this.getSession(sessionId, ownerKey);
    this.sessions.delete(sessionId);
    await session.close();
  }

  // ------------------------------------------------------------------- tasks

  findTask(taskId: string, ownerKey: string): { session?: AnalysisSession; task: TaskRecord } {
    for (const session of this.sessions.values()) {
      if (session.ownerKey !== ownerKey) continue;
      const task = session.listTasks().find((candidate) => candidate.id === taskId);
      if (task) return { session, task };
    }
    return { task: this.history.getTask(taskId, ownerKey) };
  }

  watchTask(taskId: string, ownerKey: string, fn: (event: TaskEvent) => void, afterSeq = 0): () => void {
    this.findTask(taskId, ownerKey);
    for (const event of this.broker.list(taskId, afterSeq)) fn(event);
    return this.broker.subscribe(taskId, fn);
  }

  // ----------------------------------------------------------------- results

  async readResult(resultId: string, ownerKey: string, offset: number, limit: number): Promise<ResultPage> {
    const meta = await this.results.get(resultId);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} not found`);
    this.history.getSession(meta.sessionId, ownerKey);
    if (meta.error) throw new AppError("RESULT_FAILED", `Query did not complete successfully: ${meta.error}`);
    const page = await this.results.read(resultId, offset, limit, this.app.budgets.cellChars);
    if (!page) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} not found`);
    return page;
  }

  // --------------------------------------------------------------- lifecycle

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const expired = session.expiresAt.getTime() <= now;
      if (!expired || session.isBusy) continue;
      this.sessions.delete(id);
      await session.close().catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
