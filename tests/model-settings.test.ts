import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  ModelPatch,
  ModelSettingsStore,
  effectiveModel,
  mergeOverrides,
} from "../src/agent/model-settings.js";
import { AnalysisService } from "../src/agent/service.js";
import { toolCatalog } from "../src/agent/tools.js";
import { createDatabaseTools } from "../src/agent/tools.js";
import { createHttpApp } from "../src/api/http.js";
import type { AppConfig } from "../src/config.js";
import { cleanup, testConfig } from "./support.js";

const envModel = { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "medium" as const, apiKey: "env-key", contextWindow: 64_000 };

it("layers console overrides over the environment and drops them back with null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-agent-model-"));
  const path = join(dir, "model-settings.json");
  try {
    const store = new ModelSettingsStore(path);
    assert.equal(store.state().status, "missing");

    const overrides = mergeOverrides(store.get(), ModelPatch.parse({ modelId: "deepseek-flash", thinkingLevel: "high" }));
    store.save(overrides);
    assert.equal(store.state().status, "ok");

    // A new process reads the same file: overrides survive, the environment stays the floor.
    const reloaded = new ModelSettingsStore(path);
    const effective = effectiveModel(envModel, reloaded.get(), "console-key");
    assert.equal(effective.modelId, "deepseek-flash");
    assert.equal(effective.thinkingLevel, "high");
    assert.equal(effective.provider, "openai");
    assert.equal(effective.contextWindow, 64_000);
    assert.equal(effective.apiKey, "console-key");

    // `null` clears a field, absent leaves it alone.
    const cleared = mergeOverrides(reloaded.get(), ModelPatch.parse({ thinkingLevel: null }));
    assert.equal(cleared.thinkingLevel, undefined);
    assert.equal(cleared.modelId, "deepseek-flash");
    assert.equal(effectiveModel(envModel, cleared).thinkingLevel, "medium");

    reloaded.clear();
    assert.equal(reloaded.state().status, "missing");
    assert.equal(existsSync(path), false);
    // With nothing stored, the effective configuration is the environment one (undefined keys aside).
    const baseless = effectiveModel(envModel, reloaded.get());
    assert.equal(baseless.provider, envModel.provider);
    assert.equal(baseless.modelId, envModel.modelId);
    assert.equal(baseless.thinkingLevel, envModel.thinkingLevel);
    assert.equal(baseless.apiKey, envModel.apiKey);
    assert.equal(baseless.baseUrl, undefined);  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("never persists the API key and ignores an unreadable settings file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-agent-model-"));
  const path = join(dir, "model-settings.json");
  try {
    const store = new ModelSettingsStore(path);
    store.save(mergeOverrides(store.get(), ModelPatch.parse({ modelId: "m1", apiKey: "sk-should-not-land" })));
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("sk-should-not-land"), false);
    assert.equal(raw.includes("apiKey"), false);

    const corrupted = new ModelSettingsStore(join(dir, "broken.json"));
    await rm(join(dir, "broken.json"), { force: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    const damaged = new ModelSettingsStore(join(dir, "broken.json"));
    assert.equal(damaged.state().status, "invalid");
    assert.deepEqual(damaged.get(), {});
    assert.equal(corrupted.state().status, "missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("exposes model settings over HTTP, refuses edits when disabled, and validates patches", async () => {
  const config = await testConfig();
  config.allowModelEdit = true;
  let service: AnalysisService | undefined;
  let server: Server | undefined;
  try {
    service = await AnalysisService.create(config);
    const app = await createHttpApp(service);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };

    const view = await call("GET", "/v1/model");
    assert.equal(view.status, 200);
    assert.equal(view.body.provider, "openai");
    assert.equal(view.body.model_id, "gpt-5.2");
    assert.equal(view.body.editable, true);
    assert.equal(view.body.api_key_source, "none");
    assert.ok(Array.isArray(view.body.thinking_levels));
    assert.equal("apiKey" in view.body, false);
    // The view reports what the runtime will really use, not our defaults: openai/gpt-5.2 is served
    // over the Responses API with a 400k window, which the console must not misreport as 128k.
    assert.equal(view.body.api, "openai-responses");
    assert.equal(view.body.base_url, "https://api.openai.com/v1");
    assert.equal(view.body.context_window, 400_000);
    assert.equal(view.body.max_tokens, 128_000);
    assert.equal(view.body.reasoning, true);
    // pi's catalogue declares both modalities for this model; a custom endpoint only claims text.
    assert.deepEqual(view.body.input, ["text", "image"]);
    assert.deepEqual(view.body.api_options.map((option: { id: string }) => option.id), [
      "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai",
    ]);
    // Nothing was configured in the environment, so the baseline leaves the numbers unset.
    assert.deepEqual(view.body.env_model, {
      provider: "openai", model_id: "gpt-5.2", api: "openai-completions",
      base_url: null, thinking_level: "off", reasoning: null,
      context_window: null, max_tokens: null,
    });

    // A no-op save (everything null = "same as .env") must not create an override file at all.
    const noop = await call("PUT", "/v1/model", {
      provider: null, modelId: null, api: null, baseUrl: null,
      thinkingLevel: null, reasoning: null, contextWindow: null, maxTokens: null,
    });
    assert.equal(noop.status, 200);
    assert.deepEqual(noop.body.overrides, {});
    assert.equal(existsSync(join(config.dataDir, "model-settings.json")), false);

    // A protocol without a base URL cannot describe an endpoint, so it is refused, not ignored.
    const bareApi = await call("PUT", "/v1/model", { api: "anthropic-messages" });
    assert.equal(bareApi.status, 400);
    assert.match(bareApi.body.error.message, /requires a baseUrl/);
    const unknownApi = await call("PUT", "/v1/model", { api: "no-such-api" });
    assert.equal(unknownApi.status, 400);
    assert.match(unknownApi.body.error.message, /openai-completions/);
    // A credential pi cannot supply here is refused with what it would need instead.
    const bedrock = await call("PUT", "/v1/model", { api: "bedrock-converse-stream", baseUrl: "https://bedrock.example.com" });
    assert.equal(bedrock.status, 400);
    assert.match(bedrock.body.error.message, /requires AWS credentials/);

    // No key resolves in the test config, so the probe reports that instead of calling out.
    const probe = await call("POST", "/v1/model/test");
    assert.equal(probe.status, 200);
    assert.equal(probe.body.ok, false);
    assert.match(probe.body.error, /No API key resolved/);

    // The API key is accepted but never echoed back.
    const saved = await call("PUT", "/v1/model", { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "high", apiKey: "console-secret" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.thinking_level, "high");
    assert.equal(saved.body.reasoning, true);
    assert.equal(saved.body.has_api_key, true);
    assert.equal(saved.body.api_key_source, "console");
    assert.equal(JSON.stringify(saved.body).includes("console-secret"), false);
    assert.equal(saved.body.override_sources.thinkingLevel, "console");

    const persisted = await readFile(join(config.dataDir, "model-settings.json"), "utf8");
    assert.equal(persisted.includes("console-secret"), false);
    assert.equal(JSON.parse(persisted).overrides.thinkingLevel, "high");

    // A restart keeps the persisted overrides but not the console API key, which is memory-only.
    const restarted = await AnalysisService.create(config);
    try {
      const view = restarted.modelView();
      assert.equal(view.thinking_level, "high");
      assert.equal(view.override_sources.thinkingLevel, "console");
      assert.equal(view.api_key_source, "none");
    } finally {
      await restarted.shutdown();
    }

    const invalid = await call("PUT", "/v1/model", { thinkingLevel: "turbo" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_INPUT");

    const tooBig = await call("PUT", "/v1/model", { contextWindow: 8_000, maxTokens: 32_000 });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.error.message, /maxTokens cannot exceed contextWindow/);

    const unknownModel = await call("PUT", "/v1/model", { provider: "openai", modelId: "no-such-model" });
    assert.equal(unknownModel.status, 503);
    assert.equal(unknownModel.body.error.code, "MODEL_NOT_CONFIGURED");
    // A rejected patch must leave the previous, working configuration untouched.
    const after = await call("GET", "/v1/model");
    assert.equal(after.body.thinking_level, "high");

    // Serving the same model through a gateway must keep the window pi knows about, not pi's 128k
    // fallback for hand-written model metadata.
    const gateway = await call("PUT", "/v1/model", { api: "anthropic-messages", baseUrl: "https://gw.example.com/v1" });
    assert.equal(gateway.status, 200);
    assert.equal(gateway.body.api, "anthropic-messages");
    assert.equal(gateway.body.base_url, "https://gw.example.com/v1");
    assert.equal(gateway.body.context_window, 400_000);
    assert.equal(gateway.body.max_tokens, 128_000);
    assert.deepEqual(gateway.body.input, ["text"]);
    const backToBuiltIn = await call("PUT", "/v1/model", { api: null, baseUrl: null });
    assert.equal(backToBuiltIn.body.api, "openai-responses");
    assert.equal(backToBuiltIn.body.context_window, 400_000);

    // Overriding a limit on a built-in model applies to the real handle, and the view echoes it.
    const narrowed = await call("PUT", "/v1/model", { contextWindow: 64_000, maxTokens: 16_000 });
    assert.equal(narrowed.status, 200);
    assert.equal(narrowed.body.context_window, 64_000);
    assert.equal(narrowed.body.max_tokens, 16_000);
    assert.equal(narrowed.body.override_sources.contextWindow, "console");
    // The endpoint still comes from pi's catalogue, so the provider block stays untouched.
    assert.equal(narrowed.body.base_url, "https://api.openai.com/v1");

    const reset = await call("DELETE", "/v1/model");
    assert.equal(reset.status, 200);
    // testConfig() starts from thinking=off, so reset must fall back to that environment value.
    assert.equal(reset.body.thinking_level, "off");
    assert.equal(reset.body.api_key_source, "none");
    assert.equal(existsSync(join(config.dataDir, "model-settings.json")), false);

    config.allowModelEdit = false;
    const denied = await call("PUT", "/v1/model", { modelId: "gpt-5.2" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "MODEL_EDIT_DISABLED");
  } finally {
    if (server) await new Promise((resolve) => server!.close(resolve));
    await service?.shutdown();
    await cleanup(config);
  }
});

it("describes every agent tool from metadata alone and stays in sync with the factory", () => {
  const catalog = toolCatalog();
  const built = createDatabaseTools({ db: {}, budgets: {} } as never).map((tool) => tool.name);
  assert.deepEqual(catalog.map((tool) => tool.name), built);
  assert.equal(catalog.length, 12);

  const sql = catalog.find((tool) => tool.name === "query_execute")!;
  assert.match(sql.description, /SELECT/);
  assert.equal(sql.readOnly, true);
  assert.equal(sql.sequential, true);
  assert.deepEqual(sql.parameters.map((param) => param.name), ["sql", "label", "max_rows"]);
  assert.equal(sql.parameters.find((param) => param.name === "sql")!.required, true);
  assert.equal(sql.parameters.find((param) => param.name === "label")!.required, false);
  assert.equal(sql.parameters.find((param) => param.name === "label")!.type, "string");

  // DDL is the one write path: not read-only, and dropping a dataset is destructive.
  assert.equal(catalog.find((tool) => tool.name === "dataset_create")!.readOnly, false);
  assert.equal(catalog.find((tool) => tool.name === "dataset_drop")!.destructive, true);

  const info = catalog.find((tool) => tool.name === "session_info")!;
  assert.equal(info.readOnly, true);
  assert.deepEqual(info.parameters, []);
});

it("lists the operator's own pi channels and switches between them", async () => {
  const config = await testConfig();
  config.allowModelEdit = true;
  const dir = await mkdtemp(join(tmpdir(), "data-agent-pi-channels-"));
  const modelsPath = join(dir, "models.json");
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        "my-gw": {
          api: "openai-completions",
          baseUrl: "https://gw.example.com/v1",
          apiKey: "gw-secret-key",
          models: [{ id: "alpha", name: "Alpha", reasoning: true }, { id: "beta" }],
        },
      },
    }),
  );
  await writeFile(settingsPath, JSON.stringify({ enabledModels: ["my-gw/*"] }));
  config.piModelsPath = modelsPath;
  config.piSettingsPath = settingsPath;
  let service: AnalysisService | undefined;
  let server: Server | undefined;
  try {
    service = await AnalysisService.create(config);
    const app = await createHttpApp(service);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };

    const catalog = await call("GET", "/v1/model/channels");
    assert.equal(catalog.status, 200);
    const channel = catalog.body.channels.find((entry: { id: string }) => entry.id === "my-gw");
    assert.ok(channel, "the imported channel must be listed");
    assert.equal(channel.source, "pi-models");
    assert.equal(channel.ready, true);
    assert.equal(channel.key_source, "channel");
    assert.equal(channel.total_count, 2);
    assert.equal(channel.enabled_count, 2);
    // enabledModels is what narrows pi's own catalogue, so the built-in channels stay hidden.
    assert.equal(catalog.body.filtered, true);
    assert.equal(catalog.body.sources.models.status, "ok");
    assert.equal(JSON.stringify(catalog.body).includes("gw-secret-key"), false);

    const selected = await call("POST", "/v1/model/select", { provider: "my-gw", modelId: "alpha" });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.provider, "my-gw");
    assert.equal(selected.body.model_id, "alpha");
    assert.equal(selected.body.api, "openai-completions");
    assert.equal(selected.body.base_url, "https://gw.example.com/v1");
    assert.equal(selected.body.reasoning, true);
    // The key came from the operator's models.json and stayed in memory.
    assert.equal(selected.body.has_api_key, true);
    assert.equal(selected.body.api_key_source, "channel");
    assert.equal(selected.body.ready, true);
    // Switching channels must not pin the endpoint: the pi config stays the source of truth.
    const persisted = JSON.parse(await readFile(join(config.dataDir, "model-settings.json"), "utf8"));
    assert.deepEqual(persisted.overrides, { provider: "my-gw", modelId: "alpha" });

    const after = await call("GET", "/v1/model/channels");
    assert.equal(after.body.active.provider, "my-gw");
    assert.equal(after.body.active.model_id, "alpha");
    // openai is neither enabled nor configured, so it drops out of the list once it is not active.
    assert.equal(after.body.channels.some((entry: { id: string }) => entry.id === "openai"), false);

    const unknown = await call("POST", "/v1/model/select", { provider: "my-gw", modelId: "nope" });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error.code, "MODEL_NOT_CONFIGURED");
    const stillThere = await call("GET", "/v1/model");
    assert.equal(stillThere.body.model_id, "alpha");

    const invalid = await call("POST", "/v1/model/select", { provider: "" });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error.message, /modelId/);
  } finally {
    if (server) await new Promise((resolve) => server!.close(resolve));
    await service?.shutdown();
    await cleanup(config);
    await rm(dir, { recursive: true, force: true });
  }
});

