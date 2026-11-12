import { createHash } from "node:crypto";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { redact, type AppConfig, type ModelConfig } from "../config.js";
import type { ConnectionConfig, SessionCapabilities } from "../db/types.js";
import { AppError } from "../errors.js";
import { DbSession } from "../db/session.js";
import { ResultStore, type ResultPage } from "../results/store.js";
import { EventBroker, type TaskEvent } from "./events.js";
import { createModelHandle, type ModelHandle } from "./model.js";
import { buildChannelCatalog, type ChannelCatalog } from "./channels.js";
import { readPiConfig } from "./pi-config.js";
import { AnalysisSession, type TaskRecord } from "./runtime.js";
import { HistoryStore, connectionKey } from "./history.js";
import { ProfileStore } from "../db/profiles-store.js";
import { DEFAULT_MODEL_API, SELECTABLE_MODEL_APIS, findModelApi } from "./model-apis.js";
import { ModelKeyStore, type KeyStoreState } from "./model-key-store.js";
import {
  ModelSettingsStore,
  THINKING_LEVELS,
  effectiveModel,
  mergeOverrides,
  type ModelOverrides,
  type ModelPatch,
  type ThinkingLevel,
} from "./model-settings.js";

/** One tiny completion; long enough for a slow gateway, short enough to not hang the console. */
const MODEL_TEST_TIMEOUT_MS = 20_000;

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

export interface ModelView {
  provider: string;
  model_id: string;
  api: string;
  base_url: string | null;
  thinking_level: ThinkingLevel;
  reasoning: boolean;
  context_window: number | null;
  max_tokens: number | null;
  input: string[];
  headers: Record<string, string>;
  has_api_key: boolean;
  /**
   * `console` is a key saved from the console (in `model-key.json`, scoped to this provider), `env`
   * one from the environment, `channel` one read from the operator's pi models.json, and `pi-auth`
   * one pi resolves from its own auth store.
   */
  api_key_source: "console" | "env" | "channel" | "pi-auth" | "none";
  /** Where a console-saved key lives, and whether it is encrypted there. */
  api_key_store: KeyStoreState;
  auth_path: string | null;
  /** False when no credential resolves, so every task would fail. */
  ready: boolean;
  editable: boolean;
  edit_disabled_reason: string | null;
  /** Console overrides that currently sit on top of the environment configuration. */
  overrides: ModelOverrides;
  override_sources: Record<string, "console" | "env">;
  /**
   * The environment baseline with its own defaults applied. The console diffs the form against this
   * so saving an untouched field does not pin it as an override that would shadow `.env` forever.
   */
  env_model: {
    provider: string;
    model_id: string;
    api: string;
    base_url: string | null;
    thinking_level: ThinkingLevel;
    reasoning: boolean | null;
    context_window: number | null;
    max_tokens: number | null;
  };
  /** Wire protocols offered in the console; the rest are known but need credentials we do not manage. */
  api_options: { id: string; label: string; note: string }[];  settings_status: "missing" | "ok" | "invalid";
  settings_path: string;
  thinking_levels: readonly ThinkingLevel[];
  note: string;
}

export interface ModelTestResult {
  ok: boolean;
  latency_ms: number;
  /** HTTP status of the probe request, when the transport got that far. */
  status?: number;
  response_text?: string;
  error?: string;
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
  private readonly modelSettings: ModelSettingsStore;
  /** Snapshot of the environment model configuration; console overrides are layered on top. */
  private readonly envModel: ModelConfig;
  /** Swapped by `updateModel()`; sessions created afterwards use the new handle. */
  private model: ModelHandle;
  /** Keys typed in the console, one per provider, persisted next to the other service data. */
  private readonly modelKeys: ModelKeyStore;
  private sweeper?: ReturnType<typeof setInterval>;
  private closed = false;

