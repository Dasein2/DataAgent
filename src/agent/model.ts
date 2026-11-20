import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig, ModelConfig } from "../config.js";
import { AppError } from "../errors.js";
import { DEFAULT_MODEL_API, findModelApi } from "./model-apis.js";
import { readPiConfig } from "./pi-config.js";
import { providerBlocks, type ProviderConfig } from "./provider-store.js";

export interface ManagedRuntimeConfig {
  providers: Record<string, ProviderConfig>;
  key?: string;
  headers?: Record<string, string>;
}

/** Where the credential for the active model came from. Never includes the secret itself. */
export type ModelKeySource = "console" | "env" | "channel" | "managed" | "none";

export interface ModelHandle {
  runtime: ModelRuntime;
  model: Model<any>;
  /** False when no credential (env key, runtime key or auth store) resolves — tasks will fail. */
  hasAuth: boolean;
  keySource: ModelKeySource;
}

/**
 * Modalities we declare for the model. The console has no attachment path, so an image-capable
 * model would only advertise something this service cannot send.
 */
const INPUT_MODALITIES: readonly string[] = ["text"];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Whether pi is told the model can think. pi clamps every custom endpoint to "off" unless the model
 * metadata says `reasoning: true`, so the thinking level implies it; `DATA_AGENT_MODEL_REASONING`
 * can turn it back off for a model that rejects reasoning parameters.
 */
export function declaresReasoning(model: ModelConfig): boolean {
  return model.reasoning ?? model.thinkingLevel !== "off";
}

/** A base URL, protocol or header set means the operator described the endpoint themselves. */
export function isCustomEndpoint(model: ModelConfig): boolean {
  return Boolean(model.baseUrl || model.api || model.headers);
}

function customProviderBlock(model: ModelConfig) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    api: model.api ?? DEFAULT_MODEL_API,
    headers: model.headers,
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        reasoning: declaresReasoning(model),
        input: INPUT_MODALITIES,
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? 16_384,
        cost: ZERO_COST,
      },
    ],
  };
}

/**
 * Without a base URL the provider keeps pi's built-in catalogue, which already knows the endpoint,
 * protocol and true limits. Only the explicitly configured fields are overridden, so capabilities
 * such as a 1M context window are not silently replaced by our 128k defaults.
 */
function builtInProviderEntry(model: ModelConfig) {
  const overrides: Record<string, unknown> = {};
  if (model.reasoning !== undefined) overrides.reasoning = model.reasoning;
  if (model.contextWindow !== undefined) overrides.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) overrides.maxTokens = model.maxTokens;
  return overrides;
}

/**
 * models.json for the current configuration. Providers imported from the operator's own pi config are
 * echoed back **without** their credentials so switching channels needs no retyping; an empty map
 * means everything comes from pi's catalogue.
 */
export function modelsFileFor(
  model: ModelConfig,
  imported: Record<string, Record<string, unknown>> = {},
) {
  const schema = "https://pi.dev/schemas/models.schema.json";
  const providers: Record<string, unknown> = { ...imported };
  if (isCustomEndpoint(model)) {
    providers[model.provider] = customProviderBlock(model);
  } else {
    const overrides = builtInProviderEntry(model);
    if (Object.keys(overrides).length) {
      const existing = (providers[model.provider] ?? {}) as { modelOverrides?: Record<string, unknown> };
      providers[model.provider] = {
        ...existing,
        modelOverrides: { ...(existing.modelOverrides ?? {}), [model.modelId]: overrides },
      };
    }
  }
  return { $schema: schema, providers };
}

/**
 * Builds the pi model runtime once. Custom endpoints are described in models.json; the API key is
 * passed straight to `setRuntimeApiKey` and never enters the generated file.
 *
 * `consoleKey` is the key the operator saved in the console for this provider; it wins over `.env`
 * and over the provider's own pi credential.
 */
