import pg from "pg";
import QueryStream from "pg-query-stream";
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

export class PostgresEngine implements Engine {
  readonly kind = "postgres" as const;
  readonly profile: EngineProfile;
  private client?: pg.Client;
  private tunnel?: SshTunnel;
  private typeNames = new Map<number, string>();
  private serverVersion = 0;
  private versionText = "";
  private readonly notes: string[] = [];
  /** Backend PID captured while the connection is idle; needed to cancel a running query. */
  private backendPid = 0;
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
    await this.client.query("SET statement_timeout = 0");
    await this.beginReadOnly();
  }

  async beginReadOnly(): Promise<void> {
    if (!this.client) throw new Error("PostgreSQL connection is not open");
    await this.client.query("BEGIN TRANSACTION READ ONLY");
    this.inReadOnly = true;
  }

  async endReadOnly(): Promise<void> {
    if (!this.client || !this.inReadOnly) return;
    await this.client.query("ROLLBACK").catch(() => undefined);
    this.inReadOnly = false;
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

  /**
   * A failed or cancelled statement aborts the pinned read-only transaction, after which every
   * statement fails with "current transaction is aborted". Roll back and re-open it so one bad
   * query does not poison the session.
   */
  private async recoverTransaction(): Promise<void> {
    if (!this.client || this.closed) return;
    await this.client.query("ROLLBACK").catch(() => undefined);
    this.inReadOnly = false;
    await this.beginReadOnly().catch(() => undefined);
  }

  private async buffered(sql: string, timeoutMs: number): Promise<{ fields: ColumnMeta[]; rows: unknown[][] }> {
    const client = this.assertOpen();
    if (this.inReadOnly) {
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    }
    let result: unknown;
    try {
      result = await client.query({ text: sql, values: [], rowMode: "array" });
    } catch (error) {
      if (this.inReadOnly) await this.recoverTransaction();
      throw error;
    }
    const raw = result as unknown as {
      fields?: FieldDescription[];
      rows: unknown[][];
    };
    const fields = (raw.fields ?? []).map((field) => ({
      name: field.name,
      type: this.typeNames.get(field.dataTypeID) ?? `oid_${field.dataTypeID}`,
    }));
    return { fields, rows: raw.rows ?? [] };
  }

  async query(sql: string, limits: QueryLimits, sink: RowSink): Promise<QueryStats> {
    const client = this.assertOpen();
    if (!this.inReadOnly) await this.beginReadOnly();
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`);

    const started = Date.now();
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
    } catch (error) {
      // Aborted/cancelled/failed statements abort the transaction; recover before the next one.
      await this.recoverTransaction();
      throw error;
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
    await this.endReadOnly();
    const started = Date.now();
    try {
      await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      await client.query(sql);
      return { columns: [], rowCount: 0, bytes: 0, durationMs: Date.now() - started, truncated: "none", warnings: [] };
    } finally {
      await this.beginReadOnly().catch(() => undefined);
    }
  }

  async explain(sql: string, limits: QueryLimits): Promise<ExplainResult> {
    const { rows } = await this.buffered(`EXPLAIN (FORMAT JSON, VERBOSE false) ${sql}`, limits.timeoutMs);
    const plan = (rows[0]?.[0] as Array<{ Plan?: Record<string, unknown> }> | undefined)?.[0]?.Plan;
    return {
      planText: JSON.stringify(plan ?? rows.map((row) => row[0]), null, 2),
      estimatedCost: typeof plan?.["Total Cost"] === "number" ? (plan["Total Cost"] as number) : null,
      estimatedRows: typeof plan?.["Plan Rows"] === "number" ? (plan["Plan Rows"] as number) : null,
      warnings: plan ? [] : ["PostgreSQL did not return a JSON plan"],
    };
  }

  async listScopes(): Promise<string[]> {
    const { rows } = await this.buffered(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1`,
      15_000,
    );
    return rows.map((row) => String(row[0]));
  }

  async listObjects(filter: ObjectFilter): Promise<ObjectRef[]> {
    const { rows } = await this.buffered(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              CASE c.relkind
                WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
                WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence'
                ELSE c.relkind::text END AS kind,
              CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS row_estimate,
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f','S')
         AND n.nspname NOT IN ('pg_catalog','information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp%'
         AND (${this.literal(filter.search ?? null)}::text IS NULL
              OR c.relname ILIKE '%' || ${this.literal(filter.search ?? null)} || '%'
              OR n.nspname ILIKE '%' || ${this.literal(filter.search ?? null)} || '%')
         AND (${this.literal(filter.schema ?? null)}::text IS NULL OR n.nspname = ${this.literal(filter.schema ?? null)})
       ORDER BY 1, 2
       LIMIT ${Math.max(1, Math.min(2_000, filter.limit))}`,
      20_000,
    );
    const kinds = filter.kinds ? new Set<string>(filter.kinds) : undefined;
    return rows
      .map((row) => ({
        schema: String(row[0]),
        name: String(row[1]),
        kind: String(row[2]),
        rowEstimate: row[3] === null || row[3] === undefined ? null : Number(row[3]),
        comment: row[4] === null || row[4] === undefined ? null : String(row[4]),
      }))
      .filter((object) => !kinds || kinds.has(object.kind));
  }

  private literal(value: string | null): string {
    if (value === null) return "NULL";
    return `'${value.replace(/'/g, "''")}'`;
  }

  async describeObject(schema: string | null, name: string): Promise<ObjectDescription> {
    const scope = schema ?? (await this.defaultScope());
    const { rows: objectRows } = await this.buffered(
      `SELECT c.oid::bigint, c.relkind::text, obj_description(c.oid, 'pg_class'),
              CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${this.literal(scope)} AND c.relname = ${this.literal(name)}`,
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
              rn.nspname || '.' || rc.relname
       FROM pg_constraint con
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       WHERE con.conrelid = ${String(oid)} AND con.contype = 'f'
       ORDER BY con.conname`,
      15_000,
    );

    const primaryKey = indexRows.filter((row) => Boolean(row[1])).flatMap((row) => String(row[2] ?? "").split(",").filter(Boolean));

    return {
      object: {
        schema: scope,
        name,
        kind:
          relkind === "v" ? "view" : relkind === "m" ? "materialized_view" : relkind === "f" ? "foreign_table" : "table",
        rowEstimate: estimate === null || estimate === undefined ? null : Number(estimate),
        comment: comment ? String(comment) : null,
      },
      columns,
      primaryKey,
      indexes: indexRows.map((row) => ({
        name: String(row[0]),
        columns: String(row[2] ?? "").split(",").filter(Boolean),
        unique: Boolean(row[3]),
      })),
      foreignKeys: fkRows.map((row) => ({
        name: String(row[0]),
        columns: String(row[1] ?? "").split(",").filter(Boolean),
        references: String(row[2]),
      })),
    };
  }

  async profileObject(schema: string | null, name: string, sampleRows: number, timeoutMs: number): Promise<ProfileResult> {
    const scope = schema ?? (await this.defaultScope());
    const described = await this.describeObject(scope, name);
    const { fields, rows } = await this.buffered(sampleSql(this.profile, scope, name, sampleRows), 15_000 + timeoutMs);

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
