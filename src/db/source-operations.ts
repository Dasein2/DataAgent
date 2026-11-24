import { AsyncLocalStorage } from "node:async_hooks";
import { sourceError } from "./source-errors.js";

export type SourceRequestKind = "metadata" | "preflight" | "source_select" | "control";
export type SourceRequest =
  | { id: number; kind: SourceRequestKind; phase: "started" }
  | { id: number; kind: SourceRequestKind; phase: "finished"; duration_ms: number; code?: string };

interface SourceContext {
  emit: (request: SourceRequest) => void;
  kind?: SourceRequestKind;
  assertAvailable: () => void;
  sequence: { value: number };
}
const context = new AsyncLocalStorage<SourceContext>();

export function observeSourceRequests<T>(emit: SourceContext["emit"], assertAvailable: () => void, execute: () => T) {
  return context.run({ emit, assertAvailable, sequence: { value: 0 } }, execute);
}

export function classifySourceRequests<T>(kind: SourceRequestKind, execute: () => T): T {
  const current = context.getStore();
  return current ? context.run({ ...current, kind }, execute) : execute();
}

/** Call only at driver dispatch, not when a tool is called or a request joins a queue. */
export async function sourceRequest<T>(fallback: SourceRequestKind, execute: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current) return execute();
  if (fallback !== "control") current.assertAvailable();
  const id = ++current.sequence.value;
  const kind = fallback === "control" ? fallback : current.kind ?? fallback;
  const start = performance.now();
  current.emit({ id, kind, phase: "started" });
  let code: string | undefined;
  try { return await execute(); }
  catch (error) { code = sourceError(error).code; throw error; }
  finally { current.emit({ id, kind, phase: "finished", duration_ms: Math.round(performance.now() - start), code }); }
}
