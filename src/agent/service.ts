import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { analysisOptions } from "../analysis/options.js";
import { localSql, summarize, ownedResult } from "../analysis/results.js";
import { SnapshotStore } from "../analysis/snapshots.js";
import { checkLocalSize } from "../analysis/privacy.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { redact, type AppConfig, type ModelConfig } from "../config.js";
import { ConnectionConfig, type SessionCapabilities } from "../db/types.js";
import { AppError } from "../errors.js";
import { DbSession } from "../db/session.js";
import { assertTargetAllowed } from "../db/engines/index.js";
import { normalizeHostKeyFingerprint, probeHostKeys, type HostKeyObservation } from "../db/ssh-tunnel.js";
import { ResultStore, type ResultPage, type ResultMeta } from "../results/store.js";
import { ArtifactService } from "../artifacts/service.js";
import { ArtifactStore } from "../artifacts/store.js";
import { csvLine, UTF8_BOM } from "../artifacts/csv.js";
import type { Artifact } from "../artifacts/types.js";
import { auditExport } from "../audit.js";
import { EventBroker, type TaskEvent } from "./events.js";
import { createModelHandle, type ModelHandle } from "./model.js";
import { buildChannelCatalog, type ChannelCatalog, type ChannelSelectionRequest } from "./channels.js";
import { readPiConfig } from "./pi-config.js";
import { ProviderStore, ProviderConfig, ProviderWrite, ProviderId } from "./provider-store.js";
import { ManagedModel } from "./provider-store.js";
import { discoverModels } from "./model-discovery.js";
import { AnalysisSession, type TaskRecord } from "./runtime.js";
import { buildTitleTranscriptFromTasks, generateTitleFromModel, type GeneratedSessionTitle } from "./session-title.js";
import { HistoryStore, connectionKey } from "./history.js";
import { taskActivity } from "./task-activity.js";
import { BusinessCatalogStore, readBusinessView } from "../business/service.js";
import { parseResultValueRef } from "../business/types.js";
import { compileResultOperation, type ResultOperation } from "../analysis/operations.js";
import { BusinessContextStore, businessContextScope } from "../business-context/store.js";
import type { BusinessContextFile } from "../business-context/types.js";
import { ProfileStore } from "../db/profiles-store.js";
import { AccountStore } from "../auth/accounts.js";
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

/**
 * Answer of `POST /v1/connections/host-key`: `direct` when the profile has no jump host, `verified`
 * when every hop is already pinned and still matches, `unverified` with the key to confirm, and
 * `pinned` once the confirmed key was re-read and stored.
 */
export interface HostKeyProbeResult {
  status: "direct" | "verified" | "unverified" | "pinned";
  hop?: HostKeyObservation;
  /** Only for an explicit re-read: the server no longer presents the pinned key. */
  changed?: boolean;
  /** The pin this connection has been using, normalized, when `changed` is set. */
  previous?: string;
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
  api_key_source: "console" | "env" | "channel" | "managed" | "pi-auth" | "none";
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
  readonly businessContext: BusinessContextStore;
  readonly businessCatalog: BusinessCatalogStore;
  private readonly modelSettings: ModelSettingsStore;
  /** Snapshot of the environment model configuration; console overrides are layered on top. */
  private readonly envModel: ModelConfig;
  /** Swapped by `updateModel()`; sessions created afterwards use the new handle. */
  private model: ModelHandle;
  /** Keys typed in the console, one per provider, persisted next to the other service data. */
  private readonly modelKeys: ModelKeyStore;
  private sweeper?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly providers: ProviderStore;
  private readonly providerKeys: ModelKeyStore;
  private modelMutation: Promise<unknown> = Promise.resolve();
  private serializeModel<T>(run: () => Promise<T>): Promise<T> {
    const next = this.modelMutation.then(run, run);
    this.modelMutation = next.catch(() => undefined);
    return next;
  }

