import pg from "pg";
import QueryStream from "pg-query-stream";
import { parseServerQueryTimeout, type ServerQueryTimeout } from "../query-timeout.js";
import type {
  ColumnInfo,
  ConnectionConfig,
  ExplainResult,
  ObjectDescription,
  ObjectRef,
  ProfileColumn,
  ProfileResult,
} from "../types.js";
import { SshTunnel } from "../ssh-tunnel.js";
import {
  attachColumnMatches,
  CATALOG_TABLE_KINDS,
  tableCountsByScope,
  catalogLimit,
  catalogMatch,
  CATALOG_MATCHES,
  cellText,
  quoteAnsi,
  sampleSql,
  serializeValue,
  type ColumnMeta,
  type DatasetObject,
  type Engine,
  type ObjectFilter,
  type QueryLimits,
  type QueryStats,
  type ReadOnlyStatus,
  type RowSink,
} from "./base.js";
import { getProfile, versionMismatchNote, type EngineProfile } from "./profiles.js";

const { Client } = pg;

const DATASET_MARKER = "dwa:dataset";

interface FieldDescription {
  name: string;
  dataTypeID: number;
}

/** Sum scan-node estimates, not root aggregate output cardinality. Planner estimates are advisory. */
function estimateScans(node: Record<string, unknown>): number {
  const own = /Scan/.test(String(node["Node Type"])) ? Number(node["Plan Rows"] ?? 0) : 0;
  return own + (Array.isArray(node.Plans) ? node.Plans.reduce((n: number, child: Record<string, unknown>) => n + estimateScans(child), 0) : 0);
}