it("never forwards the env api key to another provider's endpoint", async () => {
  const config = await testConfig();
  config.allowModelEdit = true;
  // The `.env` key belongs to openai; the gateway below would see it if the switch reused it.
  config.model.apiKey = "sk-env-openai-secret";
  const dir = await mkdtemp(join(tmpdir(), "data-agent-pi-key-scope-"));
  const modelsPath = join(dir, "models.json");
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        "my-gw": { api: "openai-completions", baseUrl: "https://gw.example.com/v1", apiKey: "gw-key", models: [{ id: "alpha" }] },
      },
    }),
  );
  await writeFile(settingsPath, JSON.stringify({ enabledModels: ["my-gw/*"] }));
  config.piModelsPath = modelsPath;
  config.piSettingsPath = settingsPath;
  let service: AnalysisService | undefined;
  let server: Server | undefined;
  try {
    service = await AnalysisService.create(config);
    const app = await createHttpApp(service);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };

    assert.equal((await call("GET", "/v1/model")).body.api_key_source, "env");
    const selected = await call("POST", "/v1/model/select", { provider: "my-gw", modelId: "alpha" });
    assert.equal(selected.status, 200);
    // "channel" proves the env key was dropped: had it survived, the handle would report "env".
    assert.equal(selected.body.api_key_source, "channel");
    assert.equal(selected.body.has_api_key, true);
    assert.equal(selected.body.env_model.provider, "openai");

    // Coming back to the env provider still resolves the env key.
    const back = await call("POST", "/v1/model/select", { provider: "openai", modelId: "gpt-5.2" });
    assert.equal(back.status, 200);
    assert.equal(back.body.api_key_source, "env");
  } finally {
    if (server) await new Promise((resolve) => server!.close(resolve));
    await service?.shutdown();
    await cleanup(config);
    await rm(dir, { recursive: true, force: true });
  }
});
