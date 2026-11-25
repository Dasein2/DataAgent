import type { TaskEvent } from "./events.js";
import type { TaskRecord } from "./runtime.js";

export interface ActivitySummary {
  /** Intermediate assistant text segments, tool results and retry/notice messages; excludes final answer. */
  messages: number;
  tool_calls: number;
  errors: number;
  retries: number;
  duration_ms?: number;
  available: boolean;
}

/** Compact persisted SSE deltas for on-demand display; never include hidden reasoning. */
export function taskActivity(task: TaskRecord, events: TaskEvent[]): { summary: ActivitySummary; events: TaskEvent[] } {
  const output: TaskEvent[] = [];
  let pending: TaskEvent | undefined;
  const flush = () => {
    if (pending && String(pending.data.text).trim()) output.push(pending);
    pending = undefined;
  };
  const seenCalls = new Set<string>(), finishedCalls = new Set<string>();
  for (const event of events) {
    if (event.type === "message_delta") {
      if (!pending) pending = { ...event, data: { text: "" } };
      pending.data.text = String(pending.data.text) + String(event.data.text ?? "");
      continue;
    }
    if (["tool_started", "turn_started", "usage", "retry", "notice", "task_finished"].includes(event.type)) flush();
    if (event.type === "tool_started") {
      const id = String(event.data.call_id);
      if (seenCalls.has(id)) continue;
      seenCalls.add(id);
    } else if (event.type === "tool_finished") {
      const id = String(event.data.call_id);
      if (finishedCalls.has(id)) continue;
      finishedCalls.add(id);
    } else if (event.type !== "retry" && event.type !== "notice") continue;
    output.push(event);
  }
  flush();
  // The task's answer is rendered outside the fold. Do not remove a pre-tool explanation that
  // merely happens to match the final answer; only the trailing non-tool text is eligible.
  const lastText = output.findLastIndex((event) => event.type === "message_delta");
  if (lastText >= 0 && task.answer?.trim() === String(output[lastText]!.data.text).trim() &&
    !output.slice(lastText + 1).some((event) => event.type === "tool_started")) output.splice(lastText, 1);
  const start = Date.parse(task.started_at ?? events.find((event) => event.type === "task_started")?.at ?? task.created_at);
  const end = Date.parse(task.finished_at ?? "");
  return {
    summary: {
      messages: output.filter((event) => event.type !== "tool_started").length,
      tool_calls: seenCalls.size,
      errors: output.filter((event) => event.type === "tool_finished" && event.data.is_error).length,
      retries: output.filter((event) => event.type === "retry").length,
      duration_ms: task.execution_ms ?? (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined),
      available: events.length > 0,
    },
    events: output,
  };
}
