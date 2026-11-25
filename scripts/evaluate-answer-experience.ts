#!/usr/bin/env node
/** Real configured model + isolated PGlite fixture. Replies only to the scripted clarification case. */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { loadConfig } from "../src/config.js";
import { AnalysisService } from "../src/agent/service.js";
import { ConnectionConfig } from "../src/db/types.js";
import { readPiConfig } from "../src/agent/pi-config.js";

// Match the fixture connection timezone; pg date parsers otherwise inherit the host timezone.
process.env.TZ = "UTC";
const app = loadConfig();
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const piProvider = arg("--pi-provider"), piModel = arg("--pi-model");
if (piProvider || piModel) {
  if (!piProvider || !piModel) throw new Error("Supply both --pi-provider and --pi-model");
  const piHome = join(homedir(), ".pi", "agent");
  app.piModelsPath = join(piHome, "models.json");
  app.piSettingsPath = join(piHome, "settings.json");
  const pi = readPiConfig(app.piModelsPath, app.piSettingsPath);
  const provider = pi.providers[piProvider];
  if (!provider || !Array.isArray(provider.models) || !provider.models.some(model => model?.id === piModel)) throw new Error("Requested model is not in Pi's configured provider");
  // Replace the whole env model: never send an env provider's key/base URL to a Pi gateway.
  app.model = { provider: piProvider, modelId: piModel, authPath: join(piHome, "auth.json"), thinkingLevel: "medium" };
}
const probeOnly = process.argv.includes("--probe-only");
const outputArg = arg("--output");
const caseArg = arg("--case");
const cases = [
  { id: "value", goal: "public.sales 有多少笔订单？一行算一笔，不需要图表。", expected: "10 笔；不追问、不制图、不扩展原因建议。" },
  { id: "distribution", goal: "public.sales 各 region 的销售金额分布，按所有记录的 amount 全额求和（包括 refunded=true，不做退款扣减），用一张柱状图展示并指出最高的地区。", expected: "US 560.74；明确全额口径，一张图，不重复表格、不扩展退款分析。" },
  { id: "clarification", goal: "统计 public.orders 的 2026 年 1 月订单数。", expected: "先发现 created_at/paid_at 的歧义，带依据追问；不能擅自选时间口径。", answer: "按支付时间，只统计已支付订单" },
  { id: "boundary", goal: "public.daily_usage 的日活为什么从 2026-01-01 的 100 降到 2026-01-02 的 80？如果现有数据不能证明原因，请明确说明，不要猜测。", expected: "下降 20（20%），只有汇总数据，不能证明原因；无虚构归因。" },
];
const selected = caseArg ? cases.filter(scenario => scenario.id === caseArg) : cases;
if (!selected.length) throw new Error("Unknown case; use value, distribution, clarification or boundary");
const dataDir = await mkdtemp(join(tmpdir(), "data-agent-experience-"));
app.dataDir = dataDir;
app.budgets.taskTimeoutMs = 120_000;
app.budgets.maxTurns = 14;
app.budgets.maxQueries = 20;
app.allowPrivateNetwork = true;
const db = await PGlite.create();
const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 8 });
let service: AnalysisService | undefined;
const records: unknown[] = [];
let probe: Awaited<ReturnType<AnalysisService["testModel"]>> | undefined;
try {
  await db.exec(await readFile(new URL("./seed/postgres-pglite.sql", import.meta.url), "utf8"));
  await db.exec(`CREATE TABLE public.orders (created_at date NOT NULL, paid_at date, status text NOT NULL);
    COMMENT ON TABLE public.orders IS '订单明细。没有约定默认统计时间，需区分下单与支付时间。';
    COMMENT ON COLUMN public.orders.created_at IS '下单时间'; COMMENT ON COLUMN public.orders.paid_at IS '支付时间';
    INSERT INTO public.orders VALUES ('2025-12-31','2026-01-01','paid'), ('2026-01-06','2026-01-06','paid'), ('2026-01-04','2026-01-04','cancelled'), ('2026-01-08','2026-02-01','paid');
    CREATE TABLE public.daily_usage(day date PRIMARY KEY, dau integer NOT NULL);
    INSERT INTO public.daily_usage VALUES ('2026-01-01',100), ('2026-01-02',80);
    COMMENT ON TABLE public.daily_usage IS '仅有日活汇总，无渠道、版本、故障、活动或用户行为明细。';`);
  await socket.start();
  service = await AnalysisService.create(app);
  probe = await service.testModel();
  console.log(JSON.stringify({ probe: { provider: app.model.provider, model: app.model.modelId, ok: probe.ok, status: probe.status, latency_ms: probe.latency_ms } }));
  if (!probe.ok) throw new Error("Configured model connectivity probe failed; see evaluation record (no fallback attempted).");
  for (const scenario of probeOnly ? [] : selected) {
    const session = await service.createSession(ConnectionConfig.parse({ engine: "postgres", host: "127.0.0.1", port: Number(socket.getServerConn().split(":").at(-1)),
      database: "postgres", user: "postgres", password: "postgres", environment: "non_production", timezone: "UTC" }), "experience-eval");
    const submitted = Date.now();
    const task = session.submit(scenario.goal);
    const firstEvent = service.broker.list(task.id)[0];
    let firstStatus: number | undefined = firstEvent ? Math.max(0, Date.parse(firstEvent.at) - submitted) : undefined;
    let firstAnswer: number | undefined, answered = false;
    const unsubscribe = service.broker.subscribe(task.id, event => {
      if (firstStatus === undefined) firstStatus = Date.now() - submitted;
      if (event.type === "answer_ready" && firstAnswer === undefined) firstAnswer = Date.now() - submitted;
    });
    try {
      while (!task.finished_at) {
        if (task.status === "waiting_for_user") {
          const question = task.clarifications!.at(-1)!;
          if (scenario.answer && !answered) { session.answerClarification(task.id, { question_id: question.id, text: scenario.answer }); answered = true; }
          else { await session.cancelTask(task.id); break; }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const events = service.broker.list(task.id);
      // Conservative smoke checks, not a replacement for manual semantic review.
      const resultMetas = await Promise.all(task.results.map(id => service!.results.get(id)));
      const cells = resultMetas.flatMap(result => result?.preview.flat() ?? []).map(String);
      const issues: string[] = [];
      if (task.status !== "succeeded") issues.push("task_not_succeeded");
      if (scenario.id === "value" && !cells.includes("10")) issues.push("value_not_backed_by_expected_cell");
      if (scenario.id === "value" && (task.artifacts?.length || task.clarifications?.length)) issues.push("unneeded_chart_or_question");
      if (scenario.id === "distribution" && (task.artifacts?.length !== 1 || !cells.includes("560.74"))) issues.push("distribution_or_chart_mismatch");
      if (scenario.id === "distribution" && /\n\s*\|/.test(task.answer ?? "")) issues.push("duplicate_table_with_chart");
      if (scenario.id === "clarification" && (!answered || !cells.includes("2"))) issues.push("missing_grounded_clarification_or_corrected_result");
      const askedAt = events.findIndex(event => event.type === "question_asked");
      if (scenario.id === "clarification" && askedAt >= 0 && events.slice(0, askedAt).some(event => event.type === "tool_started" && event.data.tool === "query_execute" && /count\s*\(/i.test(String((event.data.args as any)?.sql)))) issues.push("aggregate_exploration_before_clarification");
      if (scenario.id === "boundary" && !/不能|无法|不足/.test(task.answer ?? "")) issues.push("missing_causal_limitation");
      const proseLength = (task.answer ?? "").replace(/(?:res|art)_[a-z0-9]+#[^\s）。，；]+/g, "[ref]").length;
      if (proseLength > (scenario.id === "value" ? 220 : scenario.id === "boundary" ? 240 : 380)) issues.push("answer_too_verbose_for_case");
      const row = { case: scenario.id, goal: scenario.goal, expected: scenario.expected, model: { provider: app.model.provider, id: app.model.modelId, thinking: app.model.thinkingLevel },
        status: task.status, error: task.error, turns: task.turns, queries: task.queries_used,
        first_server_event_ms: firstStatus ?? null, answer_ready_ms: firstAnswer ?? null, execution_ms: task.execution_ms,
        waiting_ms: task.waiting_ms ?? 0, answer_chars: task.answer?.length ?? 0, charts: task.artifacts?.length ?? 0,
        questions: task.clarifications?.map(q => ({ question: q.question, impact: q.impact, options: q.options, answer: q.answer?.text })) ?? [],
        tools: events.filter(e => e.type === "tool_started").map(e => e.data.tool), answer: task.answer, acceptance: { passed: issues.length === 0, issues, manual_review_required: true },
        results: await Promise.all(task.results.map(async id => { const result = await service!.results.get(id); return { id, sql: result?.sql, rows: result?.preview }; })) };
      records.push(row);
      if (issues.length) process.exitCode = 1;
      console.log(JSON.stringify({ case: row.case, status: row.status, turns: row.turns, execution_ms: row.execution_ms, answer_ready_ms: row.answer_ready_ms, answer_chars: row.answer_chars, charts: row.charts, questions: row.questions.length, acceptance: row.acceptance }));
    } finally { unsubscribe(); await session.close(); }
    if (task.error?.code === "MODEL_ERROR" && /402|insufficient.balance|401|unauthorized/i.test(task.error.message)) {
      console.error("Model channel blocked; remaining cases were not run. No provider/model fallback was attempted.");
      break;
    }
  }
} finally {
  const output = outputArg ?? process.env.DATA_AGENT_EVAL_OUTPUT ?? ".tmp/answer-experience-eval.json";
  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify({ generated_at: new Date().toISOString(), probe: { provider: app.model.provider, model: app.model.modelId, ...probe }, planned_cases: selected.map(({ id, goal, expected }) => ({ id, goal, expected })), note: "Isolated synthetic cases, not production replay. Timings exclude browser rendering; answers require manual quality review.", records }, null, 2));
  await service?.shutdown();
  await socket.stop().catch(() => undefined);
  await db.close();
  await rm(dataDir, { recursive: true, force: true });
}
