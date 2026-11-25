import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";

export async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "data-agent-regression-"));
  await mkdir(join(dataDir, "sessions"));
  await mkdir(join(dataDir, "audit"));
  return {
    // Most legacy tests exercise the execution phase; confirmation is covered explicitly.
    host: "127.0.0.1", port: 0, apiToken: "test-token", dataDir, intentConfirmation: false, sessionTtlMs: 60_000,
    maxSessions: 5, allowPrivateNetwork: true, env: "development",
    model: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "off" },
    budgets: { maxTurns: 40, maxQueries: 60, taskTimeoutMs: 500, queryTimeoutMs: 100,
      maxResultRows: 100, maxResultBytes: 100_000, previewRows: 2, cellChars: 200, maxDatasets: 10,
      maxChartRows: 5_000, maxChartCells: 3_600, maxArtifactsPerTask: 12 },
  };
}

export async function cleanup(app: AppConfig) {
  if (!app.dataDir.startsWith(join(tmpdir(), "data-agent-regression-"))) throw new Error("Unexpected test directory");
  await rm(app.dataDir, { recursive: true, force: true });
}

export async function until(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for task completion");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
