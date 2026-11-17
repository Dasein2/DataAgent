import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Server } from "node:http";
import { AnalysisService } from "../src/agent/service.js";
import { HistoryStore } from "../src/agent/history.js";
import { createHttpApp } from "../src/api/http.js";
import { DbSession } from "../src/db/session.js";
import { ConnectionConfig, type SessionCapabilities } from "../src/db/types.js";
import { getProfile, describeEngine } from "../src/db/engines/profiles.js";
import {
  buildTitleTranscript,
  buildTitleTranscriptFromTasks,
  generateSessionTitle,
  parseGeneratedSessionTitle,
} from "../src/agent/session-title.js";
import type { TaskRecord } from "../src/agent/runtime.js";
import { cleanup, testConfig, until } from "./support.js";

const connection = ConnectionConfig.parse({
  engine: "postgres", host: "fixture.test", port: 5432, database: "fixture", user: "analyst",
  password: "fixture-password",
});

const capabilities: SessionCapabilities = {
  engine: "postgres", engineLabel: "PostgreSQL", engineProfile: describeEngine(getProfile("postgres")),
  environment: "production", serverVersion: "fixture", readOnlyProof: "transaction", notes: [],
  sourceAccess: "read_only", workspaceAccess: "none",
  features: { cancel: true, explain: true, explainAnalyze: true, streaming: true },
};

function stubDatabase() {
  const original = DbSession.open;
  let nextId = 0;
  DbSession.open = async (options) => {
    let closed = false;
    const id = options.sessionId ?? `sess_title${++nextId}`;
    return {
      id, capabilitiesView: capabilities, engineProfile: getProfile("postgres"), scopesView: ["public"],
      expiresAt: new Date(Date.now() + 60_000), touch() {},
      snapshot: () => ({ session_id: id, database: "fixture", status: closed ? "closed" : "ready", capabilities, queries: { used: 0, limit: 60 } }),
      close: async () => { closed = true; }, cancel: async () => true, listResults: async () => [],
    } as any;
  };
  return () => { DbSession.open = original; };
}

/** A local OpenAI-compatible endpoint. `title` answers a title request, anything else is a task. */
async function fixtureEndpoint(taskText = "12 rows", title = "统计订单数量"): Promise<{
  url: string; requests: any[]; close: () => Promise<void>;
}> {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const prompt = body.messages.map((message: any) =>
      typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join(""))
      .join("\n");
    const text = prompt.includes("Create a concise title for this session") ? title : taskText;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (delta: any, finish_reason: string | null) => res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
    data({ role: "assistant", content: text }, null);
    data({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function localModel(url: string) {
  return {
    provider: "local-fixture", modelId: "fixture-model", api: "openai-completions",
    baseUrl: url, apiKey: "fixture-key", thinkingLevel: "off" as const,
  };
}

it("parses titles out of the shapes a model actually returns", () => {
  assert.equal(parseGeneratedSessionTitle('"月度 GMV 趋势"'), "月度 GMV 趋势");
  assert.equal(parseGeneratedSessionTitle("标题: 订单退款原因分析。"), "订单退款原因分析");
  assert.equal(parseGeneratedSessionTitle("```json\n{\"title\":\"Churn by plan\"}\n```"), "Churn by plan");
  assert.equal(parseGeneratedSessionTitle("Title: Cohort retention\n\nExplanation"), "Cohort retention");
  assert.equal(parseGeneratedSessionTitle("\u300c用户留存分析\u300d"), "用户留存分析");
  const long = parseGeneratedSessionTitle("x".repeat(120));
  assert.equal(Array.from(long).length, 80);
  assert.throws(() => parseGeneratedSessionTitle("  ...  "), /usable session title/);
});

it("builds a bounded transcript that keeps the goal, the last reply and drops tool calls", () => {
  const messages: any[] = [
    { role: "system", content: "prompt" },
    { role: "user", content: "分析最近一年的月度 GMV" },
    { role: "assistant", content: [{ type: "toolCall", id: "1", name: "query_execute" }] },
    { role: "assistant", content: [{ type: "text", text: "先查一下订单表" }] },
    { role: "assistant", content: [
      { type: "text", text: "最终答案：" + "y".repeat(1_000) },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ] },
  ];
  const transcript = buildTitleTranscript(messages);
  assert.match(transcript, /^User: 分析最近一年的月度 GMV/);
  assert.ok(!transcript.includes("query_execute"));
  assert.match(transcript, /Assistant: 最终答案：y+…$/);
  assert.equal(
    buildTitleTranscript([{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "aGk=", mimeType: "image/png" }] }]),
    "User: 看图\n[image]",
  );
  assert.ok(transcript.length < 1_100);

  const wide: any[] = [];
  for (let index = 0; index < 12; index++) {
    wide.push({ role: "user", content: `问题${index}-` + "z".repeat(700) });
    wide.push({ role: "assistant", content: `回答${index}-` + "w".repeat(500) });
  }
  const bounded = buildTitleTranscript(wide);
  assert.ok(bounded.length <= 6_000, `transcript stayed bounded (${bounded.length})`);
  assert.match(bounded, /问题0-/);
  assert.match(bounded, /问题11-/);
  assert.match(bounded, /\[…\]/);
  assert.ok(!bounded.includes("问题6-"));

  const fromTasks = buildTitleTranscriptFromTasks([
    { goal: "统计订单数量", answer: "12 条" },
    { goal: "按月拆分", answer: "1 月 5 条" },
  ]);
  assert.equal(fromTasks, "User: 统计订单数量\n\nAssistant: 12 条\n\nUser: 按月拆分\n\nAssistant: 1 月 5 条");
  assert.equal(buildTitleTranscriptFromTasks([]), "");
});

it("titles a live agent with its own model, options and credentials", async () => {
  const calls: any[] = [];
  const model = {
    provider: "fixture", id: "fixture-model", api: "openai-completions", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 4_096,
  };
  const agent = {
    state: {
      model,
      messages: [
        { role: "user", content: "分析最近一年的月度 GMV", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "已生成趋势图" }], timestamp: 2 },
      ],
    },
    transport: "auto",
    getApiKey: async (provider: string) => provider === "fixture" ? "session-key" : undefined,
    streamFunction: async (requested: any, context: any, options: any) => {
      calls.push({ requested, context, options });
      return {
        result: async () => ({
          role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "“月度 GMV 趋势分析”" }],
          usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
        }),
      };
    },
  } as any;

  const result = await generateSessionTitle(agent);
  assert.equal(result.title, "月度 GMV 趋势分析");
  assert.equal(result.usage?.total, 14);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requested, model);
  assert.equal(calls[0].options.apiKey, "session-key");
  assert.equal(calls[0].options.maxTokens, 256);
  assert.equal(calls[0].options.cacheRetention, "none");
  assert.equal(calls[0].options.reasoning, undefined);
  assert.equal(calls[0].context.messages[0].role, "system");
  assert.match(calls[0].context.messages[0].content, /You name chat sessions/);
  const prompt = calls[0].context.messages[1].content[0].text;
  assert.match(prompt, /^User: 分析最近一年的月度 GMV/);
  assert.match(prompt, /Create a concise title for this session/);
});

