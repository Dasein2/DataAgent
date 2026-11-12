import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ConnectionConfig } from "../db/types.js";
import type { TaskRecord } from "./runtime.js";
import type { TaskEvent } from "./events.js";
import { AppError } from "../errors.js";

export interface HistoricalSession {
  owner: string;
  connectionKey?: string;
  snapshot: Record<string, any>;
}

/** The identity is persisted as a digest; passwords and SSH credentials never enter history. */
export function connectionKey(config: ConnectionConfig): string {
  return createHash("sha256").update(JSON.stringify([
    config.engine, config.host, config.port, config.database, config.user,
    config.environment, config.workspace?.name ?? null,
  ])).digest("hex");
}

/** Single-process durable history. Writes are atomic; event streams remain append-only. */
export class HistoryStore {
  private readonly sessions = new Map<string, HistoricalSession>();
  private readonly tasks = new Map<string, { owner: string; task: TaskRecord }>();

  constructor(private readonly root: string) {
    mkdirSync(join(root, "sessions"), { recursive: true });
    mkdirSync(join(root, "tasks"), { recursive: true });
    mkdirSync(join(root, "events"), { recursive: true });
    this.load("sessions", (record) => {
      if (record?.owner && /^sess_[a-z0-9]+$/.test(record.snapshot?.session_id ?? "")) {
        const snapshot = record.snapshot;
        if (snapshot.status !== "closed") snapshot.status = "disconnected";
        snapshot.current_task_id = null;
        snapshot.queued_tasks = 0;
        this.sessions.set(snapshot.session_id, record);
      }
    });
    this.load("tasks", (record) => {
      if (!record?.owner || !/^task_[a-z0-9]+$/.test(record.task?.id ?? "")) return;
      const task = record.task as TaskRecord;
      this.tasks.set(task.id, record);
      const events = this.listEvents(task.id);
      if (task.status === "queued" || task.status === "running") {
        let partial = "";
        for (const event of events) {
          if (event.type === "turn_started" || event.type === "tool_started") partial = "";
          if (event.type === "message_delta" && typeof event.data.text === "string") partial += event.data.text;
        }
        if (partial.trim()) task.answer = partial.trim();
        task.status = "incomplete";
        task.finished_at = new Date().toISOString();
        task.error = { code: "SERVICE_RESTARTED", message: "Service restarted before this task completed; the task was not replayed" };
        this.saveTask(record.owner, task);
      }
      // Heal a crash between saving the terminal task and appending its terminal event.
      if (!events.some((event) => event.type === "task_finished")) {
        const seq = (events.at(-1)?.seq ?? 0) + 1;
        this.appendEvent({ seq, id: `${task.id}:${seq}`, task_id: task.id, type: "task_finished", at: task.finished_at ?? new Date().toISOString(),
          data: { status: task.status, answer: task.answer ?? "", error: task.error ?? null, results: task.results } });
      }
    });
    for (const [id, record] of this.sessions) {
      record.snapshot.tasks = this.listTasks(id, record.owner).slice(-20).map((task) => ({
        id: task.id, status: task.status, goal: task.goal.slice(0, 200),
        created_at: task.created_at, finished_at: task.finished_at,
      }));
    }
  }

  private load(dir: string, accept: (record: any) => void): void {
    for (const name of readdirSync(join(this.root, dir))) {
      if (!name.endsWith(".json")) continue;
      // Fail closed on corruption rather than overwrite an unreadable ownership record.
      accept(JSON.parse(readFileSync(join(this.root, dir, name), "utf8")));
    }
  }

  private write(dir: string, id: string, value: unknown): void {
    const path = join(this.root, dir, `${id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  }

  saveSession(owner: string, snapshot: Record<string, any>, key?: string): void {
    const id = snapshot.session_id as string;
    const existing = this.sessions.get(id);
    if (existing && existing.owner !== owner) throw new AppError("FORBIDDEN", "Session owner mismatch");
    const record = { owner, snapshot: structuredClone(snapshot), connectionKey: key ?? existing?.connectionKey };
    this.write("sessions", id, record);
    this.sessions.set(id, record);
  }

  getSession(id: string, owner: string): HistoricalSession {
    const record = this.sessions.get(id);
    if (!record || record.owner !== owner) throw new AppError("NOT_FOUND", `Session ${id} not found`);
    return structuredClone(record);
  }

  listSessions(owner: string): Record<string, any>[] {
    return [...this.sessions.values()].filter((record) => record.owner === owner).map((record) => structuredClone(record.snapshot));
  }

  saveTask(owner: string, task: TaskRecord): void {
    const record = { owner, task: structuredClone(task) };
    this.write("tasks", task.id, record);
    this.tasks.set(task.id, record);
  }

  getTask(id: string, owner: string): TaskRecord {
    const record = this.tasks.get(id);
    if (!record || record.owner !== owner) throw new AppError("TASK_NOT_FOUND", `Task ${id} not found`);
    return structuredClone(record.task);
  }

  listTasks(sessionId: string, owner: string): TaskRecord[] {
    this.getSession(sessionId, owner);
    return [...this.tasks.values()].filter((record) => record.owner === owner && record.task.session_id === sessionId)
      .map((record) => structuredClone(record.task)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  appendEvent(event: TaskEvent): void {
    appendFileSync(join(this.root, "events", `${event.task_id}.ndjson`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  listEvents(taskId: string): TaskEvent[] {
    if (!/^task_[a-z0-9]+$/.test(taskId)) return [];
    const path = join(this.root, "events", `${taskId}.ndjson`);
    if (!existsSync(path)) return [];
    let raw = readFileSync(path, "utf8");
    if (raw && !raw.endsWith("\n")) {
      const boundary = raw.lastIndexOf("\n") + 1;
      try {
        JSON.parse(raw.slice(boundary));
        raw += "\n";
      } catch {
        raw = raw.slice(0, boundary);
      }
      writeFileSync(path, raw, { mode: 0o600 });
    }
    const lines = raw.split("\n");
    const events: TaskEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as TaskEvent); }
      catch { throw new Error(`Corrupt event history for ${taskId}`); }
    }
    return events;
  }
}
