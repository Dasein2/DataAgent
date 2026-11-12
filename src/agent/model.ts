import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";

export interface ModelHandle {
  runtime: ModelRuntime;
  model: Model<any>;
  /** False when no credential (env key, runtime key or auth store) resolves — tasks will fail. */
  hasAuth: boolean;
}

function providerBlock(app: AppConfig) {
  const model = app.model;
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    api: model.api ?? "openai-completions",
    headers: model.headers,
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        reasoning: false,
        input: ["text"],
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

/**
 * Builds the pi model runtime once. Custom endpoints are described in models.json;
 * the API key is only ever held in memory (setRuntimeApiKey), never written to disk.
 */
export async function createModelHandle(app: AppConfig): Promise<ModelHandle> {
  const dir = join(app.dataDir, "pi");
  await mkdir(dir, { recursive: true });
  const modelsPath = join(dir, "models.json");
  // An operator can point at an existing pi credential store instead of exporting a key; secrets are
  // still only read, never written, and never logged.
  const authPath = app.model.authPath ?? join(dir, "auth.json");

  const customEndpoint = Boolean(app.model.baseUrl || app.model.api || app.model.headers);
  const modelsFile = customEndpoint
    ? { $schema: "https://pi.dev/schemas/models.schema.json", providers: { [app.model.provider]: providerBlock(app) } }
    : { providers: {} };
  await writeFile(modelsPath, JSON.stringify(modelsFile, null, 2), "utf8");

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  if (app.model.apiKey) {
    await runtime.setRuntimeApiKey(app.model.provider, app.model.apiKey);
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

  const hasAuth = runtime.getProviderAuthStatus(app.model.provider).configured;
  return { runtime, model, hasAuth };
}
