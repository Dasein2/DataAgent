import assert from "node:assert/strict";
import { it } from "node:test";
import { MODEL_APIS, SELECTABLE_MODEL_APIS, findModelApi, unknownApiMessage } from "../src/agent/model-apis.js";
import { createModelHandle, declaresReasoning, isCustomEndpoint, modelsFileFor } from "../src/agent/model.js";
import { ModelPatch, effectiveModel } from "../src/agent/model-settings.js";
import { cleanup, testConfig } from "./support.js";

const BASE = { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "medium" as const };

it("offers every protocol that works with a plain base URL and key", async () => {
  const selectable = SELECTABLE_MODEL_APIS.map((api) => api.id);
  // The four protocols a gateway can realistically expose; keep this in sync with the console.
  assert.deepEqual(selectable, [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ]);
  // Everything else is known but must say what extra credential it needs.
  for (const api of MODEL_APIS.filter((entry) => !entry.selectable)) {
    assert.ok(api.requires, `${api.id} must explain what it needs`);
  }
  assert.equal(findModelApi("nope"), undefined);
  assert.match(unknownApiMessage("nope", "DATA_AGENT_MODEL_API"), /openai-completions/);

  // Each selectable protocol must actually produce a usable model handle.
  for (const id of selectable) {
    const config = await testConfig();
    try {
      config.model = { ...BASE, api: id, baseUrl: "https://gateway.example.com/v1" };
      const handle = await createModelHandle(config);
      assert.equal(handle.model.api, id);
      assert.equal(handle.model.provider, "openai");
      assert.deepEqual(handle.model.input, ["text"]);
      assert.equal(handle.model.reasoning, true);
      // No key was configured, so readiness must be false rather than a silent success.
      assert.equal(handle.hasAuth, false);
    } finally {
      await cleanup(config);
    }
  }
});

it("describes a custom endpoint only when one was configured", () => {
  assert.deepEqual(modelsFileFor(BASE).providers, {});
  assert.equal(isCustomEndpoint(BASE), false);

  // A built-in provider keeps pi's catalogue; only explicit fields are overridden, so a 1M context
  // window is not replaced by our 128k default.
  const overridden = modelsFileFor({ ...BASE, contextWindow: 64_000 });
  assert.deepEqual(overridden.providers, {
    openai: { modelOverrides: { "gpt-5.2": { contextWindow: 64_000 } } },
  });
  assert.deepEqual(modelsFileFor({ ...BASE, reasoning: false }).providers, {
    openai: { modelOverrides: { "gpt-5.2": { reasoning: false } } },
  });

  const custom = modelsFileFor({ ...BASE, baseUrl: "https://gw.example.com/v1" });
  const block = (custom as any).providers.openai;
  assert.equal(block.api, "openai-completions");
  assert.equal(block.baseUrl, "https://gw.example.com/v1");
  assert.equal(block.models[0].id, "gpt-5.2");
  assert.equal(block.models[0].reasoning, true);
  assert.deepEqual(block.models[0].input, ["text"]);
});

it("implies reasoning from the thinking level unless it is set explicitly", () => {
  assert.equal(declaresReasoning({ ...BASE, thinkingLevel: "high" }), true);
  assert.equal(declaresReasoning({ ...BASE, thinkingLevel: "off" }), false);
  // An explicit false lets a non-reasoning model reject reasoning parameters.
  assert.equal(declaresReasoning({ ...BASE, thinkingLevel: "high", reasoning: false }), false);
  assert.equal(declaresReasoning({ ...BASE, thinkingLevel: "off", reasoning: true }), true);
});

it("rejects a protocol that cannot describe an endpoint, before any request is made", async () => {
  const cases: { model: Record<string, unknown>; match: RegExp }[] = [
    // pi's built-in provider already has its own protocol; a bare protocol describes nothing.
    { model: { api: "anthropic-messages" }, match: /needs DATA_AGENT_MODEL_BASE_URL/ },
    { model: { api: "not-a-protocol", baseUrl: "https://gw.example.com" }, match: /Unknown DATA_AGENT_MODEL_API/ },
    {
      model: { api: "bedrock-converse-stream", baseUrl: "https://bedrock.example.com" },
      match: /requires AWS credentials/,
    },
  ];
  for (const { model, match } of cases) {
    const config = await testConfig();
    try {
      config.model = { ...BASE, ...(model as object) };
      await assert.rejects(createModelHandle(config), (error: Error & { code?: string }) => {
        assert.equal(error.code, "MODEL_NOT_CONFIGURED");
        assert.match(error.message, match);
        return true;
      });
    } finally {
      await cleanup(config);
    }
  }
});

it("applies built-in overrides to the real model and validates the protocol in a patch", async () => {
  const config = await testConfig();
  try {
    config.model = { ...BASE, contextWindow: 64_000, maxTokens: 8_000, reasoning: false };
    const handle = await createModelHandle(config);
    assert.equal(handle.model.contextWindow, 64_000);
    assert.equal(handle.model.maxTokens, 8_000);
    assert.equal(handle.model.reasoning, false);

    // The patch schema is the other entry point, so an unknown protocol must fail there too.
    assert.equal(ModelPatch.safeParse({ api: "openai-completions" }).success, true);
    assert.equal(ModelPatch.safeParse({ api: "nope" }).success, false);
    assert.equal(ModelPatch.safeParse({ reasoning: null }).success, true);
    const merged = effectiveModel(
      { ...BASE, reasoning: true },
      ModelPatch.parse({ reasoning: null }) as Record<string, never>,
    );
    // `null` clears the override, so the environment value comes back.
    assert.equal(merged.reasoning, true);
  } finally {
    await cleanup(config);
  }
});
