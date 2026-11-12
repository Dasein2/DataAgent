import { z } from "zod";

export const EngineKind = z.enum(["postgres", "mysql", "doris", "starrocks"]);
export type EngineKind = z.infer<typeof EngineKind>;

export const SshAuth = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), password: z.string().min(1) }),
  z.object({
    method: z.literal("privateKey"),
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  }),
]);

export const SshHop = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: SshAuth,
  /** SHA256 base64 fingerprint of the host key, e.g. "SHA256:abc...". Required in production. */
  hostFingerprint: z.string().min(1).optional(),
});

export const SslConfig = z.object({
  mode: z.enum(["require", "verify-ca", "verify-full"]),
  /** PEM-encoded CA bundle. Required for verify-ca / verify-full. */
  ca: z.string().optional(),
  /** Override the name verified against the certificate. Defaults to `host`. */
  serverName: z.string().optional(),
});

export const WorkspaceConfig = z.object({
  /** Pre-created PostgreSQL schema or MySQL database owned by the analysis account. */
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/i, "workspace name must be a simple identifier"),
  mode: z.enum(["schema", "database"]).optional(),
});

export const ConnectionConfig = z.object({
  engine: EngineKind,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  ssl: SslConfig.optional(),
  ssh: z.object({ hops: z.array(SshHop).min(1).max(4) }).optional(),
  /** Fail-closed: undeclared connections are treated as production. */
  environment: z.enum(["production", "non_production"]).default("production"),
  /**
   * Engines without read-only transactions (Doris, StarRocks) prove read-only from the account's
   * grants. When the account does hold write privileges the session is refused unless the caller
   * explicitly accepts service-only enforcement here.
   */
  allowWeakReadOnly: z.boolean().default(false),
  workspace: WorkspaceConfig.optional(),
  label: z.string().max(120).optional(),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfig>;
export type SshHopConfig = z.infer<typeof SshHop>;

export type WorkspaceAccess = "none" | "views_only" | "tables_and_views";

export interface SessionCapabilities {
  engine: EngineKind;
  /** Human label plus declared capability flags for the engine this session uses. */
  engineLabel: string;
  engineProfile: Record<string, unknown>;
  environment: "production" | "non_production";
  /** Reported by the server at connect time; empty when the probe failed. */
  serverVersion: string;
  /**
   * How "source writes are refused" was proven for this connection:
   * transaction = read-only transaction, grants = account privileges, service_only = AST guard only.
   */
  readOnlyProof: "transaction" | "grants" | "service_only";
  /** Anything the operator should know: degraded capabilities, engine mismatch, weak read-only. */
  notes: string[];
  sourceAccess: "read_only";
  workspaceAccess: WorkspaceAccess;
  workspaceName?: string;
  workspaceMode?: "schema" | "database";
  /** Why the session was downgraded, if it was. */
  workspaceNote?: string;
  /** Features proven by the connection probe. */
  features: {
    cancel: boolean;
    explain: boolean;
    explainAnalyze: boolean;
    streaming: boolean;
  };
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  comment?: string | null;
  ordinal: number;
}

export interface ObjectRef {
  schema: string;
  name: string;
  kind: string;
  rowEstimate?: number | null;
  comment?: string | null;
}

export interface ObjectDescription {
  object: ObjectRef;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
  foreignKeys: Array<{ name: string; columns: string[]; references: string }>;
  views?: string[];
}

export interface ExplainResult {
  planText: string;
  estimatedCost?: number | null;
  estimatedRows?: number | null;
  warnings: string[];
}

export interface ProfileColumn {
  name: string;
  type: string;
  nulls: number;
  distinct: number | null;
  min?: unknown;
  max?: unknown;
  samples: unknown[];
}

export interface ProfileResult {
  object: { schema: string; name: string };
  rowCount: number | null;
  columns: ProfileColumn[];
  /** True when values were read from the source rather than catalog statistics alone. */
  sampled: boolean;
}
