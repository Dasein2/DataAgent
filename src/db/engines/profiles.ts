/**
 * Engine profiles: the single place where per-engine differences are declared.
 *
 * Borrowed from opskat (`pkg/dbdriver.Descriptor.Capabilities`, undeclared means unsupported,
 * missing capability is refused with ErrUnsupported) and dbx
 * (`database-drivers.manifest.json`, one declarative entry per engine, with drift tests that keep
 * the manifest authoritative).
 *
 * Rules of this file:
 *  - Every field must be consumed somewhere; `tests/profiles.test.ts` asserts the descriptor
 *    surface matches the declared key list so a flag cannot silently rot.
 *  - Missing capability defaults to "not supported" and is refused with FEATURE_UNSUPPORTED,
 *    never emulated by a silent fallback.
 *  - An engine is not identified by its wire protocol. MySQL and Doris share the MySQL protocol
 *    and share almost nothing else, which is exactly why this table exists.
 */

export type EngineId = "postgres" | "mysql" | "doris" | "starrocks";

/** Dialect names accepted by node-sql-parser. Anything else cannot be parsed, so it is refused. */
export type SqlDialect = "Postgresql" | "MySQL";

export type ReadOnlyProof = "transaction" | "grants" | "service_only";

export interface EngineProfile {
  id: EngineId;
  label: string;
  /** Wire protocol used to connect. */
  protocol: "pg" | "mysql";
  /** Parser dialect. Doris/StarRocks SELECT syntax is a MySQL subset. */
  dialect: SqlDialect;
  defaultPort: number;
  /** Identifier quote character. */
  quote: '"' | "`";
  /** A PostgreSQL schema, a separate MySQL-family database, or nothing. */
  workspaceMode: "schema" | "database";
  /** How "the source cannot be written" is proven at connect time. */
  readOnlyProof: "transaction" | "grants";
  explain: "json" | "text" | "none";
  /** Explicit EXPLAIN ANALYZE support (executes the statement for real). */
  explainAnalyze: boolean;
  secondaryIndexes: boolean;
  foreignKeys: boolean;
  rowEstimate: "table_rows" | "none";
  /** DDL can be rolled back in a transaction; false means create-then-register + cleanup. */
  transactionalDdl: boolean;
  cancel: "backend-pid" | "query-id" | "connection-id" | "none";
  /** Sample strategy for data_profile. "head" is the first N rows and is labelled as such. */
  sampling: "random" | "head";
  /** Server version fingerprints (regex sources, case-insensitive). */
  versionPatterns: string[];
}

export const ENGINE_PROFILES: Record<EngineId, EngineProfile> = {
  postgres: {
    id: "postgres",
    label: "PostgreSQL",
    protocol: "pg",
    dialect: "Postgresql",
    defaultPort: 5432,
    quote: '"',
    workspaceMode: "schema",
    readOnlyProof: "transaction",
    explain: "json",
    explainAnalyze: true,
    secondaryIndexes: true,
    foreignKeys: true,
    rowEstimate: "table_rows",
    transactionalDdl: true,
    cancel: "backend-pid",
    sampling: "head",
    versionPatterns: ["^postgresql", "^16\\.", "^15\\.", "^14\\.", "^13\\."],
  },
  mysql: {
    id: "mysql",
    label: "MySQL",
    protocol: "mysql",
    dialect: "MySQL",
    defaultPort: 3306,
    quote: "`",
    workspaceMode: "database",
    readOnlyProof: "transaction",
    explain: "json",
    explainAnalyze: false,
    secondaryIndexes: true,
    foreignKeys: true,
    rowEstimate: "table_rows",
    transactionalDdl: false,
    cancel: "query-id",
    sampling: "head",
    versionPatterns: ["^(?!5\\.7\\.99)(5\\.|8\\.|9\\.|mariadb)"],
  },
  // Doris and StarRocks speak the MySQL protocol but implement neither read-only transactions nor
  // MySQL's information_schema surface. Capabilities mirror dbx's manifest entries for both.
  doris: {
    id: "doris",
    label: "Apache Doris",
    protocol: "mysql",
    dialect: "MySQL",
    defaultPort: 9030,
    quote: "`",
    workspaceMode: "database",
    readOnlyProof: "grants",
    explain: "text",
    explainAnalyze: false,
    secondaryIndexes: false,
    foreignKeys: false,
    rowEstimate: "none",
    transactionalDdl: false,
    cancel: "connection-id",
    sampling: "head",
    versionPatterns: ["doris", "^5\\.7\\.99"],
  },
  starrocks: {
    id: "starrocks",
    label: "StarRocks",
    protocol: "mysql",
    dialect: "MySQL",
    defaultPort: 9030,
    quote: "`",
    workspaceMode: "database",
    readOnlyProof: "grants",
    // dbx declares no SQL explain support for StarRocks while it does for Doris; keep the
    // conservative value and let a live probe upgrade it later.
    explain: "none",
    explainAnalyze: false,
    secondaryIndexes: false,
    foreignKeys: false,
    rowEstimate: "none",
    transactionalDdl: false,
    cancel: "connection-id",
    sampling: "head",
    versionPatterns: ["starrocks", "^5\\.7\\.99"],
  },
};

