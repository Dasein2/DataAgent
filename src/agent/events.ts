export type TaskEventType =
  | "task_queued"
  | "task_started"
  | "task_finished"
  | "message_delta"
  | "reasoning_delta"
  | "tool_started"
  | "tool_finished"
  | "turn_started"
  | "usage"
  | "retry"
  | "context_compacted"
  | "notice";

export interface TaskEvent {
  /** Monotonic per task, also used as the SSE event id. */
  seq: number;
  id: string;
  task_id: string;
  type: TaskEventType;
  at: string;
  data: Record<string, unknown>;
}

type Listener = (event: TaskEvent) => void;

/**
 * Bounded, in-memory event log per task plus live subscribers.
 * SSE clients can resume with Last-Event-ID because seq is monotonic.
 */
export class EventBroker {
  private readonly logs = new Map<string, TaskEvent[]>();
  private readonly listeners = new Set<{ taskId: string; fn: Listener }>();

  constructor(private readonly maxEventsPerTask = 5_000, private readonly history?: {
    appendEvent(event: TaskEvent): void;
    listEvents(taskId: string): TaskEvent[];
  }) {}

  private log(taskId: string): TaskEvent[] {
    let log = this.logs.get(taskId);
    if (!log) {
      log = this.history?.listEvents(taskId).slice(-this.maxEventsPerTask) ?? [];
      this.logs.set(taskId, log);
    }
    return log;
  }

  publish(taskId: string, type: TaskEventType, data: Record<string, unknown> = {}): TaskEvent {
    const log = this.log(taskId);
    const seq = (log.at(-1)?.seq ?? 0) + 1;
    const event: TaskEvent = {
      seq,
      id: `${taskId}:${seq}`,
      task_id: taskId,
      type,
      at: new Date().toISOString(),
      data,
    };
    this.history?.appendEvent(event);
    log.push(event);
    if (log.length > this.maxEventsPerTask) log.splice(0, log.length - this.maxEventsPerTask);
    this.logs.set(taskId, log);
    for (const listener of this.listeners) {
      if (listener.taskId !== taskId) continue;
      try {
        listener.fn(event);
      } catch {
        // A broken subscriber must not break task execution.
      }
    }
    return event;
  }

  list(taskId: string, afterSeq = 0): TaskEvent[] {
    return this.log(taskId).filter((event) => event.seq > afterSeq);
  }

  subscribe(taskId: string, fn: Listener): () => void {
    const entry = { taskId, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  drop(taskId: string): void {
    this.logs.delete(taskId);
  }
}
