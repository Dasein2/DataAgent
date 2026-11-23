import type { BudgetConfig } from "../config.js";
import type { ConnectionConfig, EngineKind } from "./types.js";

/** A connect-time, session-scoped setting; 0 means the server declares no limit. */
export interface ServerQueryTimeout {
  status: "detected" | "unlimited" | "unavailable";
  timeoutMs?: number;
  variable: string;
}

export interface QueryTimeoutPolicy {
  mode: "auto" | "manual";
  requestedMs?: number;
  effectiveMs: number;
  platformMaxMs: number;
  taskMaxMs: number;
  server: ServerQueryTimeout;
  source: "connection" | "server" | "engine_default";
  clampedBy: Array<"server" | "platform" | "task">;
}

export function timeoutVariable(engine: EngineKind): string {
  return engine === "postgres" ? "statement_timeout" : engine === "mysql" ? "max_execution_time" : "query_timeout";
}

/** Strict parsing: never treat malformed, negative or overflowing settings as unlimited. */
export function parseServerQueryTimeout(engine: EngineKind, value: unknown): ServerQueryTimeout {
  const variable = timeoutVariable(engine);
  const unavailable: ServerQueryTimeout = { status: "unavailable", variable };
  if (typeof value !== "string" && typeof value !== "number") return unavailable;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/i);
  if (!match) return unavailable;
  const unit = match[2]?.toLowerCase() ?? (engine === "doris" || engine === "starrocks" ? "s" : "ms");
  const factor = ({ ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[unit]!;
  const ms = Number(match[1]) * factor;
  if (!Number.isSafeInteger(ms) || ms < 0) return unavailable;
  return ms === 0 ? { status: "unlimited", timeoutMs: 0, variable } : { status: "detected", timeoutMs: ms, variable };
}

/** Bounded policy only; no costly benchmark queries or automatic retry/limit escalation. */
export function resolveQueryTimeout(
  connection: Pick<ConnectionConfig, "engine" | "queryTimeoutMs">,
  budgets: Pick<BudgetConfig, "queryTimeoutMs" | "maxQueryTimeoutMs" | "taskTimeoutMs">,
  detected?: ServerQueryTimeout,
): QueryTimeoutPolicy {
  const server = detected ?? { status: "unavailable" as const, variable: timeoutVariable(connection.engine) };
  const platformMaxMs = Math.min(budgets.maxQueryTimeoutMs ?? 600_000, 2_147_483_647);
  const taskMaxMs = Math.min(budgets.taskTimeoutMs, 2_147_483_647);
  const requestedMs = connection.queryTimeoutMs;
  const fallback = connection.engine === "doris" || connection.engine === "starrocks" ? 300_000 : budgets.queryTimeoutMs;
  const hasServerLimit = server.status === "detected" && Number.isSafeInteger(server.timeoutMs) && server.timeoutMs! > 0;
  const source = requestedMs !== undefined ? "connection" : hasServerLimit ? "server" : "engine_default";
  const candidate = requestedMs ?? (hasServerLimit ? server.timeoutMs! : fallback);
  const limits = { server: hasServerLimit ? server.timeoutMs! : Infinity, platform: platformMaxMs, task: taskMaxMs };
  return {
    mode: requestedMs === undefined ? "auto" : "manual",
    requestedMs,
    effectiveMs: Math.min(candidate, ...Object.values(limits)),
    platformMaxMs,
    taskMaxMs,
    server,
    source,
    clampedBy: (Object.entries(limits) as Array<[keyof typeof limits, number]>).filter(([, limit]) => limit < candidate).map(([key]) => key),
  };
}