export const ENGINE_IDS = Object.keys(ENGINE_PROFILES) as EngineId[];

export function getProfile(id: EngineId): EngineProfile {
  const profile = ENGINE_PROFILES[id];
  if (!profile) throw new Error(`Unknown database engine "${String(id)}"`);
  return profile;
}

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && value in ENGINE_PROFILES;
}

/** Every field the profile exposes; the drift test asserts this list matches the descriptor. */
export const PROFILE_FIELDS = [
  "id",
  "label",
  "protocol",
  "dialect",
  "defaultPort",
  "quote",
  "workspaceMode",
  "readOnlyProof",
  "explain",
  "explainAnalyze",
  "secondaryIndexes",
  "foreignKeys",
  "rowEstimate",
  "transactionalDdl",
  "cancel",
  "sampling",
  "versionPatterns",
] as const satisfies ReadonlyArray<keyof EngineProfile>;

export type EngineDescriptor = Record<(typeof PROFILE_FIELDS)[number], unknown>;

/** JSON-safe view of a profile: what `/v1/engines`, session capabilities and logs show. */
export function describeEngine(profile: EngineProfile): EngineDescriptor {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    dialect: profile.dialect,
    defaultPort: profile.defaultPort,
    quote: profile.quote,
    workspaceMode: profile.workspaceMode,
    readOnlyProof: profile.readOnlyProof,
    explain: profile.explain,
    explainAnalyze: profile.explainAnalyze,
    secondaryIndexes: profile.secondaryIndexes,
    foreignKeys: profile.foreignKeys,
    rowEstimate: profile.rowEstimate,
    transactionalDdl: profile.transactionalDdl,
    cancel: profile.cancel,
    sampling: profile.sampling,
    versionPatterns: [...profile.versionPatterns],
  };
}

/** Engines whose version fingerprints match the reported server version. */
export function detectEnginesFromVersion(version: string): EngineId[] {
  if (!version) return [];
  return ENGINE_IDS.filter((id) =>
    ENGINE_PROFILES[id].versionPatterns.some((pattern) => new RegExp(pattern, "i").test(version)),
  );
}

/**
 * Warns when the server did not look like the declared engine. A wrong declaration is not fatal
 * (the declared profile is what the operator asked for) but the mismatch must be visible.
 */
export function versionMismatchNote(declared: EngineId, version: string): string | undefined {
  const matches = detectEnginesFromVersion(version);
  if (matches.length === 0 || matches.includes(declared)) return undefined;
  return `Server reports version "${version}", which looks like ${matches.join("/")}, but the connection declares "${declared}". Capabilities follow the declared engine.`;
}