  private constructor(
    private readonly app: AppConfig,
    model: ModelHandle,
    readonly results: ResultStore,
    modelSettings: ModelSettingsStore,
    modelKeys: ModelKeyStore,
    envModel: ModelConfig,
  ) {
    this.model = model;
    this.modelSettings = modelSettings;
    this.modelKeys = modelKeys;
    this.envModel = envModel;
    this.history = new HistoryStore(join(app.dataDir, "history"));
    this.broker = new EventBroker(5_000, this.history);
    this.profiles = new ProfileStore(join(app.dataDir, "connections.json"), app.profileSecretKey);
  }

  static async create(app: AppConfig): Promise<AnalysisService> {
    // Console overrides are persisted, so they must be applied before the runtime is built once.
    const modelSettings = new ModelSettingsStore(join(app.dataDir, "model-settings.json"));
    const modelKeys = new ModelKeyStore(join(app.dataDir, "model-key.json"), app.profileSecretKey);
    const envModel: ModelConfig = { ...app.model };
    const persisted = modelSettings.get();
    if (Object.keys(persisted).length > 0) app.model = effectiveModel(envModel, persisted);
    // `.env`'s key belongs to `.env`'s provider, and a saved key belongs to the provider it was typed
    // for: either one may only be applied where it was issued.
    if (app.model.provider !== envModel.provider) app.model.apiKey = undefined;
    const savedKey = modelKeys.get(app.model.provider);
    const model = await createModelHandle(app, savedKey);
    const service = new AnalysisService(app, model, new ResultStore(`${app.dataDir}/results`), modelSettings, modelKeys, envModel);
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

  // ------------------------------------------------------------ model settings

  modelView(): ModelView {
    const configured = this.app.model;
    const env = effectiveModel(this.envModel, {});
    const overrides = this.modelSettings.get();
    // Report what the runtime will really use, not what the config asked for: for a built-in model
    // the catalogue decides the limits, and echoing our defaults here would be a lie.
    const actual = this.model.model;
    const authStatus = this.model.runtime.getProviderAuthStatus(actual.provider);
    const keySource: ModelView["api_key_source"] =
      this.model.keySource === "console"
        ? "console"
        : this.model.keySource === "env"
          ? "env"
          : this.model.keySource === "channel"
            ? "channel"
            : authStatus.configured
              ? "pi-auth"
              : "none";
    const overrideSources: Record<string, "console" | "env"> = {};
    for (const field of [
      "provider",
      "modelId",
      "api",
      "baseUrl",
      "thinkingLevel",
      "reasoning",
      "contextWindow",
      "maxTokens",
      "headers",
    ]) {
      const value = (overrides as Record<string, unknown>)[field];
      overrideSources[field] = value === undefined || value === null ? "env" : "console";
    }
    return {
      provider: actual.provider,
      model_id: actual.id,
      api: actual.api,
      base_url: actual.baseUrl ?? null,
      thinking_level: configured.thinkingLevel,
      reasoning: actual.reasoning,
      context_window: actual.contextWindow ?? null,
      max_tokens: actual.maxTokens ?? null,
      input: [...actual.input],
      headers: redact(configured.headers ?? {}),
      has_api_key: authStatus.configured,
      api_key_source: keySource,
      api_key_store: this.modelKeys.state(),
      auth_path: configured.authPath ?? null,
      ready: this.model.hasAuth,
      editable: this.app.allowModelEdit,
      edit_disabled_reason: this.app.allowModelEdit
        ? null
        : "Model editing is disabled. Set DATA_AGENT_ALLOW_MODEL_EDIT=1 to allow it (production defaults to off).",
      overrides,
      override_sources: overrideSources,
      env_model: {
        provider: env.provider,
        model_id: env.modelId,
        api: env.api ?? DEFAULT_MODEL_API,
        base_url: env.baseUrl ?? null,
        thinking_level: env.thinkingLevel,
        reasoning: env.reasoning ?? null,
        context_window: env.contextWindow ?? null,
        max_tokens: env.maxTokens ?? null,
      },
      api_options: SELECTABLE_MODEL_APIS.map(({ id, label, note }) => ({ id, label, note })),
      settings_status: this.modelSettings.state().status,
      settings_path: this.modelSettings.path,
      thinking_levels: THINKING_LEVELS,
      note:
        "Applies to new sessions only: an open session keeps the model handle it was created with. " +
        "The API key is held in memory, so set DATA_AGENT_MODEL_API_KEY to keep it across restarts.",
    };
  }

  /**
   * Sends one tiny completion through the active handle. `ready` only means a credential exists;
   * a wrong protocol or base URL only shows up when a request is actually made.
   */
  async testModel(): Promise<ModelTestResult> {
    if (!this.model.hasAuth) {
      return { ok: false, latency_ms: 0, error: `No API key resolved for "${this.app.model.provider}"` };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let status: number | undefined;
    try {
      const auth = await this.model.runtime.getAuth(this.model.model);
      if (!auth?.auth.apiKey) {
        return { ok: false, latency_ms: 0, error: `No API key resolved for "${this.app.model.provider}"` };
      }
      const message = await completeSimple(
        this.model.model,
        { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] },
        {
          apiKey: auth.auth.apiKey,
          headers: auth.auth.headers,
          maxTokens: 16,
          timeoutMs: MODEL_TEST_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
          signal: controller.signal,
          onResponse: (response) => {
            status = response.status;
          },
        },
      );
      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return {
          ok: false,
          latency_ms: latencyMs,
          status,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "The model returned an error"),
        };
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { ok: true, latency_ms: latencyMs, status, response_text: text.slice(0, 300) };
    } catch (error) {
      return {
        ok: false,
        latency_ms: Date.now() - startedAt,
        status,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Applies a console patch. The new runtime is built before anything is saved, so a bad provider or
   * endpoint leaves the service on its previous, working configuration.
   */
  async updateModel(patch: ModelPatch): Promise<ModelView> {
    this.assertModelEditable();
    const overrides = mergeOverrides(this.modelSettings.get(), patch);
    // `undefined` keeps whatever key is already saved, `null` deletes it, a string replaces it.
    return this.commit(overrides, patch.apiKey, (candidate) => this.inheritKnownLimits(candidate, patch, overrides));
  }

  /**
   * Every channel the operator can switch to: their own pi models.json entries plus the built-in
   * providers pi's `enabledModels` keeps on. Read fresh on each call so editing the pi config shows up
   * without restarting the service.
   */
  channels(): ChannelCatalog {
    const active = { provider: this.model.model.provider, model_id: this.model.model.id };
    return buildChannelCatalog({
      runtime: this.model.runtime,
      pi: readPiConfig(this.app.piModelsPath, this.app.piSettingsPath),
      active,
    });
  }

  /**
   * Switches channel. Only the provider/model pair survives: a base url, protocol or limit that was
   * typed for one channel must not follow the user to another one.
   */
  async selectChannel(provider: string, modelId: string): Promise<ModelView> {
    this.assertModelEditable();
    const overrides = this.modelSettings.get();
    const next: ModelOverrides = { provider, modelId };
    if (overrides.thinkingLevel !== undefined) next.thinkingLevel = overrides.thinkingLevel;
    // Only the target provider's own saved key is picked up; another channel's credential stays put.
    return this.commit(next);
  }

  /**
   * Rebuilds the runtime, then persists. The new handle is created first, so a bad provider, protocol
   * or endpoint leaves the service on its previous, working configuration.
   */
  private async commit(
    overrides: ModelOverrides,
    requestedKey?: string | null,
    adjust?: (candidate: ModelConfig) => void,
  ): Promise<ModelView> {
    // Which credential applies is decided per provider, before the runtime is built.
    const provider = overrides.provider ?? this.envModel.provider;
    const consoleKey = typeof requestedKey === "string" ? requestedKey : requestedKey === null ? undefined : this.modelKeys.get(provider);
    const candidate = effectiveModel(this.envModel, overrides, consoleKey);
    adjust?.(candidate);
    // A credential belongs to the provider it was issued for. Without this, switching to another
    // channel would forward the `.env` key — issued for the env provider — to that gateway.
    if (!consoleKey && candidate.apiKey && candidate.provider !== this.envModel.provider) {
      candidate.apiKey = undefined;
    }
    this.assertSane(candidate);
    const handle = await createModelHandle({ ...this.app, model: candidate }, consoleKey);
    // An empty override set must leave no file behind: otherwise a no-op save would pin every field
    // and `.env` would silently stop taking effect.
    if (Object.keys(overrides).length === 0) this.modelSettings.clear();
    else this.modelSettings.save(overrides);
    // Persist the key only after the runtime accepted the configuration it belongs to.
    if (typeof requestedKey === "string") this.modelKeys.save(candidate.provider, requestedKey);
    else if (requestedKey === null) this.modelKeys.clear(candidate.provider);
    // The console key must not enter the shared config: it is process-local, and leaving it there
    // would turn it into the "environment" baseline for anything that reads AppConfig again.
    this.app.model = {
      ...candidate,
      // Same rule for the shared config: the env key may only sit next to the env provider.
      apiKey: candidate.provider === this.envModel.provider ? this.envModel.apiKey : undefined,
    };
    this.model = handle;
    return this.modelView();
  }

  /**
   * Serving the same model through a gateway must not downgrade it. A custom provider block has to
   * spell out `contextWindow`/`maxTokens`, so without this the real 1M window would silently become
   * pi's 128k fallback the moment a base url is added. Limits are only inherited for the model that is
   * already active, and an explicit patch still wins.
   */
  private inheritKnownLimits(candidate: ModelConfig, patch: ModelPatch, overrides: ModelOverrides): void {
    const current = this.model.model;
    if (!candidate.baseUrl || current.provider !== candidate.provider || current.id !== candidate.modelId) return;
    if (patch.contextWindow === undefined && overrides.contextWindow === undefined && candidate.contextWindow === undefined) {
      candidate.contextWindow = current.contextWindow;
    }
    if (patch.maxTokens === undefined && overrides.maxTokens === undefined && candidate.maxTokens === undefined) {
      candidate.maxTokens = current.maxTokens;
    }
  }

  /** Drops every console override and rebuilds from the environment configuration. */
  async resetModel(): Promise<ModelView> {
    this.assertModelEditable();
    // "Back to .env" means the console leaves no trace, saved keys included.
    this.modelKeys.clear();
    return this.commit({}, null);
  }

  private assertModelEditable(): void {
    if (!this.app.allowModelEdit) {
      throw new AppError(
        "MODEL_EDIT_DISABLED",
        "Model settings cannot be changed in this process. Set DATA_AGENT_ALLOW_MODEL_EDIT=1 to allow it.",
      );
    }
  }

  private assertSane(model: ModelConfig): void {
    if (model.maxTokens && model.contextWindow && model.maxTokens > model.contextWindow) {
      throw new AppError("INVALID_INPUT", "maxTokens cannot exceed contextWindow");
    }
    const api = findModelApi(model.api);
    if (model.api && !api) {
      throw new AppError("INVALID_INPUT", `Unknown api protocol "${model.api}"`);
    }
    // pi's built-in catalogue already knows the endpoint and protocol of a built-in provider, so a
    // protocol on its own describes nothing and the runtime would refuse the provider entry.
    if (model.api && !model.baseUrl) {
      throw new AppError(
        "INVALID_INPUT",
        `api=${model.api} requires a baseUrl. Set base url as well, or leave api empty to use ${model.provider}'s built-in protocol.`,
      );
    }
    if (api && !api.selectable && (model.baseUrl || model.api || model.headers)) {
      throw new AppError("INVALID_INPUT", `${api.id} requires ${api.requires}. ${api.note}`);
    }
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