export async function createModelHandle(app: AppConfig, consoleKey?: string, managed?: ManagedRuntimeConfig, runtimeDir?: string): Promise<ModelHandle> {
  // Session catalogues must not overwrite the global default's models.json.
  const dir = runtimeDir ?? join(app.dataDir, "pi");
  await mkdir(dir, { recursive: true });
  const modelsPath = join(dir, "models.json");
  // An operator can point at an existing pi credential store instead of exporting a key; secrets are
  // still only read, never written, and never logged.
  const owned = managed && Object.hasOwn(managed.providers, app.model.provider) ? managed.providers[app.model.provider] : undefined;
  const authPath = owned ? join(dir, "managed-auth.json") : app.model.authPath ?? join(app.dataDir, "pi", "auth.json");
  // Channels the operator already configured in pi; keys stay in memory (see `pi-config.ts`).
  const pi = readPiConfig(app.piModelsPath, app.piSettingsPath);

  // pi accepts an unknown protocol and only fails when a request is made; reject it up front.
  const api = findModelApi(app.model.api);
  if (!owned && app.model.api && !api) {
    throw new AppError("MODEL_NOT_CONFIGURED", `Unknown DATA_AGENT_MODEL_API "${app.model.api}"`);
  }
  // A protocol without a base URL cannot describe a provider: pi's built-in catalogue already has
  // the right one, so the operator most likely meant to leave this unset.
  if (!owned && app.model.api && !app.model.baseUrl) {
    throw new AppError(
      "MODEL_NOT_CONFIGURED",
      `DATA_AGENT_MODEL_API=${app.model.api} needs DATA_AGENT_MODEL_BASE_URL. ` +
        "Leave the protocol unset to use the provider's built-in endpoint and protocol.",
    );
  }
  if (!owned && api && !api.selectable && isCustomEndpoint(app.model)) {
    throw new AppError(
      "MODEL_NOT_CONFIGURED",
      `${api.id} is not supported by this service: it requires ${api.requires}. ${api.note}`,
    );
  }

  // Managed channels own the entire endpoint definition. Environment overrides must not silently
  // replace it, nor may an identically named pi provider supply credentials to it.
  const definition = owned ? { ...app.model, api: undefined, baseUrl: undefined, headers: undefined,
    contextWindow: undefined, maxTokens: undefined, reasoning: undefined } : app.model;
  const imported = { ...pi.providers, ...providerBlocks(managed?.providers ?? {}) };
  await writeFile(modelsPath, JSON.stringify(modelsFileFor(definition, imported), null, 2), { encoding: "utf8", mode: 0o600 });

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
    // Restores the local credential/catalogue snapshot so `getProviderAuthStatus()` knows about keys
    // that live in pi's auth store. No network happens while `allowModelNetwork` is false.
    refreshOnCreate: true,
  });

  const loadError = runtime.getError();
  if (loadError) throw new AppError("MODEL_NOT_CONFIGURED", `models.json was rejected: ${loadError}`);

  // An explicit key wins over the one from the operator's models.json; neither is written anywhere.
  const channelKey = pi.apiKeys[app.model.provider];
  const apiKey = owned ? (owned.authMode === "none" ? "local-no-auth" : managed?.key)
    : consoleKey ?? app.model.apiKey ?? channelKey;
  const keySource: ModelKeySource = owned ? (apiKey ? "managed" : "none") : consoleKey
    ? "console"
    : app.model.apiKey
      ? "env"
      : channelKey
        ? "channel"
        : "none";
  if (apiKey) {
    await runtime.setRuntimeApiKey(app.model.provider, apiKey);
  }

  const model = runtime.getModel(app.model.provider, app.model.modelId);
  if (!model) {
    const available = runtime
      .getModels(app.model.provider)
      .slice(0, 10)
      .map((entry) => entry.id);
    throw new AppError(
      "MODEL_NOT_CONFIGURED",
      `Model ${app.model.provider}/${app.model.modelId} is not available. ` +
        (available.length
          ? `Known models for this provider: ${available.join(", ")}.`
          : "Check DATA_AGENT_MODEL_PROVIDER, DATA_AGENT_MODEL_ID, DATA_AGENT_MODEL_BASE_URL and DATA_AGENT_MODEL_API."),
    );
  }

  const hasAuth = owned ? Boolean(apiKey) : runtime.getProviderAuthStatus(app.model.provider).configured;
  // Private headers never enter generated JSON or API responses. Prevent credential expressions
  // from being evaluated by pi: project-owned values are literal and validated on input.
  const activeModel = owned ? { ...model, headers: { ...model.headers, ...managed?.headers } } : model;
  return { runtime, model: activeModel, hasAuth, keySource };
}
