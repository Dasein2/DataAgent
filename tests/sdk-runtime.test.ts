import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
import { getProfile, describeEngine } from "../src/db/engines/profiles.js";
import { AnalysisService } from "../src/agent/service.js";
import { cleanup, testConfig, until } from "./support.js";

const connection = ConnectionConfig.parse({ engine: "postgres", host: "fixture.test", port: 5432, database: "fixture", user: "analyst", password: "never-persist-this-password" });
const textContent = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("");
const capabilities: SessionCapabilities = {
  engine: "postgres", engineLabel: "PostgreSQL", engineProfile: describeEngine(getProfile("postgres")),
  environment: "production", serverVersion: "fixture", readOnlyProof: "transaction", notes: [],
  sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: true, streaming: true },
};
function stubDatabase() {
  const original = DbSession.open;
  let nextId = 0;
  DbSession.open = async (options) => {
    let closed = false;
    const id = options.sessionId ?? `sess_sdk${++nextId}`;
    return { id, capabilitiesView: capabilities, engineProfile: getProfile("postgres"), scopesView: ["public"],
      expiresAt: new Date(Date.now() + 60_000), touch() {},
      snapshot: () => ({ session_id: id, database: "fixture", status: closed ? "closed" : "ready", capabilities, queries: { used: 0, limit: 60 } }),
      close: async () => { closed = true; }, cancel: async () => true, listResults: async () => [],
    } as any;
  };
  return () => { DbSession.open = original; };
}

it("passes configured thinking levels into the actual SDK", async () => {
  const config = await testConfig();
  const restore = stubDatabase(); let service: AnalysisService | undefined;
  try {
    service = await AnalysisService.create(config);
    for (const level of ["off", "low", "high"] as const) {
      config.model.thinkingLevel = level;
      const session = await service.createSession(connection, "alice");
      assert.equal((session as any).agent.thinkingLevel, level);
      await service.closeSession(session.id, "alice");
    }
  } finally { restore(); await service?.shutdown(); await cleanup(config); }
});

it("handles real SDK success/length/error, persists conversation and resumes it after service restart", async () => {
  const config = await testConfig(); config.budgets.taskTimeoutMs = 5_000;
  const restore = stubDatabase(); let service: AnalysisService | undefined;
  const requests: any[] = [];
  const endpoint = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const prompt = textContent(body.messages.filter((m: any) => m.role === "user").at(-1));
    if (prompt === "model-error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture rejected request", type: "invalid_request_error" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (delta: any, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    data({ role: "assistant", content: prompt === "truncated" ? "partial answer" : "fixture final answer" }, null);
    data({}, prompt === "truncated" ? "length" : "stop"); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  config.model = { provider: "local-fixture", modelId: "fixture-model", api: "openai-completions",
    baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, apiKey: "fixture-key", thinkingLevel: "off" };
  try {
    service = await AnalysisService.create(config);
    let session = await service.createSession(connection, "alice");
    const id = session.id;
    const first = session.submit("remember-this-context"); await until(() => !!first.finished_at);
    assert.equal(first.status, "succeeded", JSON.stringify(first.error));
    assert.equal(first.answer, "fixture final answer");
    await service.shutdown();
    const transcripts = join(config.dataDir, "conversations", id);
    const files = await readdir(transcripts); assert.equal(files.filter((p) => p.endsWith(".jsonl")).length, 1);
    const transcript = await readFile(join(transcripts, files.find((p) => p.endsWith(".jsonl"))!), "utf8");
    assert.ok(transcript.includes("remember-this-context")); assert.ok(!transcript.includes(connection.password));
    config.model.thinkingLevel = "high";
    service = await AnalysisService.create(config);
    assert.equal(service.findTask(first.id, "alice").task.status, "succeeded");
    session = await service.createSession(connection, "alice", id);
    assert.equal((session as any).agent.thinkingLevel, "high");
    const second = session.submit("continue-from-history"); await until(() => !!second.finished_at);
    assert.equal(second.status, "succeeded", JSON.stringify(second.error));
    assert.equal(requests.at(-1).reasoning_effort, "high");
    assert.ok(requests.at(-1).messages.some((m: any) => m.role === "user" && textContent(m) === "remember-this-context"), JSON.stringify(requests.at(-1).messages));
    const truncated = session.submit("truncated"); await until(() => !!truncated.finished_at);
    assert.equal(truncated.status, "incomplete"); assert.equal(truncated.error?.code, "MODEL_OUTPUT_TRUNCATED");
    assert.equal(truncated.answer, "partial answer");
    const error = session.submit("model-error"); await until(() => !!error.finished_at);
    assert.equal(error.status, "failed"); assert.equal(error.error?.code, "MODEL_ERROR");
    assert.match(error.error.message, /fixture rejected request/);
  } finally {
    restore(); await service?.shutdown(); endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve())); await cleanup(config);
  }
});
