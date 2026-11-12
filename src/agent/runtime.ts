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
import type { AppConfig } from "../config.js";
import type { ConnectionConfig } from "../db/types.js";
import { DbSession } from "../db/session.js";
import { AppError, isAppError } from "../errors.js";
import type { ResultStore } from "../results/store.js";
import { buildSystemPrompt } from "./prompts.js";
import { createDatabaseTools, type ToolRuntime } from "./tools.js";
import { EventBroker, type TaskEvent } from "./events.js";
import type { ModelHandle } from "./model.js";
import type { HistoryStore } from "./history.js";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "incomplete";

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
  queries_used: number;
  results: string[];
  /** Last non-empty assistant message; the report a polling client can read without SSE. */
  answer?: string;
}

interface QueueItem {
  record: TaskRecord;
  maxTurns: number;
}

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
    private readonly broker: EventBroker,
    private readonly app: AppConfig,
    private readonly sessionRef: { current?: TaskRecord },
    private readonly history?: HistoryStore,
  ) {}

  readonly createdAt = new Date();
  private lastUsedAt = new Date();
  private closed = false;
  private draining = false;
  private current?: TaskRecord;
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

  static async create(options: {
    config: ConnectionConfig;
    app: AppConfig;
    results: ResultStore;
    model: ModelHandle;
    broker: EventBroker;
    ownerKey: string;
    history?: HistoryStore;
    sessionId?: string;
  }): Promise<AnalysisSession> {
    const { app, config, broker } = options;
    const db = await DbSession.open({ config, app, results: options.results, sessionId: options.sessionId });
    const cwd = join(app.dataDir, "workspaces", db.id);
    await mkdir(cwd, { recursive: true });

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
      systemPrompt: buildSystemPrompt(db.capabilitiesView, app.budgets),
    });
    await resourceLoader.reload();

    const sessionRef: { current?: TaskRecord } = {};
    let session: AgentSession;
    try {
      const toolRuntime: ToolRuntime = {
        db,
        budgets: app.budgets,
        currentTaskId: () => sessionRef.current?.id,
        taskStatus: () => (sessionRef.current ? { ...sessionRef.current } : { status: "idle" }),
        cancelActive: () => db.cancel(),
      };
      const customTools = createDatabaseTools(toolRuntime);
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

    const analysis = new AnalysisSession(db.id, options.ownerKey, db, session, broker, app, sessionRef, options.history);
    if (options.sessionId) {
      for (const task of options.history?.listTasks(db.id, options.ownerKey) ?? []) analysis.tasks.set(task.id, task);
    }
    analysis.agent.subscribe((event) => {
      analysis.mapEvent(event);
    });
    return analysis;
  }

  // ---------------------------------------------------------------- lifecycle

  get isClosed(): boolean {
    return this.closed;
  }

  get isBusy(): boolean {
    return this.current !== undefined;
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
      tasks: [...this.tasks.values()].slice(-20).map((task) => ({
        id: task.id,
        status: task.status,
        goal: task.goal.slice(0, 200),
        created_at: task.created_at,
        finished_at: task.finished_at,
      })),
      current_task_id: this.current?.id ?? null,
      queued_tasks: this.queue.length,
      agent: {
        model: String((this.agent.model as { id?: string } | undefined)?.id ?? "unknown"),
        turns: this.turns,
        context_usage: safeContextUsage(this.agent),
      },
    };
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
    const snapshot = this.db.snapshot();
    if (snapshot.status === "unavailable") throw new AppError("SESSION_UNAVAILABLE", snapshot.unavailable_reason ?? "Open a new session");
    const maxTurns = Math.min(options.maxTurns ?? this.app.budgets.maxTurns, this.app.budgets.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new AppError("INVALID_INPUT", "maxTurns must be a positive integer");
    if (this.queue.length >= 8) throw new AppError("TASK_QUEUE_FULL", "Too many queued tasks for this session");
    const record: TaskRecord = {
      id: TASK_ID(),
      session_id: this.id,
      goal,
      status: "queued",
      created_at: new Date().toISOString(),
      turns: 0,
      queries_used: 0,
      results: [],
    };
    this.tasks.set(record.id, record);
    this.queue.push({ record, maxTurns });
    this.saveTask(record);
    this.broker.publish(record.id, "task_queued", { goal });
    void this.drain();
    this.touch();
    return record;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        if (item.record.status !== "queued") continue;
        try {
          await this.runTask(item.record, item.maxTurns);
        } catch (error) {
          item.record.status = "failed";
          item.record.error = isAppError(error)
            ? { code: error.code, message: error.message }
            : { code: "TASK_FAILED", message: (error as Error).message };
          item.record.finished_at = new Date().toISOString();
          this.finishTask(item.record);
        }
        this.current = undefined;
        this.sessionRef.current = undefined;
      }
    } finally {
      this.draining = false;
      this.current = undefined;
      this.sessionRef.current = undefined;
    }
  }

  private async runTask(task: TaskRecord, maxTurns: number): Promise<void> {
    const snapshot = this.db.snapshot();
    if (snapshot.status === "unavailable") throw new AppError("SESSION_UNAVAILABLE", snapshot.unavailable_reason ?? "Reconnect this session to continue");
    this.current = task;
    this.sessionRef.current = task;
    this.abortRequested = false;
    this.timedOut = false;
    this.turns = 0;
    this.maxTurns = maxTurns;
    this.turnBudgetExceeded = false;
    this.settledAborted = false;
    this.finalMessage = undefined;
    task.status = "running";
    task.started_at = new Date().toISOString();
    const queriesBefore = this.db.snapshot().queries.used;
    const startedAt = Date.now();
    const usageBefore = this.agent.getSessionStats();
    this.saveTask(task);
    this.broker.publish(task.id, "task_started", { goal: task.goal, max_turns: maxTurns });

    let settledResolve: ((aborted: boolean) => void) | undefined;
    const settled = new Promise<boolean>((resolve) => {
      settledResolve = resolve;
    });
    this.settledResolve = (aborted) => settledResolve?.(aborted);

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.agent.abort();
    }, this.app.budgets.taskTimeoutMs);
    timer.unref?.();

    let failure: unknown;
    try {
      await this.agent.prompt(task.goal);
      // prompt() resolves when the run finishes; agent_settled covers queued continuations.
      await Promise.race([settled, delay(30_000)]);
    } catch (error) {
      failure = error;
      await Promise.race([settled, delay(5_000)]).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.settledResolve = undefined;
    }

    const usageAfter = this.agent.getSessionStats();
    task.usage = diffUsage(usageBefore, usageAfter);
    task.turns = this.turns;
    task.finished_at = new Date().toISOString();
    try {
      const results = await this.db.listResults();
      task.results = results.filter((result) => result.taskId === task.id).map((result) => result.id);
    } catch {
      task.results = [];
    }

    // Event callbacks update this field while prompt() is awaited.
    const finalMessage = this.finalMessage as FinalAssistantMessage | undefined;
    if (this.abortRequested) {
      task.status = "cancelled";
      task.error = { code: "TASK_CANCELLED", message: "Task was cancelled" };
    } else if (this.timedOut) {
      task.status = "failed";
      task.error = {
        code: "TASK_TIMEOUT",
        message: `Task exceeded the ${Math.round(this.app.budgets.taskTimeoutMs / 1000)}s wall-clock limit`,
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
    } else if (this.turns === 0 || !finalMessage?.text || finalMessage.hasTools || finalMessage.stopReason !== "stop") {
      task.status = "incomplete";
      task.error = { code: "TASK_INCOMPLETE", message: "The agent did not produce a complete final answer" };
    } else {
      task.status = "succeeded";
    }

    task.queries_used = Math.max(0, this.db.snapshot().queries.used - queriesBefore);
    this.finishTask(task, Date.now() - startedAt);
  }

  private saveTask(task: TaskRecord): void {
    this.history?.saveTask(this.ownerKey, task);
    this.history?.saveSession(this.ownerKey, this.snapshot());
  }

  private finishTask(task: TaskRecord, durationMs?: number): void {
    this.saveTask(task);
    this.broker.publish(task.id, "task_finished", {
      status: task.status,
      // Carried on the terminal event so a client that attached late (or missed deltas) can still
      // render the report without a second request.
      answer: task.answer ?? "",
      error: task.error ?? null,
      duration_ms: durationMs,
      turns: task.turns,
      usage: task.usage,
      results: task.results,
    });
  }

  async cancelTask(taskId?: string): Promise<boolean> {
    if (taskId && this.current?.id !== taskId) {
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

    if (!this.current || this.current.status !== "running") return false;

    this.abortRequested = true;
    // Control channel: cancel the query directly, outside the serialised queue.
    await this.db.cancel().catch(() => false);
    this.agent.abort();
    return true;
  }

  async steer(text: string): Promise<void> {
    if (!this.current) throw new AppError("NO_ACTIVE_TASK", "No task is running; submit a task instead");
    await this.agent.steer(text);
    this.broker.publish(this.current.id, "notice", { code: "STEERED", text });
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
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 10));
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
        if (this.turns > this.maxTurns && !this.abortRequested && !this.timedOut) {
          this.turnBudgetExceeded = true;
          this.broker.publish(task.id, "notice", { code: "TURN_BUDGET_EXCEEDED", max_turns: this.maxTurns });
          void this.agent.abort();
        }
        this.broker.publish(task.id, "turn_started", { turn: this.turns });
        break;
      }
      case "turn_end": {
        const needsMore = this.finalMessage?.hasTools || this.finalMessage?.stopReason === "toolUse";
        if (this.turns >= this.maxTurns && needsMore && !this.abortRequested && !this.timedOut) {
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
        this.broker.publish(task.id, "tool_finished", {
          call_id: event.toolCallId,
          tool: event.toolName,
          is_error: Boolean(event.isError),
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
          this.finalMessage = {
            text, stopReason: message.stopReason, errorMessage: message.errorMessage,
            hasTools: (message.content ?? []).some((part) => part.type === "toolCall"),
          };
          this.saveTask(task);
          this.broker.publish(task.id, "usage", { ...this.agent.getSessionStats().tokens });
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