export class PostgresEngine implements Engine {
  readonly kind = "postgres" as const;
  readonly profile: EngineProfile;
  private client?: pg.Client;
  private tunnel?: SshTunnel;
  private typeNames = new Map<number, string>();
  private serverVersion = 0;
  private versionText = "";
  private readonly notes: string[] = [];
  private serverTimeout: ServerQueryTimeout = { status: "unavailable", variable: "statement_timeout" };
  /** Backend PID captured while the connection is idle; needed to cancel a running query. */
  private backendPid = 0;
  /**
   * Mirrors the old "session is in read-only mode" flag. No transaction is held between statements
   * any more: each query opens its own `START TRANSACTION READ ONLY`, so an idle session no longer
   * pins xmin and blocks vacuum on a busy primary.
   */
  private inReadOnly = false;
  private closed = false;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly options: { applicationName: string },
  ) {
    this.profile = getProfile(config.engine);
  }

  get cancelSupported(): boolean {
    return this.profile.cancel !== "none";
  }

  readOnlyStatus(): ReadOnlyStatus {
    return { proof: "transaction", serverVersion: this.versionText, notes: [...this.notes] };
  }

  queryTimeoutStatus(): ServerQueryTimeout {
    return { ...this.serverTimeout };
  }

  quoteIdent(name: string): string {
    return quoteAnsi(name);
  }

  private connectionOptions(stream?: NodeJS.ReadWriteStream) {
    const ssl = this.config.ssl;
    const sslConfig = ssl
      ? {
          rejectUnauthorized: ssl.mode !== "require",
          ca: ssl.ca,
          servername: ssl.serverName ?? this.config.host,
        }
      : undefined;
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: sslConfig,
      stream: stream as never,
      application_name: this.options.applicationName,
      connectionTimeoutMillis: 20_000,
      keepAlive: true,
      types: {
        getTypeParser: (oid: number, format?: "text" | "binary") => {
          // int8 / numeric: keep exact precision as strings.
          if (oid === 20 || oid === 1700) return (value: string) => value;
          return pg.types.getTypeParser(oid, format ?? "text");
        },
      },
    } satisfies pg.ClientConfig;
  }

  private async newClient(stream?: NodeJS.ReadWriteStream): Promise<pg.Client> {
    const client = new Client(this.connectionOptions(stream));
    await client.connect();
    return client;
  }

  async connect(): Promise<void> {
    let stream: NodeJS.ReadWriteStream | undefined;
    if (this.config.ssh) {
      this.tunnel = new SshTunnel(this.config.ssh.hops);
      stream = await this.tunnel.open({ host: this.config.host, port: this.config.port });
    }
    this.client = await this.newClient(stream);
    const types = await this.rawQuery("select oid::int as oid, typname from pg_type");
    for (const row of types as unknown as Array<[number, string]>) this.typeNames.set(row[0], row[1]);
    const pidRow = await this.rawQuery("SELECT pg_backend_pid()");
    this.backendPid = Number((pidRow as unknown as Array<[number]>) [0]?.[0] ?? 0) || 0;
    const version = await this.rawQuery("SHOW server_version_num");
    this.serverVersion = Number((version as unknown as Array<[string]>) [0]?.[0] ?? 0) || 0;
    const versionText = await this.rawQuery("SHOW server_version");
    this.versionText = String((versionText as unknown as Array<[string]>) [0]?.[0] ?? "");
    const mismatch = versionMismatchNote(this.profile.id, this.versionText);
    if (mismatch) this.notes.push(mismatch);
    try {
      const probe = { text: "SHOW statement_timeout", query_timeout: 5_000 };
      const result = await this.client.query(probe);
      this.serverTimeout = parseServerQueryTimeout("postgres", result.rows[0]?.statement_timeout);
    } catch {
      // Missing permission/unsupported setting: policy falls back without leaking error details.
    }
    // Keep the role/session limit intact. Per-statement SET LOCAL uses the resolved policy.
    await this.beginReadOnly();
  }

  async beginReadOnly(): Promise<void> {
    if (!this.client) throw new Error("PostgreSQL connection is not open");
    // Nothing to open: read-only mode is enforced per statement in `readOnlyTransaction()`.
    this.inReadOnly = true;
  }

  async endReadOnly(): Promise<void> {
    this.inReadOnly = false;
  }

  /**
   * Runs `fn` inside `START TRANSACTION READ ONLY`, committing on success and rolling back on any
   * failure. Short transactions are what keep the read-only proof without holding a snapshot open
   * for the whole session (which blocked vacuum and made one cancelled query poison every later one).
   */
  private async readOnlyTransaction<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = this.assertOpen();
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.endReadOnly();
      await this.client?.end();
    } catch {
      /* ignore close errors */
    }
    await this.tunnel?.close();
  }

  /** row-mode query returning arrays; typed through a narrow cast because pg's types omit rowMode. */
  private async rawQuery(sql: string): Promise<unknown[][]> {
    const client = this.assertOpen();
    const result = (await (client.query as unknown as (config: unknown) => Promise<{ rows: unknown[][] }>)({
      text: sql,
      values: [],
      rowMode: "array",
    })) as { rows: unknown[][] };
    return result.rows;
  }

  private assertOpen(): pg.Client {
    if (!this.client || this.closed) throw new Error("PostgreSQL connection is not open");
    return this.client;
  }

  private statementTimeoutMs(requested: number): number {
    return Math.max(1, Math.floor(Math.min(requested, this.serverTimeout.status === "detected" ? this.serverTimeout.timeoutMs! : Infinity)));
  }

  private async buffered(sql: string, timeoutMs: number): Promise<{ fields: ColumnMeta[]; rows: unknown[][] }> {
    const raw = await this.readOnlyTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs(timeoutMs)}`);
      return (await client.query({ text: sql, values: [], rowMode: "array" })) as unknown as {
        fields?: FieldDescription[];
        rows: unknown[][];
      };
    });
    const fields = (raw.fields ?? []).map((field) => ({
      name: field.name,
      type: this.typeNames.get(field.dataTypeID) ?? `oid_${field.dataTypeID}`,
    }));
    return { fields, rows: raw.rows ?? [] };
  }

  async query(sql: string, limits: QueryLimits, sink: RowSink): Promise<QueryStats> {
    const client = this.assertOpen();
    if (!this.inReadOnly) await this.beginReadOnly();
    await client.query("BEGIN TRANSACTION READ ONLY");
    const started = Date.now();
    try {
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs(limits.timeoutMs)}`);
      return await this.streamRows(client, sql, limits, sink, started);
    } finally {
      // A read-only transaction has nothing to persist, so ROLLBACK is equivalent to COMMIT — and it
      // is safe even when the cursor was destroyed mid-stream or the statement was cancelled.
      await client.query("ROLLBACK").catch(() => undefined);
    }
  }

  private async streamRows(
    client: pg.Client,
    sql: string,
    limits: QueryLimits,
    sink: RowSink,
    started: number,
  ): Promise<QueryStats> {
    const stream = client.query(
      new QueryStream(sql, [], { batchSize: 200, rowMode: "array" }) as never,
    ) as unknown as AsyncIterable<unknown[]> & { destroy: (error?: Error) => void; _result?: { fields?: FieldDescription[] } };

    const columns: ColumnMeta[] = [];
    let rowCount = 0;
    let bytes = 0;
    let truncated: QueryStats["truncated"] = "none";
    let columnsSent = false;

    const cancelOnAbort = () => stream.destroy(new Error("Query aborted"));
    limits.signal?.addEventListener("abort", cancelOnAbort, { once: true });

    try {
      for await (const rawRow of stream) {
        if (!columnsSent) {
          const fields = stream._result?.fields ?? [];
          for (const field of fields) {
            columns.push({
              name: field.name,
              type: this.typeNames.get(field.dataTypeID) ?? `oid_${field.dataTypeID}`,
            });
          }
          sink.onColumns?.(columns);
          columnsSent = true;
        }
        const row = rawRow.map((value) => serializeValue(value, limits.maxCellChars));
        bytes += JSON.stringify(row).length;
        if (rowCount >= limits.maxRows) {
          truncated = "rows";
          break;
        }
        if (bytes > limits.maxBytes) {
          truncated = "bytes";
          break;
        }
        await sink.onRow(row);
        rowCount += 1;
      }
      if (truncated !== "none") {
        stream.destroy();
        // Give the cursor a moment to close the portal before the next statement.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      limits.signal?.removeEventListener("abort", cancelOnAbort);
    }

    if (!columnsSent) {
      sink.onColumns?.(columns);
    }

    return {
      columns,
      rowCount,
      bytes,
      durationMs: Date.now() - started,
      truncated,
      warnings: truncated === "rows" ? [`Result exceeded ${limits.maxRows} rows and was truncated.`] : [],
    };
  }

  async executeWorkspace(sql: string, timeoutMs: number): Promise<QueryStats> {
    const client = this.assertOpen();
    const started = Date.now();
    // Workspace DDL must commit, so it needs its own read-write transaction instead of the old
    // "roll back the pinned transaction, run, re-open it" dance.
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      await client.query(sql);
      await client.query("COMMIT");
      return { columns: [], rowCount: 0, bytes: 0, durationMs: Date.now() - started, truncated: "none", warnings: [] };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async explain(sql: string, limits: QueryLimits, analyze = false): Promise<ExplainResult> {
    const { rows } = await this.buffered(`EXPLAIN (FORMAT JSON, VERBOSE false${analyze ? ", ANALYZE true, BUFFERS true" : ""}) ${sql}`, limits.timeoutMs);
    const plan = (rows[0]?.[0] as Array<{ Plan?: Record<string, unknown> }> | undefined)?.[0]?.Plan;
    return {
      planText: JSON.stringify(plan ?? rows.map((row) => row[0]), null, 2),
      estimatedCost: typeof plan?.["Total Cost"] === "number" ? (plan["Total Cost"] as number) : null,
      estimatedRows: typeof plan?.["Plan Rows"] === "number" ? (plan["Plan Rows"] as number) : null,
      estimatedScanRows: plan ? estimateScans(plan) : null,
      analyzed: analyze,
      warnings: plan ? [] : ["PostgreSQL did not return a JSON plan"],
    };
  }

  // pg_catalog exposes metadata even without SELECT. Use the same read-access rule
  // for directory entries and direct object details.
  private readableObject() {
    return `has_schema_privilege(n.oid, 'USAGE') AND CASE
      WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'SELECT')
      ELSE has_table_privilege(c.oid, 'SELECT') END`;
  }

  async listScopes(): Promise<string[]> {
    const { rows } = await this.buffered(
      `SELECT nspname FROM pg_namespace
       WHERE left(nspname, 3) <> 'pg_' AND nspname <> 'information_schema'
         AND has_schema_privilege(oid, 'USAGE') ORDER BY 1`,
      15_000,
    );
    return rows.map((row) => String(row[0]));
  }

  private catalogObjectKind() {
    return `CASE c.relkind
      WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
      WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' END`;
  }

  private catalogVisibility(scopes?: string[]) {
    return `c.relkind IN ('r','p','v','m','f','S') AND ${this.readableObject()}
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ${scopes ? `AND n.nspname IN (${scopes.map((scope) => this.literal(scope)).join(",")})` : ""}`;
  }

  async catalogTableCounts(scopes: string[]) {
    if (!scopes.length) return {};
    const kinds = CATALOG_TABLE_KINDS.map((kind) => this.literal(kind)).join(",");
    const { rows } = await this.buffered(
      `SELECT n.nspname, COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${this.catalogVisibility(scopes)} AND ${this.catalogObjectKind()} IN (${kinds})
       GROUP BY n.nspname`,
      20_000,
    );
    return tableCountsByScope(scopes, rows);
  }

  async listObjects(filter: ObjectFilter): Promise<ObjectRef[]> {
    if (filter.scopes?.length === 0 || filter.kinds?.length === 0) return [];
    const contains = (field: string) => `strpos(lower(${field}), lower(${this.literal(filter.search ?? null)}::text)) > 0`;
    const matchesColumn = `(${contains("a.attname")} OR ${contains("col_description(c.oid, a.attnum)")})`;
    const match = catalogMatch(filter, contains("c.relname"), contains("n.nspname"), contains("obj_description(c.oid, 'pg_class')"),
      `EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND ${matchesColumn})`);
    const { rows } = await this.buffered(
      `SELECT * FROM (
        SELECT n.nspname AS schema, c.relname AS name, ${this.catalogObjectKind()} AS kind,
               CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS row_estimate,
               obj_description(c.oid, 'pg_class') AS comment, ${match.rank} AS match_rank
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${this.catalogVisibility(filter.scopes)}
          ${filter.schema === undefined ? "" : `AND n.nspname = ${this.literal(filter.schema)}`}
          ${match.where}
      ) catalog
      ${filter.kinds ? `WHERE kind IN (${filter.kinds.map((value) => this.literal(value)).join(",")})` : ""}
      ORDER BY match_rank, schema, name ${catalogLimit(filter)}`,
      20_000,
    );
    const objects: ObjectRef[] = rows.map((row) => ({
      schema: String(row[0]), name: String(row[1]), kind: String(row[2]),
      rowEstimate: row[3] == null ? null : Number(row[3]),
      comment: row[4] == null ? null : String(row[4]),
      match: CATALOG_MATCHES[Number(row[5]) - 1],
    }));
    const matched = filter.includeMatchDetails ? objects.filter((object) => object.match === "column") : [];
    if (matched.length) {
      const { rows: columns } = await this.buffered(
        `SELECT n.nspname, c.relname, MIN(a.attname::text), COUNT(*)
         FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE a.attnum > 0 AND NOT a.attisdropped AND ${matchesColumn}
           AND c.relkind IN ('r','p','v','m','f','S') AND ${this.readableObject()}
           AND (n.nspname, c.relname) IN (${matched.map((o) => `(${this.literal(o.schema)},${this.literal(o.name)})`).join(",")})
         GROUP BY n.nspname, c.relname`,
        20_000,
      );
      attachColumnMatches(objects, columns);
    }
    return objects;
  }

  private literal(value: string | null): string {
    if (value === null) return "NULL";
    return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }

  async describeObject(schema: string | null, name: string): Promise<ObjectDescription> {
    const scope = schema ?? (await this.defaultScope());
    const { rows: objectRows } = await this.buffered(
      `SELECT c.oid::bigint, c.relkind::text, obj_description(c.oid, 'pg_class'),
              CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${this.literal(scope)} AND c.relname = ${this.literal(name)}
         AND c.relkind IN ('r','p','v','m','f','S') AND ${this.readableObject()}`,
      15_000,
    );
    if (objectRows.length === 0) throw new Error(`Object ${scope}.${name} was not found or is not accessible`);
    const [oid, relkind, comment, estimate] = objectRows[0]!;

    const { rows: columnRows } = await this.buffered(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              col_description(a.attrelid, a.attnum) AS comment,
              a.attnum
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ${String(oid)} AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      15_000,
    );
    const columns: ColumnInfo[] = columnRows.map((row, index) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: Boolean(row[2]),
      default: row[3] === null || row[3] === undefined ? null : String(row[3]),
      comment: row[4] === null || row[4] === undefined ? null : String(row[4]),
      ordinal: Number(row[5] ?? index + 1),
    }));

    const { rows: indexRows } = await this.buffered(
      `SELECT i.relname, ix.indisprimary, ix.indisunique,
              array_to_string(ARRAY(
                SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                ORDER BY k.ord), ',')
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE ix.indrelid = ${String(oid)}
       ORDER BY ix.indisprimary DESC, i.relname`,
      15_000,
    );

    const { rows: fkRows } = await this.buffered(
      `SELECT con.conname,
              array_to_string(ARRAY(
                SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ORDER BY k.ord), ','),
              rn.nspname || '.' || rc.relname,
              array_to_string(ARRAY(
                SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                ORDER BY k.ord), ',')
       FROM pg_constraint con
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       WHERE con.conrelid = ${String(oid)} AND con.contype = 'f'
       ORDER BY con.conname`,
      15_000,
    );

    let partitionKey: string | null = null;
    if (relkind === "p") { const { rows } = await this.buffered(`SELECT pg_get_partkeydef(${String(oid)}::oid)`, 5000); partitionKey = rows[0]?.[0] ? String(rows[0][0]) : null; }
    const primaryKey = indexRows.filter((row) => Boolean(row[1])).flatMap((row) => String(row[3] ?? "").split(",").filter(Boolean));

    return {
      object: {
        schema: scope,
        name,
        kind:
          relkind === "v" ? "view" : relkind === "m" ? "materialized_view" : relkind === "f" ? "foreign_table" : relkind === "S" ? "sequence" : "table",
        rowEstimate: estimate === null || estimate === undefined ? null : Number(estimate),
        comment: comment ? String(comment) : null,
      },
      columns,
      partitionKey,
      primaryKey,
      indexes: indexRows.map((row) => ({
        name: String(row[0]),
        columns: String(row[3] ?? "").split(",").filter(Boolean),
        unique: Boolean(row[2]),
      })),
      foreignKeys: fkRows.map((row) => ({
        name: String(row[0]),
        columns: String(row[1] ?? "").split(",").filter(Boolean),
        references: String(row[2]),
        referencedColumns: String(row[3] ?? "").split(",").filter(Boolean),
      })),
    };
  }

  async profileObject(schema: string | null, name: string, sampleRows: number, timeoutMs: number, method: "head" | "random" = this.profile.sampling): Promise<ProfileResult> {
    const scope = schema ?? (await this.defaultScope());
    const described = await this.describeObject(scope, name);
    const { fields, rows } = await this.buffered(sampleSql(this.profile, scope, name, sampleRows, method), timeoutMs);

    const columns: ProfileColumn[] = fields.map((field, index) => {
      const values = rows.map((row) => row[index]);
      const nonNull = values.filter((value) => value !== null && value !== undefined);
      const distinct = new Set(nonNull.map((value) => cellText(serializeValue(value, 200), 200)));
      const comparable = nonNull
        .map((value) => (typeof value === "number" || typeof value === "bigint" ? Number(value) : value instanceof Date ? value.getTime() : null))
        .filter((value): value is number => value !== null);
      const min = comparable.length ? Math.min(...comparable) : undefined;
      const max = comparable.length ? Math.max(...comparable) : undefined;
      return {
        name: field.name,
        type: described.columns[index]?.type ?? field.type,
        nulls: values.length - nonNull.length,
        distinct: distinct.size,
        min,
        max,
        samples: nonNull.slice(0, 5).map((value) => serializeValue(value, 200)),
      };
    });

    return {
      object: { schema: scope, name },
      rowCount: described.object.rowEstimate ?? null,
      columns,
      sampled: rows.length > 0,
      sampleMethod: method,
      sampleRows: rows.length,
      warnings: ["Sample statistics are not full-table statistics; head samples are not random or representative."],
    };
  }

  async probeWorkspace(name: string, mode: "schema" | "database"): Promise<{ ok: boolean; note?: string }> {
    if (mode === "database") {
      return { ok: false, note: "PostgreSQL workspaces use a schema, not a database" };
    }
    const probe = `${quoteAnsi(name)}.__dwa_probe_${Date.now()}`;
    try {
      await this.executeWorkspace(`CREATE VIEW ${probe} AS SELECT 1 AS ok`, 15_000);
      await this.executeWorkspace(`DROP VIEW ${probe}`, 15_000);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        note: `Cannot create objects in schema "${name}": ${(error as Error).message}`,
      };
    }
  }

  async createView(workspace: string, name: string, selectSql: string): Promise<void> {
    const target = `${quoteAnsi(workspace)}.${quoteAnsi(name)}`;
    // security_invoker requires PostgreSQL 15+; below that the view runs as its owner, which is the
    // analysis account itself, so row access is unchanged for single-account deployments.
    const security = this.serverVersion >= 150_000 ? " WITH (security_invoker = true)" : "";
    await this.executeWorkspace(`CREATE VIEW ${target}${security} AS\n${selectSql}`, 120_000);
    await this.executeWorkspace(`COMMENT ON VIEW ${target} IS '${DATASET_MARKER}'`, 15_000);
  }

  async createTable(workspace: string, name: string, selectSql: string): Promise<void> {
    const target = `${quoteAnsi(workspace)}.${quoteAnsi(name)}`;
    await this.executeWorkspace(`CREATE TABLE ${target} AS\n${selectSql}`, 120_000);
    await this.executeWorkspace(`COMMENT ON TABLE ${target} IS '${DATASET_MARKER}'`, 15_000);
  }

  async dropDataset(workspace: string, name: string, kind: "view" | "table"): Promise<void> {
    const target = `${quoteAnsi(workspace)}.${quoteAnsi(name)}`;
    await this.executeWorkspace(kind === "view" ? `DROP VIEW ${target}` : `DROP TABLE ${target}`, 30_000);
  }

  async listDatasets(workspace: string): Promise<DatasetObject[]> {
    const { rows } = await this.buffered(
      `SELECT c.relname, c.relkind::text, obj_description(c.oid, 'pg_class')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${this.literal(workspace)}
         AND c.relkind IN ('v','m','r','p')
         AND obj_description(c.oid, 'pg_class') = '${DATASET_MARKER}'
       ORDER BY c.relname`,
      15_000,
    );
    return rows.map((row) => ({
      name: String(row[0]),
      kind: row[1] === "v" || row[1] === "m" ? "view" : "table",
      definition: null,
      createdAt: null,
    }));
  }

  async defaultScope(): Promise<string> {
    const { rows } = await this.buffered("SELECT current_schema()", 10_000);
    return String(rows[0]?.[0] ?? "public");
  }

  async cancel(): Promise<boolean> {
    if (!this.client) return false;
    // The pid is cached at connect time: asking the main client while it is streaming a query would
    // queue behind that query and only run after it finished, which defeats cancellation.
    const pid = this.backendPid;
    if (!pid) return false;
    let control: pg.Client | undefined;
    try {
      const stream = this.tunnel ? await this.tunnel.dial({ host: this.config.host, port: this.config.port }) : undefined;
      control = await this.newClient(stream);
      const rows = await (control.query as unknown as (config: unknown) => Promise<{ rows: unknown[][] }>)({
        text: "SELECT pg_cancel_backend($1) AS cancelled",
        values: [pid],
        rowMode: "array",
      });
      return Boolean((rows.rows[0] as unknown as [boolean])?.[0]);
    } catch {
      return false;
    } finally {
      await control?.end().catch(() => undefined);
    }
  }
}
