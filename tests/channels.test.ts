import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildChannelCatalog } from "../src/agent/channels.js";
import { modelsFileFor } from "../src/agent/model.js";
import { isModelEnabled, readPiConfig } from "../src/agent/pi-config.js";

const SECRET = "sk-secret-value-1234567890";

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-channels-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeConfigs(dir: string) {
  const modelsPath = join(dir, "models.json");
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "my-gw": {
          api: "openai-completions",
          baseUrl: "https://gw.example.com/v1",
          apiKey: SECRET,
          models: [
            { id: "alpha", name: "Alpha", reasoning: true, input: ["text", "image"] },
            { id: "beta" },
          ],
        },
        "referenced-gw": {
          api: "openai-completions",
          baseUrl: "https://ref.example.com/v1",
          apiKey: "${MY_GW_KEY}",
          models: [{ id: "gamma" }],
        },
      },
    }),
  );
  writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["my-gw/alpha", "deepseek/*"] }));
  return { modelsPath, settingsPath };
}

async function runtimeFor(dir: string, providers: Record<string, unknown>) {
  const modelsPath = join(dir, "generated-models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers }));
  return ModelRuntime.create({ modelsPath, allowModelNetwork: false, refreshOnCreate: false });
}

test("imports pi channels without copying their credentials", async () => {
  const { dir, cleanup } = workspace();
  try {
    const { modelsPath, settingsPath } = writeConfigs(dir);
    const pi = readPiConfig(modelsPath, settingsPath);
    assert.equal(pi.models.status, "ok");
    assert.equal(pi.settings.status, "ok");
    assert.deepEqual(pi.enabledModels, ["my-gw/alpha", "deepseek/*"]);
    // The key is available in memory, but never in the block we would write back out.
    assert.equal(pi.apiKeys["my-gw"], SECRET);
    assert.equal(pi.providers["my-gw"]?.apiKey, undefined);
    // `${VAR}` is a reference pi resolves itself, so it is not a secret we must hold.
    assert.equal(pi.apiKeys["referenced-gw"], undefined);
    assert.equal(pi.providers["referenced-gw"]?.apiKey, "${MY_GW_KEY}");

    const runtime = await runtimeFor(dir, pi.providers);
    const catalog = buildChannelCatalog({
      runtime,
      pi,
      active: { provider: "my-gw", model_id: "alpha" },
    });
    const channel = catalog.channels.find((entry) => entry.id === "my-gw");
    assert.ok(channel, "the imported channel must be listed");
    assert.equal(channel.source, "pi-models");
    assert.equal(channel.total_count, 2);
    assert.equal(channel.enabled_count, 1);
    // Enabled models come first so the console can show them without a second sort.
    assert.equal(channel.models[0]?.id, "alpha");
    assert.equal(channel.models[0]?.enabled, true);
    assert.equal(channel.models[1]?.enabled, false);
    // Readiness comes from the imported key, not from the generated models.json.
    assert.equal(channel.ready, true);
    assert.equal(channel.key_source, "channel");
    assert.equal(catalog.active.provider, "my-gw");
    assert.equal(JSON.stringify(catalog).includes(SECRET), false, "the catalogue must never echo a key");
  } finally {
    cleanup();
  }
});

test("reads the channel pi starts on so the service can follow it", () => {
  const { dir, cleanup } = workspace();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProvider: "PackyAPI国产", defaultModel: "deepseek-flash", defaultThinkingLevel: "xhigh" }),
    );
    assert.deepEqual(readPiConfig(undefined, settingsPath).defaults, {
      provider: "PackyAPI国产",
      modelId: "deepseek-flash",
      thinkingLevel: "xhigh",
    });
    // A settings.json without those keys, or a broken one, must not invent a default.
    writeFileSync(join(dir, "plain.json"), JSON.stringify({ theme: "light" }));
    assert.deepEqual(readPiConfig(undefined, join(dir, "plain.json")).defaults, {});
    writeFileSync(join(dir, "broken.json"), "{ not json");
    assert.deepEqual(readPiConfig(undefined, join(dir, "broken.json")).defaults, {});
    assert.deepEqual(readPiConfig(undefined, undefined).defaults, {});
  } finally {
    cleanup();
  }
});

test("matches enabledModels globs the way pi does", () => {
  const globs = ["deepseek/*", "moonshotai-cn/kimi-k3", "*/*-local"];
  assert.equal(isModelEnabled(globs, "deepseek", "deepseek-flash"), true);
  assert.equal(isModelEnabled(globs, "moonshotai-cn", "kimi-k3"), true);
  assert.equal(isModelEnabled(globs, "moonshotai-cn", "kimi-k2"), false);
  assert.equal(isModelEnabled(globs, "openai", "gpt-5.2-local"), true);
  assert.equal(isModelEnabled(globs, "openai", "gpt-5.2"), false);
  // An empty list means "no filter at all", which is how pi treats a missing setting.
  assert.equal(isModelEnabled([], "openai", "anything"), true);
});

test("tolerates missing or broken pi config files", () => {
  const { dir, cleanup } = workspace();
  try {
    const missing = readPiConfig(join(dir, "nope.json"), join(dir, "nope-settings.json"));
    assert.equal(missing.models.status, "missing");
    assert.deepEqual(missing.providers, {});
    assert.deepEqual(missing.enabledModels, []);

    const brokenPath = join(dir, "broken.json");
    writeFileSync(brokenPath, "{ not json");
    const broken = readPiConfig(brokenPath);
    assert.equal(broken.models.status, "invalid");
    assert.deepEqual(broken.providers, {});
    assert.deepEqual(readPiConfig(), readPiConfig(), "no paths means an empty snapshot");
  } finally {
    cleanup();
  }
});

test("writes imported providers into the generated models.json without their keys", () => {
  const { dir, cleanup } = workspace();
  try {
    const { modelsPath, settingsPath } = writeConfigs(dir);
    const pi = readPiConfig(modelsPath, settingsPath);
    const file = modelsFileFor(
      { provider: "my-gw", modelId: "alpha", thinkingLevel: "high", reasoning: true },
      pi.providers,
    );
    assert.deepEqual(Object.keys(file.providers).sort(), ["my-gw", "referenced-gw"]);
    // Selecting an imported channel must not turn it into a bespoke endpoint: that would drop the
    // operator's `compat` flags and per-model metadata.
    assert.equal((file.providers["my-gw"] as Record<string, unknown>).baseUrl, "https://gw.example.com/v1");
    // Overrides still land on the active model.
    const overrides = (file.providers["my-gw"] as { modelOverrides?: Record<string, unknown> }).modelOverrides;
    assert.deepEqual(overrides?.alpha, { reasoning: true });
    assert.equal(JSON.stringify(file).includes(SECRET), false, "a key must never reach the generated file");

    // A hand-configured endpoint still wins over the imported block, and nothing else is dropped.
    const custom = modelsFileFor(
      { provider: "my-gw", modelId: "alpha", api: "anthropic-messages", baseUrl: "https://mine.example.com", thinkingLevel: "off" },
      pi.providers,
    );
    assert.equal((custom.providers["my-gw"] as Record<string, unknown>).baseUrl, "https://mine.example.com");
    assert.equal((custom.providers["referenced-gw"] as Record<string, unknown>).baseUrl, "https://ref.example.com/v1");
  } finally {
    cleanup();
  }
});
