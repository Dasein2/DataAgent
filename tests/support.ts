import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";

export async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "data-agent-regression-"));
  await mkdir(join(dataDir, "sessions"));
  await mkdir(join(dataDir, "audit"));
  return {
    host: "127.0.0.1", port: 0, apiToken: "test-token", dataDir, sessionTtlMs: 60_000,
    maxSessions: 5, allowPrivateNetwork: true, env: "development",
    model: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "off" },
    budgets: { maxTurns: 40, maxQueries: 60, taskTimeoutMs: 500, queryTimeoutMs: 100,
      maxResultRows: 100, maxResultBytes: 100_000, previewRows: 2, cellChars: 200, maxDatasets: 10 },
  };
}

export async function cleanup(app: AppConfig) {
  if (!app.dataDir.startsWith(join(tmpdir(), "data-agent-regression-"))) throw new Error("Unexpected test directory");
  await rm(app.dataDir, { recursive: true, force: true });
}

export async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for task completion");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
