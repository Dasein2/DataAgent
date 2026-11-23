import type {
  ColumnInfo,
  EngineKind,
  ExplainResult,
  ObjectDescription,
  ObjectRef,
  ProfileResult,
} from "../types.js";
import type { EngineProfile, ReadOnlyProof } from "./profiles.js";
import type { ServerQueryTimeout } from "../query-timeout.js";

export interface ColumnMeta {
  name: string;
  type: string;
}

export interface RowSink {
  onColumns?(columns: ColumnMeta[]): void;
  onRow(row: unknown[]): void | Promise<void>;
}

export interface QueryLimits {
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
  /** Max characters kept per stored cell. */
  maxCellChars: number;
  signal?: AbortSignal;
}

export interface QueryStats {
  columns: ColumnMeta[];
  rowCount: number;
  bytes: number;
  durationMs: number;
  truncated: "none" | "rows" | "bytes";
  warnings: string[];
}

export interface ObjectFilter {
  search?: string;
  searchColumns?: boolean;
  schema?: string;
  /** Apply the session allowlist before sorting and paginating. */
  scopes?: string[];
  kinds?: Array<"table" | "view" | "materialized_view" | "foreign_table" | "sequence">;
  limit: number;
  offset?: number;
  includeMatchDetails?: boolean;
}

/** Attach one representative column and the actual match count, without describing each table. */
export function attachColumnMatches(objects: ObjectRef[], rows: unknown[][]): void {
  const byName = new Map(objects.map((object) => [JSON.stringify([object.schema, object.name]), object]));
  for (const [schema, name, column, count] of rows) {
    const object = byName.get(JSON.stringify([schema, name]));
    if (object) object.columnMatch = { name: String(column), count: Number(count) };
  }
}

export const CATALOG_MATCHES = ["name", "schema", "comment", "column"] as const;
export const CATALOG_TABLE_KINDS = ["table", "foreign_table"] as const;
/** Keep empty scopes as zero, and never expose counts outside the session allowlist. */
export function tableCountsByScope(scopes: string[], rows: unknown[][]): Record<string, number> {
  const counts = new Map(scopes.map((scope) => [scope, 0]));
  for (const [scope, rawCount] of rows) {
    if (!counts.has(String(scope))) continue;
    const count = Number(rawCount);
    if (rawCount == null || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid catalog table count");
    counts.set(String(scope), count);
  }
  return Object.fromEntries(counts);
}

// Rank text matches before column-only matches. Put the engine-specific column
// predicate in WHERE so the rank expression does not have to evaluate a subquery.
export function catalogMatch(filter: ObjectFilter, name: string, schema: string, comment: string, column: string) {
  return filter.search ? {
    rank: `CASE WHEN ${name} THEN 1 WHEN ${schema} THEN 2 WHEN ${comment} THEN 3 ELSE 4 END`,
    where: `AND (${name} OR ${schema} OR ${comment}${filter.searchColumns ? " OR " + column : ""})`,
  } : { rank: "0", where: "" };
}

export function catalogLimit(filter: ObjectFilter): string {
  return `LIMIT ${Math.max(1, Math.min(2_000, Math.trunc(filter.limit)))} OFFSET ${Math.max(0, Math.trunc(filter.offset ?? 0))}`;
}

export interface DatasetObject {
  name: string;
  kind: "view" | "table";
  createdAt?: string | null;
  definition?: string | null;
}

const MAX_STORED_CELL_DEFAULT = 8_000;

export function serializeValue(value: unknown, maxChars = MAX_STORED_CELL_DEFAULT): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const preview = value.subarray(0, Math.min(value.length, 64)).toString("base64");
    return {
      __type: "bytes",
      bytes: value.length,
      base64Preview: preview,
      truncated: value.length > 64,
    };
  }
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    return { __type: "text", chars: value.length, preview: value.slice(0, maxChars), truncated: true };
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
      if (json.length <= maxChars) return JSON.parse(json);
      return { __type: "json", chars: json.length, preview: json.slice(0, maxChars), truncated: true };
    } catch {
      return String(value).slice(0, maxChars);
    }
  }
  return value;
}

