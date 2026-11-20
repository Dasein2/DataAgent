import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
import { getProfile, describeEngine } from "../src/db/engines/profiles.js";
import { AnalysisService } from "../src/agent/service.js";
import { createHttpApp } from "../src/api/http.js";
import { ProviderWrite } from "../src/agent/provider-store.js";
import { cleanup, testConfig, until } from "./support.js";

const connection = ConnectionConfig.parse({ engine: "postgres", host: "fixture.test", port: 5432, database: "fixture", user: "analyst", password: "fixture" });
const capabilities: SessionCapabilities = {
  engine: "postgres", engineLabel: "PostgreSQL", engineProfile: describeEngine(getProfile("postgres")),
  environment: "production", serverVersion: "fixture", readOnlyProof: "transaction", notes: [],
  sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: true, streaming: true },
};
const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = async (server?: ReturnType<typeof createServer>) => {
  if (!server) return;
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
};

it("switches only the owned idle session, isolates credentials, hot-adds channels and restores selection after restart", async () => {
  const app = await testConfig(); app.allowModelEdit = true; app.budgets.taskTimeoutMs = 10000;
  const original = DbSession.open; let nextId = 0;
  DbSession.open = async (options) => {
    const id = options.sessionId ?? `sess_model${++nextId}`; let closed = false;
    return { id, capabilitiesView: capabilities, engineProfile: getProfile("postgres"), scopesView: ["public"],
      expiresAt: new Date(Date.now() + 60000), touch() {},
      snapshot: () => ({ session_id: id, database: "fixture", status: closed ? "closed" : "ready", capabilities, queries: { used: 0, limit: 60 } }),
      close: async () => { closed = true; }, cancel: async () => true, listResults: async () => [],
    } as any;
  };
  let service: AnalysisService | undefined, http: ReturnType<typeof createServer> | undefined;
  let release: (() => void) | undefined;
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ body, auth: req.headers.authorization, org: req.headers["x-org"] });
    const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((p: any) => p.text || "").join("");
    if (text(body.messages.at(-1)) === "hold") await new Promise<void>((resolve) => { release = resolve; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: any, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "switch-fixture", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant", content: "# Answer\n\n**OK**" }, null); send({}, "stop"); res.end("data: [DONE]\n\n");
  });
  try {
    const baseUrl = await listen(upstream) + "/v1";
    service = await AnalysisService.create(app);
    const provider = (key: string, org: string) => ProviderWrite.parse({ name: "Channel " + key.split("-")[0], api: "openai-completions", baseUrl,
      apiKey: key, headers: { "X-Org": org }, models: [{ id: "same-name", reasoning: true, contextWindow: 128000, maxTokens: 16000 }, { id: "small", contextWindow: 16000, maxTokens: 4096 }] });
    await service.saveProvider("first", provider("first-key", "first-org"));
    await service.selectChannel("first", "same-name", "low");
    const a = await service.createSession(connection, "alice");
    const b = await service.createSession(connection, "alice");
    assert.notEqual((a as any).agent.modelRuntime, (b as any).agent.modelRuntime);
    // Added AFTER both sessions exist: selection does not require a DB reconnect.
    await service.saveProvider("second", provider("second-key", "second-org"));
    await service.saveProvider("missing", ProviderWrite.parse({ ...provider("unused", "missing"), apiKey: undefined }));
    const base = await listen(http = createServer(await createHttpApp(service)));
    const call = async (id: string, body: any, expected = 200, owner = "alice") => {
      const res = await fetch(`${base}/v1/sessions/${id}/model`, { method: "POST", headers: {
        authorization: "Bearer test-token", "x-caller-id": owner, "content-type": "application/json",
      }, body: JSON.stringify(body) });
      const result = await res.json() as any; assert.equal(res.status, expected, JSON.stringify(result)); return result;
    };
    const listing = await fetch(`${base}/v1/sessions/${a.id}/models`, { headers: { authorization: "Bearer test-token", "x-caller-id": "alice" } });
    const catalogue = await listing.json() as any;
    assert.equal(listing.status, 200);
    assert.ok(catalogue.channels.some((channel: any) => channel.id === "second"));
    assert.equal(catalogue.sources, undefined); assert.equal(catalogue.channels[0].key_source, undefined);
    assert.doesNotMatch(JSON.stringify(catalogue), /second-key|second-org|baseUrl|authPath/);
    const selection = { provider: "second", modelId: "same-name", thinkingLevel: "high" };
    const result = await call(a.id, selection);
    assert.equal(result.session.agent.provider, "second");
    assert.equal(result.session.agent.thinking_level, "high");
    assert.equal(b.snapshot().agent.provider, "first");
    assert.equal(service.modelView().provider, "first");
    assert.equal(app.model.provider, "first");
    assert.equal((await call(a.id, selection, 404, "bob")).error.code, "NOT_FOUND");
    await call(a.id, { provider: "bad", modelId: "bad" }, 400);
    await call(a.id, { provider: "second" }, 400);
    await call(a.id, { provider: "missing", modelId: "same-name" }, 503);
    assert.equal(a.snapshot().agent.provider, "second", "failed selection leaves the old model intact");
    const first = a.submit("hold"); await until(() => !!release);
    assert.equal((await call(a.id, { provider: "first", modelId: "small" }, 409)).error.code, "SESSION_BUSY");
    release!(); await until(() => !!first.finished_at);
    const run = async (session: typeof a, goal: string) => {
      const task = session.submit(goal); await until(() => !!task.finished_at);
      assert.equal(task.status, "succeeded", JSON.stringify(task.error));
      return requests.at(-1);
    };
    assert.equal(requests.at(-1).auth, "Bearer second-key");
    assert.equal(requests.at(-1).org, "second-org");
    assert.equal((await run(b, "other session")).auth, "Bearer first-key");
    // Same provider, different model still applies only to A; non-reasoning models clamp thinking.
    const small = await call(a.id, { provider: "second", modelId: "small" });
    assert.equal(small.session.agent.model, "small"); assert.equal(small.session.agent.thinking_level, "off");
    assert.equal((await run(a, "keep history")).body.model, "small");
    assert.equal((await readFile(join(app.dataDir, "pi", "models.json"), "utf8")).includes("second-key"), false);
    const transcriptDir = join(app.dataDir, "conversations", a.id);
    const transcript = await readFile(join(transcriptDir, (await readdir(transcriptDir)).find((f) => f.endsWith(".jsonl"))!), "utf8");
    assert.match(transcript, /model_change/); assert.doesNotMatch(transcript, /second-key|first-key|second-org/);
    // Selection is an ordinary session operation even with operator model editing disabled.
    app.allowModelEdit = false;
    await call(a.id, selection);
    await close(http); http = undefined;
    await service.shutdown(); service = await AnalysisService.create(app);
    const resumed = await service.createSession(connection, "alice", a.id);
    assert.equal(resumed.snapshot().agent.provider, "second"); assert.equal(resumed.snapshot().agent.thinking_level, "high");
    const resumedRequest = await run(resumed, "after restart");
    assert.equal(resumedRequest.auth, "Bearer second-key"); assert.equal(resumedRequest.body.reasoning_effort, "high");
    assert.ok(JSON.stringify(resumedRequest.body.messages).includes("keep history"));
    assert.equal(service.modelView().provider, "first");
    // Returning to the original channel after runtime refresh still resolves its endpoint.
    await service.setSessionModel(resumed.id, "alice", { provider: "first", modelId: "same-name" });
    assert.equal((await run(resumed, "back to first")).auth, "Bearer first-key");
  } finally {
    release?.(); DbSession.open = original;
    await close(http); await service?.shutdown(); await close(upstream); await cleanup(app);
  }
});
