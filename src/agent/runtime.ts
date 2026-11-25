import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig, ThinkingLevel } from "../config.js";
import type { ConnectionConfig } from "../db/types.js";
import { DbSession, type DbOperation } from "../db/session.js";
import type { SourceRequest } from "../db/source-operations.js";
import { BusinessAnalysis, type BusinessCatalogStore } from "../business/service.js";
import { AppError, isAppError } from "../errors.js";
import type { ResultStore } from "../results/store.js";
import type { ArtifactService } from "../artifacts/service.js";
import { buildSystemPrompt } from "./prompts.js";
import { createDatabaseTools, selectTools, toolCatalog, SOURCE_TOOLS, type ToolInfo, type ToolRuntime } from "./tools.js";
import { EventBroker, type TaskEvent } from "./events.js";
import type { ModelHandle } from "./model.js";
import type { HistoryStore } from "./history.js";
import { taskActivity, type ActivitySummary } from "./task-activity.js";
import { generateSessionTitle, type GeneratedSessionTitle } from "./session-title.js";
import { businessContextPrompt, contextSummary } from "../business-context/store.js";
import type { BusinessContextFile } from "../business-context/types.js";
import { ASK_USER, CLARIFICATION_WAIT_MS, MAX_CLARIFICATIONS, clarificationPrompt, type ClarificationAnswer, type TaskClarification } from "./clarification.js";

export type TaskStatus = "queued" | "running" | "waiting_for_user" | "succeeded" | "failed" | "cancelled" | "incomplete";

export interface TaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface TaskRecord {
  id: string;
  session_id: string;
  goal: string;
  status: TaskStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: { code: string; message: string };
  usage?: TaskUsage;
  turns: number;
  max_turns?: number;
  queries_used: number;
  execution_ms?: number;
  waiting_ms?: number;
  clarifications?: TaskClarification[];
  results: string[];
  business_results?: string[];
  /** Chart artifacts produced by this task, in creation order. */
  artifacts?: string[];
  /** Last non-empty assistant message; the report a polling client can read without SSE. */
  answer?: string;
  /** UI execution-process summary; optional for older saved tasks. */
  activity?: ActivitySummary;
  operations?: Partial<Record<DbOperation["kind"], { count: number; duration_ms: number }>>;
  source_requests?: Partial<Record<SourceRequest["kind"], { count: number; duration_ms: number }>>;
  source_recovery?: { code: "SESSION_UNAVAILABLE"; in_flight: string[]; in_flight_requests?: number[] };
}

interface QueueItem {
  record: TaskRecord;
  maxTurns: number;
  resumed?: boolean;
}

type QuestionInput = Pick<TaskClarification, "question" | "impact" | "options">;
type StagedQuestion = QuestionInput & { id: string; kind: "follow_up" };

interface FinalAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  text: string;
  hasTools: boolean;
}

