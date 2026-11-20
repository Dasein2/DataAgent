import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const MODEL_ENV = [
  "DATA_AGENT_MODEL_PROVIDER",
  "DATA_AGENT_MODEL_ID",
  "DATA_AGENT_MODEL_THINKING",
  "DATA_AGENT_MODEL_API_KEY",
  "DATA_AGENT_PI_SETTINGS_PATH",
  "DATA_AGENT_PI_IMPORT",
  "NODE_ENV",
  "DATA_AGENT_ENV_FILE",
  "DATA_AGENT_DATA_DIR",
  "DATA_AGENT_TOOL_PROFILE",
];

/** loadConfig reads process.env and writes to it via dotenv, so every test restores the keys it touched. */
async function withEnv(patch: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = new Map(MODEL_ENV.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "development";
    delete process.env.DATA_AGENT_PI_IMPORT;
    delete process.env.DATA_AGENT_MODEL_API_KEY;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("follows the channel pi is configured to start on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-config-"));
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProvider: "PackyAPI国产", defaultModel: "deepseek-flash", defaultThinkingLevel: "xhigh" }),
    );
    const emptyEnv = join(dir, "empty.env");
    writeFileSync(emptyEnv, "# nothing pinned here\n");
    await withEnv(
      {
        DATA_AGENT_ENV_FILE: emptyEnv,
        DATA_AGENT_DATA_DIR: dir,
        DATA_AGENT_PI_SETTINGS_PATH: settingsPath,
        DATA_AGENT_MODEL_PROVIDER: undefined,
        DATA_AGENT_MODEL_ID: undefined,
        DATA_AGENT_MODEL_THINKING: undefined,
      },
      async () => {
        const config = loadConfig();
        assert.equal(config.model.provider, "PackyAPI国产");
        assert.equal(config.model.modelId, "deepseek-flash");
        // pi's own default level, including the levels the console used to reject.
        assert.equal(config.model.thinkingLevel, "xhigh");
        // The channel's key lives in pi's models.json, so nothing has to be exported here.
        assert.equal(config.model.apiKey, undefined);
        assert.equal(config.piSettingsPath, settingsPath);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit .env still wins over the pi default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-config-"));
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "pi-channel", defaultModel: "pi-model" }));
    const pinnedEnv = join(dir, "pinned.env");
    writeFileSync(
      pinnedEnv,
      ["DATA_AGENT_MODEL_PROVIDER=openai", "DATA_AGENT_MODEL_ID=gpt-5.2", "DATA_AGENT_MODEL_THINKING=max"].join("\n"),
    );
    await withEnv(
      {
        DATA_AGENT_ENV_FILE: pinnedEnv,
        DATA_AGENT_DATA_DIR: dir,
        DATA_AGENT_PI_SETTINGS_PATH: settingsPath,
        DATA_AGENT_MODEL_PROVIDER: undefined,
        DATA_AGENT_MODEL_ID: undefined,
        DATA_AGENT_MODEL_THINKING: undefined,
      },
      async () => {
        const config = loadConfig();
        assert.equal(config.model.provider, "openai");
        assert.equal(config.model.modelId, "gpt-5.2");
        assert.equal(config.model.thinkingLevel, "max");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("can disable all pi imports for a standalone server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-config-"));
  try {
    const settingsPath = join(dir, "settings.json"), envPath = join(dir, "empty.env");
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "pi-only", defaultModel: "private" }));
    writeFileSync(envPath, "");
    await withEnv({ DATA_AGENT_ENV_FILE: envPath, DATA_AGENT_DATA_DIR: dir, DATA_AGENT_PI_SETTINGS_PATH: settingsPath,
      DATA_AGENT_PI_IMPORT: "0", DATA_AGENT_MODEL_PROVIDER: undefined, DATA_AGENT_MODEL_ID: undefined, DATA_AGENT_MODEL_THINKING: undefined }, async () => {
      const config = loadConfig();
      assert.equal(config.piSettingsPath, undefined); assert.equal(config.piModelsPath, undefined);
      assert.equal(config.model.authPath, undefined); assert.equal(config.model.provider, "openai");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ignores the retired tool profile setting in existing deployments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-config-"));
  try {
    const env = join(dir, "test.env");
    writeFileSync(env, "DATA_AGENT_TOOL_PROFILE=analysis\n");
    await withEnv({ DATA_AGENT_ENV_FILE: env, DATA_AGENT_DATA_DIR: dir, DATA_AGENT_TOOL_PROFILE: undefined }, async () => {
      assert.ok(!("toolProfile" in loadConfig()));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the built-in baseline when neither pi nor .env names a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-agent-config-"));
  try {
    const emptyEnv = join(dir, "empty.env");
    writeFileSync(emptyEnv, "");
    await withEnv(
      {
        DATA_AGENT_ENV_FILE: emptyEnv,
        DATA_AGENT_DATA_DIR: dir,
        // A pi settings.json that predates the default* keys must not break startup either.
        DATA_AGENT_PI_SETTINGS_PATH: join(dir, "missing.json"),
        DATA_AGENT_MODEL_PROVIDER: undefined,
        DATA_AGENT_MODEL_ID: undefined,
        DATA_AGENT_MODEL_THINKING: undefined,
      },
      async () => {
        const config = loadConfig();
        assert.equal(config.model.provider, "openai");
        assert.equal(config.model.modelId, "gpt-5.2");
        assert.equal(config.model.thinkingLevel, "medium");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