  private constructor(
    private readonly app: AppConfig,
    model: ModelHandle,
    readonly results: ResultStore,
    readonly artifacts: ArtifactService,
    modelSettings: ModelSettingsStore,
    modelKeys: ModelKeyStore,
    envModel: ModelConfig,
    readonly accounts?: AccountStore,
  ) {
    this.model = model;
    this.modelSettings = modelSettings;
    this.modelKeys = modelKeys;
    this.envModel = envModel;
    this.providers = new ProviderStore(join(app.dataDir, "model-providers.json"));
    this.providerKeys = new ModelKeyStore(join(app.dataDir, "model-provider-secrets.json"), app.profileSecretKey);
    this.history = new HistoryStore(join(app.dataDir, "history"));
    this.broker = new EventBroker(5_000, this.history);
    this.profiles = new ProfileStore(join(app.dataDir, "connections.json"), app.profileSecretKey);
    this.businessContext = new BusinessContextStore(join(app.dataDir, "business-context"));
    this.businessCatalog = new BusinessCatalogStore(join(app.dataDir, "business-catalog", "catalog.sqlite"));
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
    const owned = new ProviderStore(join(app.dataDir, "model-providers.json")).all();
    const providerKeys = new ModelKeyStore(join(app.dataDir, "model-provider-secrets.json"), app.profileSecretKey);
    const secret = AnalysisService.providerSecret(providerKeys, app.model.provider);
    const model = await createModelHandle(app, savedKey, { providers: owned, ...secret });
    const results = new ResultStore(`${app.dataDir}/results`);
    const artifacts = new ArtifactService(new ArtifactStore(join(app.dataDir, "artifacts")), results, app.budgets, analysisOptions(app).maxSeries);
    let accounts: AccountStore | undefined;
    let service: AnalysisService;
    try {
      if (app.requireAuth) {
        if (!app.profileSecretKey?.trim()) throw new Error("Account mode requires a stable DATA_AGENT_PROFILE_SECRET_KEY");
        accounts = new AccountStore(join(app.dataDir, "accounts.db"));
        if (!accounts.hasAdmin()) {
          if (!app.adminPassword) throw new Error("Set DATA_AGENT_ADMIN_PASSWORD to initialize the admin account");
          await accounts.setPassword("admin", app.adminPassword, "bootstrap");
        }
      }
      service = new AnalysisService(app, model, results, artifacts, modelSettings, modelKeys, envModel, accounts);
    } catch (error) {
      accounts?.close();
      throw error;
    }
    service.sweeper = setInterval(() => void service.sweepExpired().catch(error => console.warn("Session maintenance failed", (error as Error).message)), 30_000);
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
    const managed = this.providers.get(actual.provider);
    const keySource: ModelView["api_key_source"] =
      managed ? (this.model.hasAuth ? "managed" : "none") : this.model.keySource === "console"
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
      headers: managed ? {} : redact(configured.headers ?? {}),
      has_api_key: this.model.hasAuth,
      api_key_source: keySource,
      api_key_store: this.providers.get(actual.provider) ? this.providerKeys.state() : this.modelKeys.state(),
      auth_path: managed ? null : configured.authPath ?? null,
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
        "Project channels and credentials persist independently of pi; credentials are never returned.",
    };
  }

  /**
   * Sends one tiny completion through the active handle. `ready` only means a credential exists;
   * a wrong protocol or base URL only shows up when a request is actually made.
   */
  async testModel(handle: ModelHandle = this.model): Promise<ModelTestResult> {
    if (!handle.hasAuth) {
      return { ok: false, latency_ms: 0, error: `No API key resolved for "${handle.model.provider}"` };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let status: number | undefined;
    let secrets: string[] = Object.values(handle.model.headers ?? {});
    const safe = (result: ModelTestResult): ModelTestResult => {
      for (const secret of secrets.filter(Boolean)) {
        if (result.error) result.error = result.error.split(secret).join("[redacted]");
        if (result.response_text) result.response_text = result.response_text.split(secret).join("[redacted]");
      }
      return result;
    };
    try {
      const auth = await handle.runtime.getAuth(handle.model);
      if (!auth?.auth.apiKey) {
        return { ok: false, latency_ms: 0, error: `No API key resolved for "${handle.model.provider}"` };
      }
      secrets.push(auth.auth.apiKey, ...Object.values(auth.auth.headers ?? {}).filter((v): v is string => typeof v === "string"));
      const message = await completeSimple(
        handle.model,
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
        return safe({
          ok: false,
          latency_ms: latencyMs,
          status,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "The model returned an error"),
        });
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return safe({ ok: true, latency_ms: latencyMs, status, response_text: text.slice(0, 300) });
    } catch (error) {
      return safe({
        ok: false,
        latency_ms: Date.now() - startedAt,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Applies a console patch. The new runtime is built before anything is saved, so a bad provider or
   * endpoint leaves the service on its previous, working configuration.
   */
  async updateModel(patch: ModelPatch): Promise<ModelView> {
    return this.serializeModel(() => this.updateModelInner(patch));
  }

  private async updateModelInner(patch: ModelPatch): Promise<ModelView> {
    this.assertModelEditable();
    if (this.providers.get(patch.provider ?? this.app.model.provider)) {
      const fields = Object.keys(patch).filter((field) => !["thinkingLevel", "provider", "modelId"].includes(field));
      if (fields.length) throw new AppError("INVALID_INPUT", "Edit a project channel through model/providers, not the legacy override API");
    }
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
    const catalog = buildChannelCatalog({
      runtime: this.model.runtime,
      pi: readPiConfig(this.app.piModelsPath, this.app.piSettingsPath),
      active,
    });
    for (const [id, provider] of Object.entries(this.providers.all())) {
      const secret = AnalysisService.providerSecret(this.providerKeys, id);
      const ready = Boolean(secret.key) || provider.authMode === "none";
      const channel = { id, name: provider.name, source: "project" as const, ready,
        key_source: ready ? "project" as const : "none" as const,
        enabled_count: provider.models.length, total_count: provider.models.length,
        models: provider.models.map((m) => ({ id: m.id, name: m.name || m.id, api: provider.api,
          context_window: m.contextWindow, max_tokens: m.maxTokens, reasoning: m.reasoning,
          input: m.input, enabled: true })) };
      catalog.channels = catalog.channels.filter((c) => c.id !== id);
      catalog.channels.unshift(channel);
    }
    return catalog;
  }

  /**
   * Switches channel. Only the provider/model pair survives: a base url, protocol or limit that was
   * typed for one channel must not follow the user to another one.
   */
  async selectChannel(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<ModelView> {
    return this.serializeModel(() => this.selectChannelInner(provider, modelId, thinkingLevel));
  }

  private async selectChannelInner(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<ModelView> {
    this.assertModelEditable();
    const owned = this.providers.get(provider);
    if (owned && !owned.models.some((m) => m.id === modelId)) throw new AppError("INVALID_INPUT", "Model is not in this project channel");
    const overrides = this.modelSettings.get();
    const next: ModelOverrides = { provider, modelId };
    if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;
    else if (overrides.thinkingLevel !== undefined) next.thinkingLevel = overrides.thinkingLevel;
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
    const managed = this.providers.all();
    if (managed[candidate.provider]) {
      candidate.api = candidate.baseUrl = undefined;
      candidate.headers = undefined;
      candidate.reasoning = candidate.contextWindow = candidate.maxTokens = undefined;
    }
    this.assertSane(candidate);
    const handle = await createModelHandle({ ...this.app, model: candidate }, consoleKey,
      { providers: managed, ...AnalysisService.providerSecret(this.providerKeys, candidate.provider) });
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
    return this.serializeModel(async () => {
      this.assertModelEditable();
      await this.commit({}, null);
      // Keep project-owned credentials; reset only the old single-model overrides.
      this.modelKeys.clear();
      return this.modelView();
    });
  }

  // -------------------------------------------------- project-owned model catalogue
  private static providerSecret(store: ModelKeyStore, id: string): { key?: string; headers?: Record<string, string> } {
    const value = store.get(id);
    if (!value) return {};
    try { return JSON.parse(value); } catch { return {}; }
  }

  providerCatalog() {
    return {
      providers: Object.entries(this.providers.all()).map(([id, config]) => {
        const secret = AnalysisService.providerSecret(this.providerKeys, id);
        return { id, ...config, has_api_key: Boolean(secret.key), header_names: Object.keys(secret.headers ?? {}) };
      }),
      active: { provider: this.app.model.provider, modelId: this.app.model.modelId, thinkingLevel: this.app.model.thinkingLevel, ready: this.model.hasAuth },
      editable: this.app.allowModelEdit,
      storage: { path: this.providers.path, status: this.providers.status, protection: this.providerKeys.protection,
        secrets_status: this.providerKeys.state().status },
      pi_available: Boolean(this.app.piModelsPath),
      api_options: SELECTABLE_MODEL_APIS,
      thinking_levels: THINKING_LEVELS,
    };
  }

  async saveProvider(id: string, body: ProviderWrite, createOnly = false) {
    return this.serializeModel(async () => {
      this.assertModelEditable();
      id = ProviderId.parse(id);
      const { apiKey, headers, ...raw } = ProviderWrite.parse(body);
      const config = ProviderConfig.parse(raw);
      const previous = this.providers.get(id);
      if (createOnly && previous) throw new AppError("INVALID_INPUT", "Target channel already exists; choose a new ID");
      if (this.providerKeys.state().status === "invalid") throw new AppError("INVALID_INPUT", "Project credential store is unreadable; restore its encryption key or repair it before saving");
      const oldSecret = AnalysisService.providerSecret(this.providerKeys, id);
      // Reusing a key after changing its destination must be an explicit act (re-enter or clear).
      const redirected = previous && (previous.baseUrl !== config.baseUrl || previous.api !== config.api);
      if (redirected && ((oldSecret.key && apiKey === undefined) || (Object.keys(oldSecret.headers ?? {}).length && headers === undefined))) {
        throw new AppError("INVALID_INPUT", "Endpoint changed: re-enter or clear the API key and private headers before saving");
      }
      const secret = { key: apiKey === null ? undefined : apiKey ?? oldSecret.key, headers: headers ?? oldSecret.headers };
      const all = { ...this.providers.all(), [id]: config };
      const active = this.app.model.provider === id;
      if (active && !config.models.some((m) => m.id === this.app.model.modelId)) {
        throw new AppError("INVALID_INPUT", "Switch the default model before removing it from this channel");
      }
      // Validate using isolated runtime files; invalid drafts never overwrite the running catalogue.
      const target = active ? this.app.model.modelId : config.models[0]!.id;
      const handle = await this.validateProvider(all, id, target, secret);
      // Synchronous mutations are serialized. Roll back if a disk write fails.
      const oldEncoded = this.providerKeys.get(id);
      try {
        this.providerKeys.save(id, JSON.stringify(secret));
        this.providers.save(all);
      } catch (error) {
        if (oldEncoded) this.providerKeys.save(id, oldEncoded);
        else this.providerKeys.clear(id);
        throw error;
      }
      if (active) this.model = handle;
      return this.providerCatalog();
    });
  }

  async deleteProvider(id: string) {
    return this.serializeModel(async () => {
      this.assertModelEditable();
      if (!this.providers.get(id)) throw new AppError("NOT_FOUND", "Project channel not found");
      if (this.providerKeys.state().status === "invalid") throw new AppError("INVALID_INPUT", "Project credential store is unreadable; repair it before deleting channels");
      if (this.app.model.provider === id) throw new AppError("INVALID_INPUT", "Switch the default channel before deleting this one");
      const all = this.providers.all();
      delete all[id];
      this.providers.save(all);
      this.providerKeys.clear(id);
      return this.providerCatalog();
    });
  }

  private async validateProvider(
    providers: Record<string, ProviderConfig>, id: string, modelId: string,
    secret: { key?: string; headers?: Record<string, string> },
  ): Promise<ModelHandle> {
    const dir = await mkdtemp(join(tmpdir(), "data-agent-model-"));
    try {
      return await createModelHandle({ ...this.app, dataDir: dir, piModelsPath: undefined, piSettingsPath: undefined,
        model: { provider: id, modelId, thinkingLevel: this.app.model.thinkingLevel } }, undefined, { providers, ...secret });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async testProvider(id: string, body: ProviderWrite, modelId: string) {
    this.assertModelEditable();
    ProviderId.parse(id);
    const { apiKey, headers, ...config } = ProviderWrite.parse(body);
    const old = this.providers.get(id);
    const sameEndpoint = old && old.baseUrl === config.baseUrl && old.api === config.api;
    const saved = sameEndpoint ? AnalysisService.providerSecret(this.providerKeys, id) : {};
    if (!config.models.some((m) => m.id === modelId)) throw new AppError("INVALID_INPUT", "Choose a model in this draft");
    const handle = await this.validateProvider({ [id]: config }, id, modelId,
      { key: apiKey === null ? undefined : apiKey ?? saved.key, headers: headers ?? saved.headers });
    const result = await this.testModel(handle);
    // An upstream may echo request headers in an error. Never return those literals to the browser.
    const literals = [apiKey ?? saved.key, ...Object.values(headers ?? saved.headers ?? {})].filter(Boolean) as string[];
    for (const secret of literals) {
      if (result.error) result.error = result.error.split(secret).join("[redacted]");
      if (result.response_text) result.response_text = result.response_text.split(secret).join("[redacted]");
    }
    return result;
  }

  async discoverProvider(id: string, body: ProviderWrite) {
    this.assertModelEditable();
    ProviderId.parse(id);
    const { apiKey, headers, ...config } = ProviderWrite.parse(body);
    const old = this.providers.get(id);
    const sameEndpoint = old && old.baseUrl === config.baseUrl && old.api === config.api;
    const saved = sameEndpoint ? AnalysisService.providerSecret(this.providerKeys, id) : {};
    return { models: await discoverModels(config.api, config.baseUrl,
      config.authMode === "none" || apiKey === null ? undefined : apiKey ?? saved.key, headers ?? saved.headers) };
  }

  async importPiProvider(sourceId: string, targetId: string) {
    this.assertModelEditable();
    ProviderId.parse(targetId);
    if (this.providers.get(targetId)) throw new AppError("INVALID_INPUT", "Target channel already exists; choose a new ID");
    const pi = readPiConfig(this.app.piModelsPath, this.app.piSettingsPath);
    const source = pi.providers[sourceId];
    if (!source) throw new AppError("NOT_FOUND", "pi channel not found");
    // Only import literal HTTP configuration; never import executable credential expressions.
    const importedModels = Array.isArray(source.models) ? source.models as Record<string, unknown>[] : [];
    const models = importedModels.map((m) => ManagedModel.parse({
      id: m.id, name: m.name, reasoning: m.reasoning, input: m.input,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens,
      thinkingLevelMap: (m as any).thinkingLevelMap, compat: (m as any).compat,
    }));
    return this.saveProvider(targetId, ProviderWrite.parse({
      name: source.name || sourceId, baseUrl: source.baseUrl, api: source.api,
      models, compat: source.compat, apiKey: pi.apiKeys[sourceId],
      headers: source.headers && typeof source.headers === "object" ? Object.fromEntries(
        Object.entries(source.headers).filter(([, value]) => typeof value === "string" && !value.trim().startsWith("!") && !value.includes("$")),
      ) : undefined,
    }), true);
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

  /**
   * Reads the host key of the first jump host, without sending any credential, so the console can
   * display it and the operator can confirm it. Already-pinned hops are still verified on the way,
   * so a changed key is reported here rather than at query time.
   *
   * `options.observe` re-reads an already-pinned host and reports whether the key changed, which is
   * how an operator re-pins after a rebuild; nothing is written until `pinHostKey()` is called.
   */
  async probeHostKey(config: ConnectionConfig, options: { observe?: boolean } = {}): Promise<HostKeyProbeResult> {
    const hops = config.ssh?.hops ?? [];
    if (hops.length === 0) return { status: "direct" };
    // The probe opens a socket, so it carries the same private-network policy as a connection.
    for (const hop of hops) await assertTargetAllowed(hop.host, this.app.allowPrivateNetwork);
    const hop = await probeHostKeys(hops, undefined, { observe: options.observe });
    if (!hop) return { status: "verified" };
    const pinned = hops[0]?.hostFingerprint;
    if (!options.observe || !pinned) return { status: "unverified", hop };
    return {
      status: "unverified",
      hop,
      changed: normalizeHostKeyFingerprint(pinned) !== normalizeHostKeyFingerprint(hop.fingerprint),
      // Reported as it is stored, so the console can show what it is about to replace.
      previous: pinned,
    };
  }

  /**
   * Pins the host key the operator just confirmed. The server is asked for its key a second time so
   * the pinned value is one this process read itself; a key that changed between the two reads is
   * refused instead of being written down. An existing pin is deliberately ignored while reading,
   * otherwise a rebuilt host could never be re-pinned.
   */
  async pinHostKey(
    config: ConnectionConfig,
    ownerKey: string,
    accepted: { profile?: string; fingerprint: string },
  ): Promise<HostKeyProbeResult> {
    const { hop } = await this.probeHostKey(config, { observe: true });
    if (!hop) return { status: "verified" };
    if (normalizeHostKeyFingerprint(hop.fingerprint) !== normalizeHostKeyFingerprint(accepted.fingerprint)) {
      throw new AppError(
        "SSH_HOST_KEY_MISMATCH",
        `Host key of SSH hop ${hop.host} changed while it was being confirmed (${accepted.fingerprint} -> ${hop.fingerprint}); nothing was pinned`,
        { host: hop.host, port: hop.port, expected: accepted.fingerprint, actual: hop.fingerprint },
      );
    }
    if (accepted.profile) this.profiles.pinHostKey(ownerKey, accepted.profile, hop.index, hop.fingerprint);
    return { status: "pinned", hop };
  }

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

  connectionForResume(sessionId: string, ownerKey: string): { connection: ConnectionConfig; profileId: string } {
    const previous = this.history.getSession(sessionId, ownerKey);
    const profileId = previous.connectionProfileId;
    const connection = profileId && this.profiles.connectionById(ownerKey, profileId);
    if (!profileId || !connection || !this.matchesHistory(previous, connection, ownerKey)) {
      throw new AppError("RECONNECT_PROFILE_REQUIRED", "No matching saved connection with credentials. Select or fill the original connection and retry.");
    }
    return { connection, profileId };
  }

  bindProfile(sessionId: string, ownerKey: string, config: ConnectionConfig, profileId: string): void {
    const previous = this.history.getSession(sessionId, ownerKey);
    if (this.matchesHistory(previous, config, ownerKey)) {
      this.history.saveSession(ownerKey, previous.snapshot, undefined, undefined, profileId);
    }
  }

  private matchesHistory(previous: ReturnType<HistoryStore["getSession"]>, config: ConnectionConfig, ownerKey: string): boolean {
    return previous.connectionKey === connectionKey(config) &&
      (!previous.businessContext || previous.businessContext.scope === businessContextScope(ownerKey, config));
  }

  /** Builds a private runtime without changing the global default or shared models.json. */
  private async sessionModel(selection?: ChannelSelectionRequest): Promise<{ handle: ModelHandle; thinkingLevel: ThinkingLevel }> {
    const provider = selection?.provider ?? this.app.model.provider;
    const modelId = selection?.modelId ?? this.app.model.modelId;
    const owned = this.providers.get(provider);
    if (owned && !owned.models.some((m) => m.id === modelId)) throw new AppError("INVALID_INPUT", "目标模型不在该渠道中。");
    if (selection && !owned && !this.model.runtime.getModel(provider, modelId) &&
      !(provider === this.envModel.provider && modelId === this.envModel.modelId)) {
      throw new AppError("INVALID_INPUT", "目标渠道或模型不存在，请刷新模型列表。");
    }
    const baseline = provider === this.app.model.provider && modelId === this.app.model.modelId ? this.app.model
      : provider === this.envModel.provider && modelId === this.envModel.modelId ? this.envModel
      : { provider, modelId, thinkingLevel: this.app.model.thinkingLevel, authPath: this.envModel.authPath };
    const model: ModelConfig = { ...baseline, thinkingLevel: selection?.thinkingLevel ?? baseline.thinkingLevel };
    const key = this.modelKeys.get(provider);
    if (provider !== this.envModel.provider) model.apiKey = undefined;
    const dir = await mkdtemp(join(tmpdir(), "data-agent-session-model-"));
    try {
      const handle = await createModelHandle({ ...this.app, model }, key,
        { providers: this.providers.all(), ...AnalysisService.providerSecret(this.providerKeys, provider) }, dir);
      // Pin the composed provider in memory before deleting the temporary catalogue.
      // Runtime registration refreshes later; it must not lose the original session endpoint.
      const source = handle.runtime.getProvider(provider);
      if (source) {
        handle.runtime.registerNativeProvider(source);
        await handle.runtime.refresh({ allowNetwork: false });
      }
      return { handle, thinkingLevel: model.thinkingLevel };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async setSessionModel(sessionId: string, ownerKey: string, selection: ChannelSelectionRequest) {
    const session = this.getSession(sessionId, ownerKey);
    await session.changeModel(async () => (await this.sessionModel(selection)).handle, selection.thinkingLevel);
    return session.snapshot();
  }

  async createSession(config: ConnectionConfig, ownerKey: string, sessionId?: string, profileId?: string): Promise<AnalysisSession> {
    if (this.closed) throw new AppError("INTERNAL_ERROR", "Service is shutting down");
    const scope = businessContextScope(ownerKey, config);
    let files: BusinessContextFile[] | undefined;
    let savedTitle: string | undefined;
    let selection: ChannelSelectionRequest | undefined;
    if (sessionId) {
      const previous = this.history.getSession(sessionId, ownerKey);
      savedTitle = typeof previous.snapshot.title === "string" ? previous.snapshot.title : undefined;
      if (!this.matchesHistory(previous, config, ownerKey)) {
        throw new AppError("INVALID_INPUT", "Reconnect must use the original database connection and account");
      }
      files = previous.businessContext?.files;
      selection = previous.snapshot.agent?.selection ?? undefined;
      // Older snapshots may record provider/model but no explicit selection.
      if (!selection && previous.snapshot.agent?.provider && previous.snapshot.agent?.model) {
        selection = { provider: previous.snapshot.agent.provider, modelId: previous.snapshot.agent.model };
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
    const selected = await this.sessionModel(selection);
    if ((selection || this.providers.get(this.app.model.provider)) && !selected.handle.hasAuth) {
      throw new AppError("MODEL_NOT_CONFIGURED", "请先配置该会话模型的凭证；不会自动退回其他模型。");
    }
    files ??= this.businessContext.select(scope, config.businessContextIds ?? this.businessContext.getDefaults(scope));
    const session = await AnalysisSession.create({
      config,
      app: { ...this.app, model: { ...this.app.model, thinkingLevel: selected.thinkingLevel } },
      results: this.results,
      model: selected.handle,
      broker: this.broker,
      ownerKey,
      history: this.history,
      artifacts: this.artifacts,
      sessionId,
      title: savedTitle,
      modelSelection: selection,
      businessContext: { scope, files },
      businessCatalog: this.businessCatalog,
    });
    this.history.saveSession(ownerKey, session.snapshot(), connectionKey(config), { scope, files }, profileId);
    this.sessions.set(session.id, session);
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

  private sessionProfileCandidates(ownerKey: string) {
    try {
      return this.profiles.list(ownerKey).flatMap((profile) => {
        const parsed = ConnectionConfig.safeParse(this.profiles.reveal(ownerKey, profile.name));
        if (!parsed.success) return [];
        return [{ id: profile.id, key: connectionKey(parsed.data), scope: businessContextScope(ownerKey, parsed.data), usesSsh: Boolean(parsed.data.ssh) }];
      });
    } catch {
      // Old transcripts remain readable when saved connection credentials are unavailable.
      return [];
    }
  }

  listSessions(ownerKey: string) {
    const history = this.history.listSessions(ownerKey);
    const candidates = history.some((record) => !record.connectionProfileId) ? this.sessionProfileCandidates(ownerKey) : [];
    return history.map((record) => {
      const live = this.sessions.get(record.snapshot.session_id);
      const snapshot = live?.ownerKey === ownerKey ? live.snapshot() : record.snapshot;
      const matches = record.connectionProfileId ? [] : candidates.filter((candidate) =>
        candidate.key === record.connectionKey && (record.scope ? candidate.scope === record.scope : !candidate.usesSsh));
      return { ...snapshot, connection_profile_id: record.connectionProfileId ?? (matches.length === 1 ? matches[0]!.id : undefined) };
    });
  }

  sessionSnapshot(sessionId: string, ownerKey: string) {
    const session = this.sessions.get(sessionId);
    if (session) return this.getSession(sessionId, ownerKey).snapshot();
    return this.history.getSession(sessionId, ownerKey).snapshot;
  }

  /**
   * Names a session from its conversation. A live session titles itself with its own model handle;
   * a saved one uses the service's active handle over the persisted goals and answers, so naming
   * never requires reopening the database connection.
   */
  async generateTitle(sessionId: string, ownerKey: string): Promise<GeneratedSessionTitle> {
    const live = this.sessions.get(sessionId);
    if (live) {
      if (live.ownerKey !== ownerKey) throw new AppError("NOT_FOUND", `Session ${sessionId} not found`);
      return live.generateTitle();
    }
    this.history.getSession(sessionId, ownerKey);
    const transcript = buildTitleTranscriptFromTasks(this.history.listTasks(sessionId, ownerKey));
    const result = await generateTitleFromModel(this.model, transcript);
    this.history.setSessionTitle(sessionId, ownerKey, result.title);
    return result;
  }

  renameSession(sessionId: string, ownerKey: string, title: string): void {
    const live = this.sessions.get(sessionId);
    if (live) {
      if (live.ownerKey !== ownerKey) throw new AppError("NOT_FOUND", `Session ${sessionId} not found`);
      live.setTitle(title);
    } else this.history.setSessionTitle(sessionId, ownerKey, title);
  }

  async listResults(sessionId: string, ownerKey: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    return this.results.listBySession(sessionId);
  }

  // --------------------------------------------------------------- artifacts

  async listArtifacts(sessionId: string, ownerKey: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    return this.artifacts.listBySession(sessionId);
  }

  /**
   * Artifacts outlive their session, so ownership is proved through the history index rather than a
   * live session: a chart in a closed session must still render for the person who owns it.
   */
  async getArtifact(artifactId: string, ownerKey: string): Promise<Artifact> {
    const artifact = await this.artifacts.get(artifactId);
    if (!artifact) throw new AppError("ARTIFACT_NOT_FOUND", `Artifact ${artifactId} not found`);
    this.history.getSession(artifact.session_id, ownerKey);
    return artifact;
  }

  async artifactCsv(artifactId: string, ownerKey: string, client?: string) {
    const artifact = await this.getArtifact(artifactId, ownerKey);
    const { filename, body } = this.artifacts.csv(artifact);
    await auditExport(this.app.dataDir, {
      format: "csv",
      object: "artifact",
      object_id: artifact.id,
      session_id: artifact.session_id,
      owner_key: ownerKey,
      rows: artifact.data?.rows.length ?? 0,
      complete: artifact.source.truncated === "none",
      truncated: artifact.source.truncated,
      client,
    });
    return { filename, body };
  }

  // ---------------------------------------------------------------- exports

  /**
   * CSV export of a raw result, streamed in one pass.
   *
   * A truncated result is exported too, but with `partial` in the filename and a header, so the file
   * cannot later be mistaken for the complete answer.
   */
  async resultCsv(resultId: string, ownerKey: string, client?: string) {
    const meta = await this.results.get(resultId);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${resultId} not found`);
    this.history.getSession(meta.sessionId, ownerKey);
    if (meta.error) throw new AppError("RESULT_FAILED", `Query did not complete successfully: ${meta.error}`);
    const partial = meta.truncated !== "none";
    await auditExport(this.app.dataDir, {
      format: "csv",
      object: "result",
      object_id: meta.id,
      session_id: meta.sessionId,
      owner_key: ownerKey,
      rows: meta.rowCount,
      complete: !partial,
      truncated: meta.truncated,
      client,
    });
    const header = csvLine(meta.columns.map((column) => column.name));
    const self = this.results;
    async function* body(): AsyncGenerator<string> {
      yield UTF8_BOM;
      yield header;
      for await (const row of self.iterateRows(meta!.id)) yield csvLine(row);
    }
    return {
      filename: `${meta.id}${partial ? "-partial" : ""}.csv`,
      truncated: meta.truncated,
      stream: body(),
    };
  }

  async closeSession(sessionId: string, ownerKey: string): Promise<void> {
    const session = this.getSession(sessionId, ownerKey);
    this.sessions.delete(sessionId);
    await session.close();
    // No live session can resolve these tasks any more, so their in-memory event logs are dead
    // weight. The ndjson log stays on disk and is still served by history reads.
    this.dropSessionEvents(sessionId, ownerKey);
  }

  /** Release bounded-but-per-task memory once the tasks cannot be watched again. */
  private dropSessionEvents(sessionId: string, ownerKey: string): void {
    try {
      for (const task of this.history.listTasks(sessionId, ownerKey)) this.broker.drop(task.id);
    } catch {
      // Purge already removed the history record; nothing left to resolve.
    }
  }

  /**
   * Delete a session on purpose: close it if live, then erase its history, results and artifacts.
   * Unlike closeSession this also works for sessions that only exist in history.
   */
  async deleteSession(sessionId: string, ownerKey: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (live && live.ownerKey !== ownerKey) throw new AppError("NOT_FOUND", `Session ${sessionId} not found`);
    if (!live) this.history.getSession(sessionId, ownerKey);
    const tasks = this.history.listTasks(sessionId, ownerKey);
    if (live) {
      this.sessions.delete(sessionId);
      await live.close();
    }
    await this.artifacts.store.deleteSession(sessionId);
    await this.results.serializeWrite(sessionId, async () => {
      await this.results.deleteSession(sessionId);
      await rm(join(this.app.dataDir, "snapshots", sessionId + ".json"), { force: true });
    });
    await rm(join(this.app.dataDir, "conversations", sessionId), { recursive: true, force: true });
    await rm(join(this.app.dataDir, "workspaces", sessionId), { recursive: true, force: true });
    this.history.deleteSession(sessionId, ownerKey);
    for (const task of tasks) this.broker.drop(task.id);
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

  listTasksWithActivity(sessionId: string, ownerKey: string): TaskRecord[] {
    return this.history.listTasks(sessionId, ownerKey).map((task) => {
      if (task.activity || ["queued", "running", "waiting_for_user"].includes(task.status)) return task;
      // Backfill a small optional summary once; keep large details on demand.
      task.activity = taskActivity(task, this.history.listEvents(task.id)).summary;
      this.history.saveTask(ownerKey, task);
      return task;
    });
  }

  taskActivity(taskId: string, ownerKey: string) {
    const { task } = this.findTask(taskId, ownerKey);
    return taskActivity(task, this.history.listEvents(taskId));
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

  async businessReport(resultId: string, ownerKey: string) {
    const meta = await this.results.get(resultId);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", "Result not found");
    this.history.getSession(meta.sessionId, ownerKey);
    return readBusinessView(this.results, meta);
  }

  async resultEvidence(ref: string, ownerKey: string) {
    const target = parseResultValueRef(ref);
    if (!target) throw new AppError("INVALID_INPUT", "Invalid result reference");
    const page = await this.readResult(target.id, ownerKey, target.row, 1);
    const column = page.columns[target.column];
    if (!page.rows.length || !column) throw new AppError("NOT_FOUND", "Result cell not found");
    return { ref, row_index: target.row, column, value: page.rows[0]![target.column], row: page.rows[0], columns: page.columns, sql: page.sql, executed_at: page.createdAt };
  }

  async computeResult(resultId: string, ownerKey: string, operation: ResultOperation) {
    const page = await this.readResult(resultId, ownerKey, 0, 1);
    const meta = (await this.results.get(page.id))!;
    return localSql(this.results, meta, compileResultOperation(meta, operation), analysisOptions(this.app));
  }

  async resultSummary(resultId: string, ownerKey: string) {
    const page = await this.readResult(resultId, ownerKey, 0, 1);
    return summarize(this.results, (await this.results.get(page.id))!, analysisOptions(this.app));
  }

  async transformResult(resultId: string, ownerKey: string, sql: string, allowPartial = false) {
    const page = await this.readResult(resultId, ownerKey, 0, 1);
    const meta = (await this.results.get(page.id))!;
    return localSql(this.results, meta, sql, analysisOptions(this.app), { allowPartial });
  }

  async snapshots(sessionId: string, ownerKey: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    return new SnapshotStore(join(this.app.dataDir, "snapshots")).list(sessionId);
  }

  async createSnapshot(sessionId: string, ownerKey: string, resultId: string, name: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    return this.results.serializeWrite(sessionId, async () => {
      const meta = await ownedResult(this.results, resultId, sessionId);
      checkLocalSize(meta.rowCount, meta.bytes, analysisOptions(this.app));
      if (meta.truncated !== "none") throw new AppError("RESULT_FAILED", "A snapshot requires a complete input result");
      return new SnapshotStore(join(this.app.dataDir, "snapshots")).create(sessionId, resultId, name);
    });
  }

  async dropSnapshot(sessionId: string, ownerKey: string, snapshotId: string) {
    this.sessionSnapshot(sessionId, ownerKey);
    await this.results.serializeWrite(sessionId, () => new SnapshotStore(join(this.app.dataDir, "snapshots")).drop(sessionId, snapshotId));
  }

  async querySnapshot(sessionId: string, ownerKey: string, snapshotId: string, sql: string) {
    const snapshot = (await this.snapshots(sessionId, ownerKey)).find(s => s.id === snapshotId);
    if (!snapshot) throw new AppError("NOT_FOUND", "Snapshot not found");
    return this.transformResult(snapshot.result_id, ownerKey, sql);
  }

  async archiveArtifact(id: string, ownerKey: string, archived: boolean) {
    const artifact = await this.getArtifact(id, ownerKey);
    await this.artifacts.archive(id, artifact.session_id, archived);
  }

  async auditFigure(id: string, ownerKey: string, format: "png" | "svg", client?: string) {
    const artifact = await this.getArtifact(id, ownerKey);
    await auditExport(this.app.dataDir, { format, object: "artifact", object_id: id, owner_key: ownerKey, session_id: artifact.session_id, rows: artifact.data?.rows.length ?? 0, complete: artifact.source.truncated === "none", client });
  }

  // --------------------------------------------------------------- lifecycle

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const expired = session.expiresAt.getTime() <= now;
      if (!expired || session.isBusy) continue;
      this.sessions.delete(id);
      await session.close().catch(() => undefined);
      this.dropSessionEvents(id, session.ownerKey);
    }
    const days = analysisOptions(this.app).retentionDays;
    if (days > 0) {
      for (const { id, owner, at } of this.history.retentionCandidates()) {
        const timestamp = Date.parse(at);
        if (this.sessions.has(id) || !Number.isFinite(timestamp) || now - timestamp < days * 86_400_000) continue;
        await this.deleteSession(id, owner);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.accounts?.close();
    if (this.sweeper) clearInterval(this.sweeper);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.businessCatalog.close();
  }
}
