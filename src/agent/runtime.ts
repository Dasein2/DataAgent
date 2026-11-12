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

  static async create(options: {
    config: ConnectionConfig;
    app: AppConfig;
    results: ResultStore;
    model: ModelHandle;
    broker: EventBroker;
    ownerKey: string;
  }): Promise<AnalysisSession> {
    const { app, config, broker } = options;
    const db = await DbSession.open({ config, app, results: options.results });
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
        thinkingLevel: "medium",
        sessionManager: SessionManager.inMemory(),
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

    const analysis = new AnalysisSession(db.id, options.ownerKey, db, session, broker, app, sessionRef);
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
    this.queue.push({ record });
    this.broker.publish(record.id, "task_queued", { goal });
    void this.drain(options.maxTurns ?? this.app.budgets.maxTurns);
    this.touch();
    return record;
  }

  private async drain(maxTurns: number): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        if (item.record.status !== "queued") continue;
        await this.runTask(item.record, maxTurns);
      }
    } finally {
      this.draining = false;
      this.current = undefined;
      this.sessionRef.current = undefined;
    }
  }

  private async runTask(task: TaskRecord, maxTurns: number): Promise<void> {
    this.current = task;
    this.sessionRef.current = task;
    this.abortRequested = false;
    this.timedOut = false;
    this.turns = 0;
    task.status = "running";
    task.started_at = new Date().toISOString();
    const queriesBefore = this.db.snapshot().queries.used;
    const startedAt = Date.now();
    const usageBefore = this.agent.getSessionStats();
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

    const maxTurnTimer = setInterval(() => {
      if (this.turns > maxTurns && !this.abortRequested) {
        this.abortRequested = true;
        this.broker.publish(task.id, "notice", { code: "TURN_BUDGET_EXCEEDED", max_turns: maxTurns });
        this.agent.abort();
      }
    }, 1_000);
    maxTurnTimer.unref?.();

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
      clearInterval(maxTurnTimer);
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
    } else if (this.turns === 0) {
      task.status = "incomplete";
      task.error = { code: "TASK_INCOMPLETE", message: "The agent produced no turn for this task" };
    } else {
      task.status = "succeeded";
    }

    task.queries_used = Math.max(0, this.db.snapshot().queries.used - queriesBefore);
    this.broker.publish(task.id, "task_finished", {
      status: task.status,
      // Carried on the terminal event so a client that attached late (or missed deltas) can still
      // render the report without a second request.
      answer: task.answer ?? "",
      error: task.error ?? null,
      duration_ms: Date.now() - startedAt,
      turns: task.turns,
      usage: task.usage,
      results: task.results,
    });
  }

  async cancelTask(taskId?: string): Promise<boolean> {
    if (taskId && this.current && this.current.id !== taskId) {
      const queued = this.queue.find((item) => item.record.id === taskId);
      if (queued) {
        queued.record.status = "cancelled";
        queued.record.finished_at = new Date().toISOString();
        this.queue.splice(this.queue.indexOf(queued), 1);
        this.broker.publish(taskId, "task_finished", { status: "cancelled", error: { code: "TASK_CANCELLED" } });
        return true;
      }
      return false;
    }

    this.abortRequested = true;
    // Control channel: cancel the query directly, outside the serialised queue.
    const cancelled = await this.db.cancel().catch(() => false);
    this.agent.abort();
    return cancelled || this.current !== undefined;
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
    this.queue.length = 0;
    this.agent.abort();
    this.agent.dispose();
    await this.db.close().catch(() => undefined);
  }

  // -------------------------------------------------------------- pi mapping

  private mapEvent(event: any): void {
    const task = this.current;
    if (!task) return;
    switch (event.type) {
      case "turn_start": {
        this.turns += 1;
        this.broker.publish(task.id, "turn_started", { turn: this.turns });
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
          | { role?: string; content?: Array<{ type?: string; text?: string }> }
          | undefined;
        if (message?.role === "assistant") {
          const text = (message.content ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("")
            .trim();
          if (text) task.answer = text;
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