export function cellText(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return "NULL";
  let text: string;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__type === "bytes") text = `<${String(record.bytes)} bytes>`;
    else if (record.__type === "text" || record.__type === "json") text = String(record.preview ?? "");
    else text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export interface ReadOnlyStatus {
  /** transaction = read-only transaction, grants = account privileges, service_only = AST guard only. */
  proof: ReadOnlyProof;
  /** Reported by the server at connect time; empty when the probe failed. */
  serverVersion: string;
  /** Degradations the operator must know about (weak read-only, engine mismatch, ...). */
  notes: string[];
}

export interface Engine {
  /** Set when the pinned connection cannot be reused; callers must open a new session. */
  readonly unavailableReason?: string;
  readonly kind: EngineKind;
  /** Declared capabilities of this engine; behaviour is driven by this table, not by the id. */
  readonly profile: EngineProfile;
  /** Whether cancellation can be delivered out of band. */
  readonly cancelSupported: boolean;
  /** How read-only access was proven for this connection plus anything degraded. */
  readOnlyStatus(): ReadOnlyStatus;
  /** Captured during connect, before any application timeout override. No source scan. */
  queryTimeoutStatus?(): ServerQueryTimeout;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Runs one guarded statement inside the pinned read-only transaction. */
  query(sql: string, limits: QueryLimits, sink: RowSink): Promise<QueryStats>;
  /** Runs a statement outside the read-only transaction. Only used for workspace DDL. */
  executeWorkspace(sql: string, timeoutMs: number): Promise<QueryStats>;
  beginReadOnly(): Promise<void>;
  endReadOnly(): Promise<void>;
  explain(sql: string, limits: QueryLimits, analyze?: boolean): Promise<ExplainResult>;
  listScopes(): Promise<string[]>;
  catalogTableCounts(scopes: string[]): Promise<Record<string, number>>;
  listObjects(filter: ObjectFilter): Promise<ObjectRef[]>;
  describeObject(schema: string | null, name: string): Promise<ObjectDescription>;
  profileObject(schema: string | null, name: string, sampleRows: number, timeoutMs: number, method?: "head" | "random"): Promise<ProfileResult>;
  /** True when a workspace object is writable by this account. */
  probeWorkspace(name: string, mode: "schema" | "database"): Promise<{ ok: boolean; note?: string }>;
  createView(workspace: string, name: string, selectSql: string): Promise<void>;
  createTable(workspace: string, name: string, selectSql: string): Promise<void>;
  dropDataset(workspace: string, name: string, kind: "view" | "table"): Promise<void>;
  listDatasets(workspace: string): Promise<DatasetObject[]>;
  cancel(): Promise<boolean>;
  quoteIdent(name: string): string;
  /** Engine default schema/database used when the model omits one. */
  defaultScope(): Promise<string>;
}

export function quoteAnsi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteBacktick(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function mapColumn(column: ColumnInfo): ColumnInfo {
  return column;
}

/**
 * Builds the sampling statement from the profile instead of hard-coding "LIMIT n" per engine.
 * `head` is the first N rows and is labelled as such to the caller; a profile that declares
 * `random` opts into a shuffled sample.
 */
export function sampleSql(profile: EngineProfile, schema: string, name: string, sampleRows: number, method = profile.sampling): string {
  const quote = profile.quote === '"' ? quoteAnsi : quoteBacktick;
  const relation = `${quote(schema)}.${quote(name)}`;
  const limit = Math.max(1, Math.min(500, sampleRows));
  if (method === "random") {
    return `SELECT * FROM ${relation} ORDER BY ${profile.dialect === "Postgresql" ? "RANDOM" : "RAND"}() LIMIT ${limit}`;
  }
  return `SELECT * FROM ${relation} LIMIT ${limit}`;
}