it("names a saved session over HTTP with the active model and persists it", async () => {
  const config = await testConfig();
  const sessionId = "sess_titlesaved";
  const history = new HistoryStore(join(config.dataDir, "history"));
  const task: TaskRecord = {
    id: "task_title1", session_id: sessionId, goal: "分析最近一年的月度 GMV", status: "succeeded",
    created_at: new Date().toISOString(), turns: 1, queries_used: 1, results: [], answer: "GMV 同比增长 18%",
  };
  history.saveSession("alice", { session_id: sessionId, status: "closed" }, "connection-key");
  history.saveTask("alice", task);

  const endpoint = await fixtureEndpoint("unused", "月度 GMV 增长分析");
  config.model = localModel(endpoint.url);
  let service: AnalysisService | undefined;
  let server: Server | undefined;
  try {
    service = await AnalysisService.create(config);
    const web = await createHttpApp(service);
    server = await new Promise<Server>((resolve) => {
      const listening = web.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = (server.address() as any).port;
    const request = (path: string, owner = "alice", init: RequestInit = {}) => fetch(
      `http://127.0.0.1:${port}${path}`,
      { ...init, headers: { authorization: "Bearer test-token", "x-caller-id": owner, "content-type": "application/json", ...init.headers } },
    );

    assert.equal((await request(`/v1/sessions/${sessionId}/title`, "bob", { method: "POST" })).status, 404);

    const response = await request(`/v1/sessions/${sessionId}/title`, "alice", { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.json() as { title: string; usage: unknown };
    assert.equal(body.title, "月度 GMV 增长分析");
    assert.ok(body.usage);

    assert.equal((await (await request(`/v1/sessions/${sessionId}`)).json() as any).session.title, "月度 GMV 增长分析");
    assert.equal((await (await request("/v1/sessions")).json() as any).sessions[0].title, "月度 GMV 增长分析");
    assert.equal(new HistoryStore(join(config.dataDir, "history")).getSession(sessionId, "alice").snapshot.title, "月度 GMV 增长分析");

    const prompt = JSON.stringify(endpoint.requests[0]?.messages ?? []);
    assert.match(prompt, /分析最近一年的月度 GMV/);
    assert.match(prompt, /GMV 同比增长 18%/);
    assert.match(prompt, /You name chat sessions/);
  } finally {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await service?.shutdown();
    await endpoint.close();
    await cleanup(config);
  }
});

it("names a live session with the session's own handle and keeps the title in the snapshot", async () => {
  const config = await testConfig();
  config.budgets.taskTimeoutMs = 5_000;
  const restore = stubDatabase();
  const endpoint = await fixtureEndpoint("12 rows", "实时会话标题");
  config.model = localModel(endpoint.url);
  let service: AnalysisService | undefined;
  try {
    service = await AnalysisService.create(config);
    const session = await service.createSession(connection, "alice");
    const task = session.submit("统计订单数量");
    await until(() => Boolean(task.finished_at));
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));

    const result = await service.generateTitle(session.id, "alice");
    assert.equal(result.title, "实时会话标题");
    assert.equal(session.snapshot().title, "实时会话标题");
    assert.equal(service.sessionSnapshot(session.id, "alice").title, "实时会话标题");
    assert.equal(new HistoryStore(join(config.dataDir, "history")).getSession(session.id, "alice").snapshot.title, "实时会话标题");
    assert.match(JSON.stringify(endpoint.requests.at(-1)?.messages ?? []), /统计订单数量/);
    assert.match(JSON.stringify(endpoint.requests.at(-1)?.messages ?? []), /12 rows/);
  } finally {
    restore();
    await service?.shutdown();
    await endpoint.close();
    await cleanup(config);
  }
});