const TASK_ID = () => `task_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * One analysis session = one pinned database connection + one pi agent session.
 * Database work is serialised by DbSession; tasks are serialised here.
 */
export class AnalysisSession {
  private constructor(
    readonly id: string,
    readonly ownerKey: string,
    readonly db: DbSession,
    private readonly agent: AgentSession,
    readonly tools: readonly ToolInfo[],
    private readonly broker: EventBroker,
    private readonly app: AppConfig,
    private readonly sessionRef: { current?: TaskRecord },
    private readonly artifacts: ArtifactService,
    readonly businessContextScope: string,
    private readonly contextRef: { files: BusinessContextFile[]; prompt: string },
    private readonly history?: HistoryStore,
    readonly business?: BusinessAnalysis,
  ) {}

  readonly createdAt = new Date();
  private lastUsedAt = new Date();
  private closed = false;
  private draining = false;
  private changingModel = false;
  private modelSelection?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };
  private current?: TaskRecord;
  private clarificationTimer?: ReturnType<typeof setTimeout>;
  private stagedQuestion?: StagedQuestion;
  private readonly queue: QueueItem[] = [];
  private readonly tasks = new Map<string, TaskRecord>();
  private settledResolve?: (aborted: boolean) => void;
  private abortRequested = false;
  private timedOut = false;
  private turns = 0;
  private maxTurns = 0;
  private turnBudgetExceeded = false;
  private settledAborted = false;
  private finalMessage?: FinalAssistantMessage;
  private readonly sourceInFlight = new Set<string>();
  private readonly sourceRequestsInFlight = new Set<number>();
  /** Display name of the session, persisted with the snapshot; null until generated or renamed. */
  private title?: string;

  static async create(options: {
    config: ConnectionConfig;
    app: AppConfig;
    results: ResultStore;
    artifacts: ArtifactService;
    model: ModelHandle;
    broker: EventBroker;
    ownerKey: string;
    history?: HistoryStore;
    sessionId?: string;
    title?: string;
    modelSelection?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };
    businessContext: { scope: string; files: BusinessContextFile[] };
    businessCatalog?: BusinessCatalogStore;
  }): Promise<AnalysisSession> {
    const { app, config, broker } = options;
    const db = await DbSession.open({ config, app, results: options.results, sessionId: options.sessionId });
    const cwd = join(app.dataDir, "workspaces", db.id);
    const files = options.businessContext.files;
    const contextRef = { files, prompt: businessContextPrompt(files) };
    const sessionRef: { current?: TaskRecord } = {};
    const business = options.businessCatalog && config.engine === "doris" && db.capabilitiesView.readOnlyProof === "grants"
      ? new BusinessAnalysis(options.businessCatalog, options.businessContext.scope, db, options.results) : undefined;
    let session: AgentSession;
    let tools: ToolInfo[];
    let analysis: AnalysisSession;
    try {
      await mkdir(cwd, { recursive: true });
      const toolRuntime: ToolRuntime = {
        db,
        budgets: app.budgets,
        artifacts: options.artifacts,
        currentTaskId: () => sessionRef.current?.id,
        taskStatus: () => (sessionRef.current ? { ...sessionRef.current, max_turns: sessionRef.current.max_turns ?? app.budgets.maxTurns } : { status: "idle" }),
        cancelActive: () => db.cancel(),
        askUser: (input) => analysis.stageClarification(input),
        sourceBlocked: () => Boolean(sessionRef.current?.source_recovery) || db.snapshot().status === "unavailable",
        business,
      };
      const caps = db.capabilitiesView;
      const customTools = selectTools(createDatabaseTools(toolRuntime), caps, Boolean(business));
      tools = toolCatalog(customTools);
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: join(app.dataDir, "pi", "agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: buildSystemPrompt(caps, app.budgets, new Set(customTools.map((tool) => tool.name))),
        extensionFactories: [(pi) => {
          // Pi snapshots executable tools for a prompt. Also filter the provider's
          // declarations on every turn; the tool wrapper blocks stale/in-flight calls.
          pi.on("context_with_system", ({ messages }) => {
            if (!sessionRef.current?.source_recovery && db.snapshot().status !== "unavailable") return;
            return { messages: messages.map(message => message.role === "system" && message.toolsAdded
              ? { ...message, toolsAdded: message.toolsAdded.filter(tool => !SOURCE_TOOLS.has(tool.name)) } : message) };
          });
          pi.on("before_agent_start", (event) => {
            if (contextRef.files.length) {
              // Provider-only projection. Don't keep obsolete reference bodies in Pi's transcript.
              return { systemPrompt: event.systemPrompt + "\n\n## Business Context\n" + contextRef.prompt };
            }
          });
        }],
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir: join(app.dataDir, "pi", "agent"),
        model: options.model.model,
        modelRuntime: options.model.runtime,
        thinkingLevel: app.model.thinkingLevel,
        sessionManager: SessionManager.continueRecent(cwd, join(app.dataDir, "conversations", db.id)),
        settingsManager,
        resourceLoader,
        noTools: "builtin",
        customTools,
      });
      session = created.session;
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }

    analysis = new AnalysisSession(
      db.id,
      options.ownerKey,
      db,
      session,
      tools,
      broker,
      app,
      sessionRef,
      options.artifacts,
      options.businessContext.scope,
      contextRef,
      options.history,
      business,
    );
    if (options.sessionId) {
      for (const task of options.history?.listTasks(db.id, options.ownerKey) ?? []) analysis.tasks.set(task.id, task);
    }
    analysis.title = options.title;
    analysis.modelSelection = options.modelSelection;
    // Preserve Pi's existing hooks. The assistant message exposes the full batch, so
    // no sibling tool can start even if it precedes ask_user in the model's output.
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      if (context.toolCall.name !== ASK_USER &&
          (analysis.stagedQuestion || context.assistantMessage.content.some(part => part.type === "toolCall" && part.name === ASK_USER))) {
        return { block: true, terminate: true, reason: "Other tools cannot run in the same turn as ask_user." };
      }
      return beforeToolCall?.(context, signal);
    };
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (!analysis.stagedQuestion) return decision || undefined;
      // End this Pi run after the tool results have been recorded, without aborting it.
      // A stale queued steer is not an answer to the pending question.
      if (session.pendingMessageCount) {
        session.clearQueue();
        if (analysis.current) broker.publish(analysis.current.id, "notice", { code: "CLARIFICATION_PENDING", text: "未送达的插入指令未执行。请在追问卡片中重新补充。" });
      }
      return { action: "end" };
    };
    analysis.agent.subscribe((event) => {
      analysis.mapEvent(event);
    });
    return analysis;
  }

  // ---------------------------------------------------------------- lifecycle

  get effectiveTools() {
    const blocked = this.db.snapshot().status === "unavailable" || Boolean(this.current?.source_recovery);
    return this.tools.filter(t => !(blocked && SOURCE_TOOLS.has(t.name)) && (!t.name.startsWith("business_") || this.business?.enabled));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isBusy(): boolean {
    return this.changingModel || this.draining || this.current?.status === "waiting_for_user" || !this.agent.isIdle;
  }

  /** Reserve the session before any asynchronous credential/catalogue work. */
  async changeModel(resolve: () => Promise<ModelHandle>, thinkingLevel?: ThinkingLevel): Promise<void> {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    if (this.isBusy) throw new AppError("SESSION_BUSY", "请等待当前任务结束后再切换模型。");
    this.changingModel = true;
    try {
      const handle = await resolve();
      if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
      if (!handle.hasAuth) throw new AppError("MODEL_NOT_CONFIGURED", "目标渠道未配置凭证，请先在模型管理中配置。");
      const runtime = this.agent.modelRuntime;
      const model = handle.model;
      // Register only the destination on this session's isolated runtime. New channels work
      // immediately; no refresh of another session's pinned catalogue or credentials occurs.
      const source = handle.runtime.getProvider(model.provider);
      if (!source) throw new AppError("INVALID_INPUT", "目标渠道不存在。");
      const previousProvider = runtime.getProvider(model.provider);
      const previousAuth = await runtime.getAuth(model.provider);
      const previousModel = this.agent.model;
      const previousThinking = this.agent.thinkingLevel;
      const previousSelection = this.modelSelection;
      const auth = await handle.runtime.getAuth(model);
      try {
        runtime.registerNativeProvider(source);
        if (auth?.auth.apiKey) await runtime.setRuntimeApiKey(model.provider, auth.auth.apiKey);
        await this.agent.setModel(model, { persist: false });
        if (thinkingLevel !== undefined) this.agent.setThinkingLevel(thinkingLevel, { persist: false });
        this.modelSelection = { provider: model.provider, modelId: model.id, thinkingLevel: this.agent.thinkingLevel as ThinkingLevel };
        this.history?.saveSession(this.ownerKey, this.snapshot());
      } catch (error) {
        // A rejected credential/model/persistence update must leave a usable old selection.
        if (previousProvider) runtime.registerNativeProvider(previousProvider);
        else runtime.unregisterProvider(model.provider);
        if (previousAuth?.auth.apiKey) await runtime.setRuntimeApiKey(model.provider, previousAuth.auth.apiKey);
        else await runtime.removeRuntimeApiKey(model.provider);
        if (previousModel && this.agent.model !== previousModel) await this.agent.setModel(previousModel, { persist: false });
        this.agent.setThinkingLevel(previousThinking, { persist: false });
        this.modelSelection = previousSelection;
        throw error;
      }
    } finally { this.changingModel = false; }
  }

  businessContextSelection() {
    return this.contextRef.files.map(contextSummary);
  }

  setBusinessContext(files: BusinessContextFile[]): void {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    if (this.isBusy) throw new AppError("SESSION_BUSY", "请等待当前任务结束后再应用业务上下文。");
    const before = this.contextRef.files;
    if (before.length === files.length && before.every((f, i) => f.revision === files[i]?.revision)) return;
    const active = files.map(contextSummary);
    this.history?.saveSession(this.ownerKey, { ...this.snapshot(), business_context: active }, undefined,
      { scope: this.businessContextScope, files });
    this.contextRef.files = files;
    this.contextRef.prompt = businessContextPrompt(files);
  }

  get expiresAt(): Date {
    return this.db.expiresAt;
  }

  touch(): void {
    this.lastUsedAt = new Date();
    this.db.touch();
  }

  snapshot() {
    return {
      ...this.db.snapshot(),
      title: this.title ?? null,
      tasks: [...this.tasks.values()].slice(-20).map((task) => ({
        id: task.id,
        status: task.status,
        goal: task.goal.slice(0, 200),
        created_at: task.created_at,
        finished_at: task.finished_at,
      })),
      current_task_id: this.current && ["queued", "running", "waiting_for_user"].includes(this.current.status) ? this.current.id : null,
      queued_tasks: this.queue.length,
      business_context: this.businessContextSelection(),
      business_pilot: this.business ? { enabled: this.business.enabled } : undefined,
      agent: {
        model: String((this.agent.model as { id?: string } | undefined)?.id ?? "unknown"),
        provider: this.agent.model?.provider ?? null,
        thinking_level: this.agent.thinkingLevel,
        context_window: this.agent.model?.contextWindow ?? null,
        selection: this.modelSelection ?? null,
        turns: this.turns,
        context_usage: safeContextUsage(this.agent),
      },
    };
  }

  /** Names the session from its live transcript with the session's own model and persists it. */
  async generateTitle(): Promise<GeneratedSessionTitle> {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    const result = await generateSessionTitle(this.agent.agent);
    this.setTitle(result.title);
    return result;
  }

  setTitle(title: string): void {
    this.title = title;
    this.history?.saveSession(this.ownerKey, this.snapshot());
  }

  getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError("NOT_FOUND", `Task ${taskId} not found`);
    return task;
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  // ------------------------------------------------------------------- tasks

  submit(goal: string, options: { maxTurns?: number } = {}): TaskRecord {
    if (this.closed) throw new AppError("SESSION_CLOSED", "Session is closed");
    if (this.changingModel) throw new AppError("SESSION_BUSY", "正在切换模型，请稍后发送。");
    if (this.stagedQuestion || this.current?.status === "waiting_for_user")
      throw new AppError("SESSION_BUSY", "请先回答或取消当前分析的追问。");
    const snapshot = this.db.snapshot();
    if (snapshot.status === "unavailable") throw new AppError("SESSION_UNAVAILABLE", snapshot.unavailable_reason ?? "Open a new session");
    const maxTurns = Math.min(options.maxTurns ?? this.app.budgets.maxTurns, this.app.budgets.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1)
      throw new AppError("INVALID_INPUT", "max_turns must be a positive integer");
    if (this.queue.length >= 8) throw new AppError("TASK_QUEUE_FULL", "Too many queued tasks for this session");
    const record: TaskRecord = {
      id: TASK_ID(),
      session_id: this.id,
      goal,
      status: "queued",
      created_at: new Date().toISOString(),
      turns: 0,
      queries_used: 0,
      max_turns: maxTurns,
      results: [],
      artifacts: [],
    };
    this.tasks.set(record.id, record);
    this.queue.push({ record, maxTurns });
    this.saveTask(record);
    this.broker.publish(record.id, "task_queued", { goal });
    void this.drain();
    this.touch();
    return record;
  }

  private stageClarification(input: QuestionInput) {
    const task = this.current;
    if (!task || task.status !== "running" || this.abortRequested || this.timedOut)
      throw new AppError("NO_ACTIVE_TASK", "No running analysis can ask for clarification");
    if (this.stagedQuestion) throw new AppError("SESSION_BUSY", "Only one question can be asked at a time");
    if ((task.clarifications?.length ?? 0) >= MAX_CLARIFICATIONS || this.maxTurns - this.turns < 2)
      throw new AppError("TASK_BUDGET_EXCEEDED", "The clarification limit was reached or fewer than two turns remain to explore and answer. State the unresolved limitation without guessing.");
    const id = randomUUID();
    this.stagedQuestion = { ...input, id, kind: "follow_up" };
    return { id };
  }

  private pendingQuestion(task: TaskRecord) {
    const question = task.clarifications?.at(-1);
    return question && !question.answer ? question : undefined;
  }

  answerClarification(taskId: string, input: ClarificationAnswer): TaskRecord {
    const previous = this.tasks.get(taskId);
    if (previous?.error?.code === "CLARIFICATION_EXPIRED" && this.pendingQuestion(previous)?.id === input.question_id)
      throw new AppError("CLARIFICATION_EXPIRED", "追问已过期，请重新发起分析。");
    const task = this.current;
    const question = task && this.pendingQuestion(task);
    if (this.closed || task?.id !== taskId || task.status !== "waiting_for_user" || question?.id !== input.question_id)
      throw new AppError("CLARIFICATION_NOT_PENDING", "这条追问已处理或不是当前待答问题。");
    if (Date.now() >= Date.parse(question.expires_at)) {
      this.endClarification(task, "CLARIFICATION_EXPIRED");
      throw new AppError("CLARIFICATION_EXPIRED", "追问已过期，请重新发起分析。");
    }
    const option = "option_id" in input ? question.options?.find(entry => entry.id === input.option_id) : undefined;
    if ("option_id" in input && !option) throw new AppError("INVALID_INPUT", "请选择当前追问的有效选项。");
    this.stopClarificationClock(task);
    question.answer = { text: "text" in input ? input.text : option!.label, option_id: option?.id, answered_at: new Date().toISOString() };
    task.status = "queued";
    this.queue.unshift({ record: task, maxTurns: task.max_turns ?? this.app.budgets.maxTurns, resumed: true });
    this.saveTask(task);
    this.broker.publish(task.id, "question_answered", { question_id: question.id, ...question.answer });
    this.touch();
    void this.drain();
    return task;
  }

  private stopClarificationClock(task: TaskRecord): void {
    clearTimeout(this.clarificationTimer);
    this.clarificationTimer = undefined;
    const question = this.pendingQuestion(task);
    if (question) task.waiting_ms = (task.waiting_ms ?? 0) + Math.max(0, Date.now() - Date.parse(question.asked_at));
  }

  private endClarification(task: TaskRecord, code: "TASK_CANCELLED" | "CLARIFICATION_EXPIRED"): void {
    if (task.status !== "waiting_for_user") return;
    this.stopClarificationClock(task);
    task.status = code === "TASK_CANCELLED" ? "cancelled" : "incomplete";
    task.error = { code, message: code === "TASK_CANCELLED" ? "已取消等待回答的分析。" : "追问等待超时，未执行后续分析。" };
    task.finished_at = new Date().toISOString();
    this.current = this.sessionRef.current = undefined;
    this.finishTask(task, task.execution_ms);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.current?.status === "waiting_for_user") return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        if (item.record.status !== "queued") continue;
        try {
          await this.runTask(item.record, item.maxTurns, item.resumed ?? false);
        } catch (error) {
          this.stagedQuestion = undefined;
          item.record.status = "failed";
          item.record.error = isAppError(error)
            ? { code: error.code, message: error.message }
            : { code: "TASK_FAILED", message: (error as Error).message };
          item.record.finished_at = new Date().toISOString();
          this.finishTask(item.record);
        }
        if ((item.record.status as TaskStatus) === "waiting_for_user") return;
        this.current = this.sessionRef.current = undefined;
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: TaskRecord, maxTurns: number, resumed: boolean): Promise<void> {
    const snapshot = this.db.snapshot();
    if (!resumed && snapshot.status === "unavailable") throw new AppError("SESSION_UNAVAILABLE", snapshot.unavailable_reason ?? "Reconnect this session to continue");
    this.current = task;
    this.sessionRef.current = task;
    this.abortRequested = false;
    this.timedOut = false;
    this.turns = task.turns;
    this.stagedQuestion = undefined;
    this.maxTurns = maxTurns;
    this.turnBudgetExceeded = false;
    this.settledAborted = false;
    this.finalMessage = undefined;
    this.sourceInFlight.clear();
    this.sourceRequestsInFlight.clear();
    this.agent.setActiveToolsByName(this.effectiveTools.map(t => t.name));
    task.status = "running";
    task.started_at ??= new Date().toISOString();
    const queriesBefore = snapshot.queries.used;
    const startedAt = Date.now();
    const remainingMs = this.app.budgets.taskTimeoutMs - (task.execution_ms ?? 0);
    const usageBefore = this.agent.getSessionStats();
    this.saveTask(task);
    this.broker.publish(task.id, "task_started", { goal: task.goal, max_turns: maxTurns, resumed, phase: "analysis", execution_ms: task.execution_ms ?? 0, waiting_ms: task.waiting_ms ?? 0 });

    let settledResolve: ((aborted: boolean) => void) | undefined;
    const settled = new Promise<boolean>((resolve) => {
      settledResolve = resolve;
    });
    this.settledResolve = (aborted) => settledResolve?.(aborted);

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.agent.abort();
    }, Math.max(1, remainingMs));
    timer.unref?.();

    let failure: unknown;
    try {
      if (remainingMs <= 0) {
        this.timedOut = true;
        throw new AppError("TASK_TIMEOUT", "No execution time remains");
      }
      await this.db.observeOperations((op) => {
        const operations = task.operations ??= {};
        const totals = operations[op.kind] ??= { count: 0, duration_ms: 0 };
        totals.count++;
        totals.duration_ms += op.duration_ms;
        this.broker.publish(task.id, "db_operation", op);
      }, () => this.agent.prompt(resumed ? clarificationPrompt(task.goal, task.clarifications ?? []) : task.goal), (request) => {
        if (this.current?.id !== task.id || task.finished_at) return;
        const requests = task.source_requests ??= {};
        const totals = requests[request.kind] ??= { count: 0, duration_ms: 0 };
        if (request.phase === "started") {
          if (request.kind !== "control") this.sourceRequestsInFlight.add(request.id);
          totals.count++;
        } else {
          this.sourceRequestsInFlight.delete(request.id);
          totals.duration_ms += request.duration_ms;
        }
        this.broker.publish(task.id, "source_request", request);
      });
      // prompt() resolves when the run finishes; agent_settled covers queued continuations.
      await Promise.race([settled, delay(30_000)]);
    } catch (error) {
      failure = error;
      if (!this.timedOut || remainingMs > 0) await Promise.race([settled, delay(5_000)]).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.settledResolve = undefined;
    }

    const usageAfter = this.agent.getSessionStats();
    const usage = diffUsage(usageBefore, usageAfter);
    for (const key of Object.keys(usage) as Array<keyof TaskUsage>) usage[key] += task.usage?.[key] ?? 0;
    task.usage = usage;
    task.turns = this.turns;
    task.queries_used += Math.max(0, this.db.snapshot().queries.used - queriesBefore);
    task.execution_ms = (task.execution_ms ?? 0) + Math.max(0, Date.now() - startedAt);
    // The hook stages the request before Pi settles; expose it only when the tools and
    // transcript have settled, and only if no cancellation/failure won the race.
    const staged = this.stagedQuestion as StagedQuestion | undefined;
    try {
      const results = await this.db.listResults();
      task.results = results.filter((result) => result.taskId === task.id).map((result) => result.id);
      task.business_results = results.filter(result => result.taskId === task.id && result.business && !result.error).map(result => result.id);
      const entries = await this.artifacts.listBySession(this.id);
      task.artifacts = [...new Set([
        ...(task.artifacts ?? []),
        ...entries.filter((entry) => entry.task_id === task.id).map((entry) => entry.id),
      ])];
    } catch {
      task.results = [];
    }

    // Event callbacks update this field while prompt() is awaited.
    const finalMessage = this.finalMessage as FinalAssistantMessage | undefined;
    this.stagedQuestion = undefined;
    if (this.abortRequested) {
      task.status = "cancelled";
      task.error = { code: "TASK_CANCELLED", message: "Task was cancelled" };
    } else if (this.timedOut) {
      task.status = "failed";
      task.error = {
        code: "TASK_TIMEOUT",
        message: `Task exceeded the ${Math.round(this.app.budgets.taskTimeoutMs / 1000)}s execution limit`,
      };
    } else if (failure) {
      task.status = "failed";
      task.error = isAppError(failure)
        ? { code: failure.code, message: failure.message }
        : { code: "TASK_FAILED", message: (failure as Error).message ?? String(failure) };
    } else if (this.turnBudgetExceeded) {
      task.status = "incomplete";
      task.error = { code: "TASK_BUDGET_EXCEEDED", message: `Task exhausted its ${maxTurns} turn budget` };
    } else if (finalMessage?.stopReason === "error") {
      task.status = "failed";
      task.error = { code: "MODEL_ERROR", message: finalMessage.errorMessage || "The model failed to complete the response" };
    } else if (finalMessage?.stopReason === "length") {
      task.status = "incomplete";
      task.error = { code: "MODEL_OUTPUT_TRUNCATED", message: "The model response reached its output token limit" };
    } else if (this.settledAborted || finalMessage?.stopReason === "aborted") {
      task.status = "incomplete";
      task.error = { code: "TASK_INTERRUPTED", message: "Agent execution was interrupted" };
    } else if (staged) {
      const now = Date.now();
      const waitMs = Math.min(CLARIFICATION_WAIT_MS, this.app.sessionTtlMs);
      const question: TaskClarification = { ...staged, asked_at: new Date(now).toISOString(), expires_at: new Date(now + waitMs).toISOString() };
      (task.clarifications ??= []).push(question);
      task.status = "waiting_for_user";
      // Interim narration is not an answer to the analysis.
      delete task.answer;
      this.touch();
      this.saveTask(task);
      this.clarificationTimer = setTimeout(() => this.endClarification(task, "CLARIFICATION_EXPIRED"), waitMs);
      this.clarificationTimer.unref?.();
      this.broker.publish(task.id, "question_asked", { ...question, execution_ms: task.execution_ms, waiting_ms: task.waiting_ms ?? 0 });
      return;
    } else if (this.turns === 0 || !finalMessage?.text || finalMessage.hasTools || finalMessage.stopReason !== "stop") {
      task.status = "incomplete";
      task.error = { code: "TASK_INCOMPLETE", message: "The agent did not produce a complete final answer" };
    } else {
      task.status = "succeeded";
    }

    // Stamped last: `finished_at` is what a polling client watches, so it must not be visible while
    // status is still "running".
    task.finished_at = new Date().toISOString();
    this.finishTask(task, task.execution_ms);
  }

  private saveTask(task: TaskRecord): void {
    this.history?.saveTask(this.ownerKey, task);
    this.history?.saveSession(this.ownerKey, this.snapshot());
  }

  private finishTask(task: TaskRecord, durationMs?: number): void {
    task.activity = taskActivity(task, this.history?.listEvents(task.id) ?? this.broker.list(task.id)).summary;
    this.saveTask(task);
    this.broker.publish(task.id, "task_finished", {
      status: task.status,
      // Carried on the terminal event so a client that attached late (or missed deltas) can still
      // render the report without a second request.
      answer: task.answer ?? "",
      error: task.error ?? null,
      duration_ms: durationMs,
      execution_ms: task.execution_ms,
      waiting_ms: task.waiting_ms,
      clarifications: task.clarifications,
      activity: task.activity,
      turns: task.turns,
      usage: task.usage,
      results: task.results,
      business_results: task.business_results,
      operations: task.operations,
      source_requests: task.source_requests,
      source_recovery: task.source_recovery,
      artifacts: task.artifacts ?? [],
    });
  }

  async cancelTask(taskId?: string): Promise<boolean> {
    if (taskId && (this.current?.id !== taskId || this.current.status === "queued")) {
      const queued = this.queue.find((item) => item.record.id === taskId);
      if (queued) {
        queued.record.status = "cancelled";
        queued.record.finished_at = new Date().toISOString();
        queued.record.error = { code: "TASK_CANCELLED", message: "Task was cancelled before execution" };
        this.queue.splice(this.queue.indexOf(queued), 1);
        this.finishTask(queued.record);
        return true;
      }
      return false;
    }

    if (this.current?.status === "waiting_for_user") {
      this.endClarification(this.current, "TASK_CANCELLED");
      return true;
    }
    const running = this.current;
    if (!running || running.status !== "running") return false;

    this.abortRequested = true;
    // Control channel: cancel the query directly, outside the serialised queue.
    await this.db.cancel().catch(() => false);
    if (this.current === running && running.status === "running") void this.agent.abort();
    return true;
  }

  async steer(text: string, taskId?: string): Promise<void> {
    const task = this.current;
    if (task?.status === "waiting_for_user" || this.stagedQuestion)
      throw new AppError("SESSION_BUSY", "请在追问卡片中回答当前问题。");
    if (!task || task.status !== "running" || (taskId && task.id !== taskId))
      throw new AppError("NO_ACTIVE_TASK", "No matching task is running");
    await this.agent.steer(text);
    this.broker.publish(task.id, "notice", { code: "STEERED", text });
  }

  unsubscribeAll(taskId: string, afterSeq = 0): TaskEvent[] {
    return this.broker.list(taskId, afterSeq);
  }

  watch(taskId: string, fn: (event: TaskEvent) => void, afterSeq = 0): () => void {
    this.getTask(taskId);
    const backlog = this.broker.list(taskId, afterSeq);
    for (const event of backlog) fn(event);
    return this.broker.subscribe(taskId, fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      item.record.status = "cancelled";
      item.record.finished_at = new Date().toISOString();
      item.record.error = { code: "SESSION_CLOSED", message: "Session was closed" };
      this.finishTask(item.record);
    }
    await this.cancelTask();
    while (this.draining || this.changingModel) await new Promise((resolve) => setTimeout(resolve, 10));
    this.agent.dispose();
    await this.db.close().catch(() => undefined);
    this.history?.saveSession(this.ownerKey, this.snapshot());
  }

  // -------------------------------------------------------------- pi mapping

  private mapEvent(event: any): void {
    const task = this.current;
    if (!task) return;
    switch (event.type) {
      case "turn_start": {
        this.turns += 1;
        // The notice is published once per task; a pending turn after the budget is spent must not
        // repeat it (turn_end and this branch can both fire for the same overrun).
        if (this.turns > this.maxTurns && !this.turnBudgetExceeded && !this.abortRequested && !this.timedOut) {
          this.turnBudgetExceeded = true;
          this.broker.publish(task.id, "notice", { code: "TURN_BUDGET_EXCEEDED", max_turns: this.maxTurns });
          void this.agent.abort();
        }
        this.broker.publish(task.id, "turn_started", { turn: this.turns });
        break;
      }
      case "turn_end": {
        const needsMore = this.finalMessage?.hasTools || this.finalMessage?.stopReason === "toolUse";
        if (this.turns >= this.maxTurns && needsMore && !this.turnBudgetExceeded && !this.abortRequested && !this.timedOut) {
          this.turnBudgetExceeded = true;
          this.broker.publish(task.id, "notice", { code: "TURN_BUDGET_EXCEEDED", max_turns: this.maxTurns });
          void this.agent.abort();
        }
        break;
      }
      case "message_update": {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (update?.type === "text_delta" && update.delta) {
          this.broker.publish(task.id, "message_delta", { text: update.delta });
        } else if (update?.type === "thinking_delta" && update.delta) {
          this.broker.publish(task.id, "reasoning_delta", { text: update.delta });
        }
        break;
      }
      case "tool_execution_start": {
        if (SOURCE_TOOLS.has(event.toolName)) this.sourceInFlight.add(event.toolCallId);
        this.broker.publish(task.id, "tool_started", {
          call_id: event.toolCallId,
          tool: event.toolName,
          args: sanitizeArgs(event.args),
        });
        break;
      }
      case "tool_execution_end": {
        const result = event.result as { content?: Array<{ type?: string; text?: string }>; details?: unknown } | undefined;
        const output = result?.content?.find((part) => part.type === "text")?.text;
        const details = result?.details as { code?: string; chart_id?: unknown; source_blocked?: boolean } | undefined;
        const chartId = details?.chart_id;
        this.sourceInFlight.delete(event.toolCallId);
        if (!task.source_recovery && SOURCE_TOOLS.has(event.toolName) &&
            (details?.code === "SESSION_UNAVAILABLE" || this.db.snapshot().status === "unavailable")) {
          task.source_recovery = { code: "SESSION_UNAVAILABLE", in_flight: [...this.sourceInFlight], in_flight_requests: [...this.sourceRequestsInFlight] };
          this.agent.setActiveToolsByName(this.agent.getActiveToolNames().filter(name => !SOURCE_TOOLS.has(name)));
          this.broker.publish(task.id, "notice", { ...task.source_recovery, text: "源连接已失效，已停止本任务的源工具。可继续查看已保存证据；如需查询，请重连。" });
        }
        if (["chart_create", "chart_revise"].includes(event.toolName) && !event.isError && typeof chartId === "string") {
          task.artifacts = [...new Set([...(task.artifacts ?? []), chartId])];
          this.saveTask(task);
        }
        this.broker.publish(task.id, "tool_finished", {
          call_id: event.toolCallId,
          tool: event.toolName,
          is_error: Boolean(event.isError || details?.code),
          error_code: details?.code,
          source_blocked: details?.source_blocked,
          duration_ms: event.durationMs ?? null,
          summary: output ? output.slice(0, 400) : undefined,
          details: result?.details,
        });
        break;
      }
      case "agent_settled": {
        this.settledAborted = Boolean(event.aborted);
        this.settledResolve?.(Boolean(event.aborted));
        this.settledResolve = undefined;
        break;
      }
      case "auto_retry_start": {
        this.broker.publish(task.id, "retry", { attempt: event.attempt, max_attempts: event.maxAttempts, error: event.errorMessage });
        break;
      }
      case "compaction_end": {
        this.broker.publish(task.id, "context_compacted", { reason: event.reason, aborted: event.aborted });
        break;
      }
      case "message_end": {
        const message = event.message as
          | { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> }
          | undefined;
        if (message?.role === "assistant") {
          const text = (message.content ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
            .trim();
          if (text) task.answer = text;
          const hasTools = (message.content ?? []).some(part => part.type === "toolCall");
          if (text && !hasTools && message.stopReason === "stop" && !this.stagedQuestion && !this.abortRequested && !this.timedOut && !this.turnBudgetExceeded) {
            // Completed model response, not an intermediate query preview. Final task status
            // still arrives after result/artifact bookkeeping and can supersede this view.
            this.broker.publish(task.id, "answer_ready", { answer: text });
          }
          this.finalMessage = {
            text, stopReason: message.stopReason, errorMessage: message.errorMessage,
            hasTools,
          };
          this.saveTask(task);
          this.broker.publish(task.id, "usage", { ...this.agent.getSessionStats().tokens, context_usage: safeContextUsage(this.agent) });
        }
        break;
      }
      default:
        break;
    }
  }
}

function sanitizeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") output[key] = value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
    else output[key] = value;
  }
  return output;
}

function diffUsage(a: ReturnType<AgentSession["getSessionStats"]>, b: ReturnType<AgentSession["getSessionStats"]>): TaskUsage {
  return {
    input: b.tokens.input - a.tokens.input,
    output: b.tokens.output - a.tokens.output,
    cacheRead: b.tokens.cacheRead - a.tokens.cacheRead,
    cacheWrite: b.tokens.cacheWrite - a.tokens.cacheWrite,
    cost: b.cost - a.cost,
  };
}

function safeContextUsage(agent: AgentSession): unknown {
  try {
    return agent.getSessionStats().contextUsage ?? null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
