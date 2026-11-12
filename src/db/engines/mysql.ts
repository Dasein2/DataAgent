import mysql, { type Connection, type FieldPacket } from "mysql2";
import { AppError } from "../../errors.js";
import type {
  ColumnInfo,
  ConnectionConfig,
  EngineKind,
  ExplainResult,
  ObjectDescription,
  ObjectRef,
  ProfileColumn,
  ProfileResult,
} from "../types.js";
import { SshTunnel } from "../ssh-tunnel.js";
import { analyzeGrants, summarizeWrites } from "../grants.js";
import {
  cellText,
  quoteBacktick,
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
import { getProfile, versionMismatchNote, type EngineProfile, type ReadOnlyProof } from "./profiles.js";

const TYPE_NAMES = new Map<number, string>(
  Object.entries(mysql.Types as unknown as Record<string, number>).map(([name, id]) => [id, name]),
);

const DATASET_MARKER = "dwa:dataset";

export class MysqlEngine implements Engine {
  /** Overridden by the Doris/StarRocks subclasses; the wire protocol is shared. */
  readonly kind: EngineKind = "mysql";
  readonly profile: EngineProfile;
  private connection?: Connection;
  private tunnel?: SshTunnel;
  private inReadOnly = false;
  private closed = false;
  private proof: ReadOnlyProof;
  private serverVersion = "";
  private readonly notes: string[] = [];
  private grantsChecked = false;
  /** MySQL-only DDL fragments; Doris/StarRocks reject them. */
  protected readonly viewSecurity: string = " SQL SECURITY INVOKER";
  protected readonly tableMarkerComment: boolean = true;

  constructor(private readonly config: ConnectionConfig) {
    this.profile = getProfile(config.engine);
    this.proof = this.profile.readOnlyProof;
  }

  get cancelSupported(): boolean {
    return this.profile.cancel !== "none";
  }

  readOnlyStatus(): ReadOnlyStatus {
    return { proof: this.proof, serverVersion: this.serverVersion, notes: [...this.notes] };
  }

  quoteIdent(name: string): string {
    return quoteBacktick(name);
  }

  private connectionOptions(stream?: NodeJS.ReadWriteStream) {
    const ssl = this.config.ssl;
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      stream: stream as never,
      connectTimeout: 20_000,
      // Keep exact values: no timezone conversion, no float rounding, no silent truncation.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
      rowsAsArray: true,
      ssl: ssl
        ? {
            rejectUnauthorized: ssl.mode !== "require",
            ca: ssl.ca,
            servername: ssl.serverName ?? this.config.host,
            minVersion: "TLSv1.2",
          }
        : undefined,
    };
  }

  private async newConnection(stream?: NodeJS.ReadWriteStream): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const connection = mysql.createConnection(this.connectionOptions(stream));
      connection.once("error", reject);
      connection.once("connect", () => {
        connection.removeListener("error", reject);
        connection.on("error", () => {
          /* surfaced by individual statements; the session queue re-checks health */
        });
        resolve(connection);
      });
    });
  }

  async connect(): Promise<void> {
    let stream: NodeJS.ReadWriteStream | undefined;
    if (this.config.ssh) {
      this.tunnel = new SshTunnel(this.config.ssh.hops);
      stream = await this.tunnel.open({ host: this.config.host, port: this.config.port });
    }
    this.connection = await this.newConnection(stream);
    await this.probeVersion();
    await this.beginReadOnly();
  }

  private async probeVersion(): Promise<void> {
    try {
      const { rows } = await this.buffered("SELECT VERSION()", 15_000);
      this.serverVersion = String(rows[0]?.[0] ?? "");
    } catch (error) {
      this.notes.push(`Could not read the server version: ${(error as Error).message}`);
      return;
    }
    const mismatch = versionMismatchNote(this.profile.id, this.serverVersion);
    if (mismatch) this.notes.push(mismatch);
  }

  /**
   * Read-only setup, driven by the profile:
   *  - `transaction`: MySQL's START TRANSACTION READ ONLY holds the whole pinned connection read-only.
   *  - `grants`: Doris/StarRocks have no read-only transaction, so the account's own privileges are
   *    the only hard guarantee. Fail closed: an account that can write is refused unless the caller
   *    explicitly accepted AST-guard-only enforcement with allowWeakReadOnly.
   */
  async beginReadOnly(): Promise<void> {
    if (!this.connection) throw new Error("MySQL connection is not open");
    if (this.profile.readOnlyProof === "transaction") {
      await this.buffered("START TRANSACTION READ ONLY", 15_000);
      this.inReadOnly = true;
      return;
    }
    await this.verifyGrants();
  }

  private async verifyGrants(): Promise<void> {
    if (this.grantsChecked) return;
    let analysis: ReturnType<typeof analyzeGrants> | undefined;
    let failure: string | undefined;
    try {
      const { rows } = await this.buffered("SHOW GRANTS", 15_000);
      // MySQL returns one GRANT line per row; Doris 2.x may return a columnar row. Joining the cells
      // keeps both shapes readable, and anything unrecognisable stays unproven (fail closed).
      const lines = rows
        .map((row) => row.map((cell) => String(cell ?? "")).join(" ").trim())
        .filter((line) => line.length > 0);
      analysis = analyzeGrants(lines);
    } catch (error) {
      failure = (error as Error).message;
    }

    const writes = analysis?.writes ?? [];
    if (!failure && analysis && analysis.parsed > 0 && writes.length === 0) {
      this.proof = "grants";
      this.grantsChecked = true;
      this.notes.push(
        `Read-only access proven from account grants (${analysis.reads.join(", ") || "no writable privileges"}).`,
      );
      return;
    }

    const reason = failure
      ? `SHOW GRANTS failed: ${failure}`
      : !analysis || analysis.parsed === 0
        ? "SHOW GRANTS returned no recognizable GRANT lines"
        : `the account holds writable privileges: ${summarizeWrites(analysis)}`;
    if (!this.config.allowWeakReadOnly) {
      throw new AppError(
        "READONLY_UNVERIFIED",
        `${this.profile.label} has no read-only transactions and this account is not proven read-only: ${reason}. ` +
          "Use a SELECT-only account, or set allowWeakReadOnly=true to accept SQL-guard-only enforcement.",
        {
          engine: this.profile.id,
          writes: writes.map((write) => ({ privilege: write.privilege, scope: write.scope })),
          unparsed: analysis?.unparsed ?? [],
        },
      );
    }
    this.proof = "service_only";
    this.grantsChecked = true;
    this.notes.push(
      `Read-only is NOT verified by the database: ${reason}. Only the SQL guard protects the source ` +
        "because allowWeakReadOnly=true was requested.",
    );
  }

  async endReadOnly(): Promise<void> {
    if (this.profile.readOnlyProof !== "transaction") return;
    if (!this.connection || !this.inReadOnly) return;
    await this.buffered("ROLLBACK", 15_000).catch(() => undefined);
    this.inReadOnly = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.connection) {
        if (this.inReadOnly) await this.buffered("ROLLBACK", 10_000).catch(() => undefined);
        await new Promise<void>((resolve) => this.connection!.end(() => resolve()));
      }
    } catch {
      this.connection?.destroy();
    }
    await this.tunnel?.close();
  }

  private assertOpen(): Connection {
    if (!this.connection || this.closed) throw new Error("MySQL connection is not open");
    return this.connection;
  }

  protected async buffered(sql: string, timeoutMs: number): Promise<{ fields: ColumnMeta[]; rows: unknown[][] }> {
    const connection = this.assertOpen();
    const [rows, fields] = (await connection.promise().query({
      sql,
      timeout: Math.max(1, Math.floor(timeoutMs)),
      rowsAsArray: true,
    })) as unknown as [unknown[][] | unknown, FieldPacket[] | undefined];
    const fieldPackets = (fields ?? []) as FieldPacket[];
    return {
      fields: fieldPackets.map((field) => ({
        name: field.name,
        type: TYPE_NAMES.get(Number(field.type)) ?? `type_${String(field.type)}`,
      })),
      rows: Array.isArray(rows) ? (rows as unknown[][]) : [],
    };
  }

  async query(sql: string, limits: QueryLimits, sink: RowSink): Promise<QueryStats> {
    const connection = this.assertOpen();
    if (!this.inReadOnly) await this.beginReadOnly();

    const started = Date.now();
    const query = connection.query({ sql, timeout: Math.max(1, Math.floor(limits.timeoutMs)), rowsAsArray: true });
    const stream = query.stream({ highWaterMark: 50 }) as NodeJS.ReadableStream & {
      pause(): void;
      resume(): void;
      destroy(error?: Error): void;
      on(event: string, listener: (...args: any[]) => void): void;
    };

    const columns: ColumnMeta[] = [];
    let rowCount = 0;
    let bytes = 0;
    let truncated: QueryStats["truncated"] = "none";
    let aborted = false;
    let columnsSent = false;

    stream.on("fields", (fields: FieldPacket[]) => {
      for (const field of fields) {
        columns.push({ name: field.name, type: TYPE_NAMES.get(Number(field.type)) ?? `type_${String(field.type)}` });
      }
      sink.onColumns?.(columns);
      columnsSent = true;
    });

    let abortTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // KILL QUERY makes the stream emit an error (or end), which settles the async iteration.
      void this.cancel();
      // Safety net: if the server never reports the interruption, tear the connection down.
      abortTimer = setTimeout(() => stream.destroy(new Error("Query aborted")), 8_000);
      abortTimer.unref?.();
    };
    limits.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const rawRow of stream as AsyncIterable<unknown[]>) {
        if (aborted) break;
        const row = rawRow.map((value) => serializeValue(value, limits.maxCellChars));
        bytes += JSON.stringify(row).length;
        if (rowCount >= limits.maxRows || bytes > limits.maxBytes) {
          truncated = rowCount >= limits.maxRows ? "rows" : "bytes";
          stream.pause();
          // MySQL cannot stop a running statement from the same connection: kill it,
          // then discard the rest of the stream and restore a clean transaction.
          await this.cancel();
          stream.destroy();
          break;
        }
        await sink.onRow(row);
        rowCount += 1;
      }
    } catch (error) {
      // An interruption we requested is reported to the caller through the session's cancel state.
      if (!truncated && !aborted) throw error;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      limits.signal?.removeEventListener("abort", onAbort);
    }

    if (truncated !== "none" || aborted) {
      await this.endReadOnly();
      await this.beginReadOnly();
    }
    if (!columnsSent) sink.onColumns?.(columns);

    return {
      columns,
      rowCount,
      bytes,
      durationMs: Date.now() - started,
      truncated: aborted ? "none" : truncated,
      warnings: truncated === "rows" ? [`Result exceeded ${limits.maxRows} rows and was truncated.`] : [],
    };
  }

  async executeWorkspace(sql: string, timeoutMs: number): Promise<QueryStats> {
    this.assertOpen();
    await this.endReadOnly();
    const started = Date.now();
    try {
      const { fields, rows } = await this.buffered(sql, timeoutMs);
      return {
        columns: fields,
        rowCount: rows.length,
        bytes: 0,
        durationMs: Date.now() - started,
        truncated: "none",
        warnings: [],
      };
    } finally {
      await this.beginReadOnly().catch(() => undefined);
    }
  }

  async explain(sql: string, limits: QueryLimits): Promise<ExplainResult> {
    if (this.profile.explain === "none") {
      throw new AppError(
        "FEATURE_UNSUPPORTED",
        `${this.profile.label} does not support SQL EXPLAIN. Use data_profile for distributions, or run the query with a LIMIT.`,
        { engine: this.profile.id, feature: "explain" },
      );
    }
    if (this.profile.explain === "text") {
      const { rows } = await this.buffered(`EXPLAIN ${sql}`, limits.timeoutMs);
      const planText = rows.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
      return {
        planText: planText || "(empty plan)",
        estimatedCost: null,
        estimatedRows: null,
        warnings: [`${this.profile.label} returns a text plan; cost and row estimates are not available.`],
      };
    }
    const { rows } = await this.buffered(`EXPLAIN FORMAT=JSON ${sql}`, limits.timeoutMs);
    const planText = String(rows[0]?.[0] ?? "{}");
    const warnings: string[] = [];
    let estimatedCost: number | null = null;
    let estimatedRows: number | null = null;
    try {
      const parsed = JSON.parse(planText) as { query_block?: { cost_info?: { query_cost?: string }; table?: { rows_examined_per_scan?: number } } };
      const cost = parsed.query_block?.cost_info?.query_cost;
      if (cost !== undefined && Number.isFinite(Number(cost))) estimatedCost = Number(cost);
      const rowsExamined = parsed.query_block?.table?.rows_examined_per_scan;
      if (typeof rowsExamined === "number") estimatedRows = rowsExamined;
    } catch {
      warnings.push(`${this.profile.label} returned a plan that is not valid JSON`);
    }
    return { planText, estimatedCost, estimatedRows, warnings };
  }

  async listScopes(): Promise<string[]> {
    const { rows } = await this.buffered(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY 1`,
      15_000,
    );
    return rows.map((row) => String(row[0])).filter((name) => !this.hiddenScope(name));
  }

  /** Engine-state schemas that are not user data; Doris adds __internal_schema. */
  protected hiddenScope(name: string): boolean {
    return ["mysql", "information_schema", "performance_schema", "sys"].includes(name.toLowerCase());
  }

  async listObjects(filter: ObjectFilter): Promise<ObjectRef[]> {
    const search = filter.search ?? null;
    const estimateExpr = this.profile.rowEstimate === "table_rows" ? "TABLE_ROWS" : "NULL";
    const { rows } = await this.buffered(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ${estimateExpr}, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
         AND (${this.literal(search)} IS NULL OR TABLE_NAME LIKE ${this.like(search)} OR TABLE_SCHEMA LIKE ${this.like(search)})
         AND (${this.literal(filter.schema ?? null)} IS NULL OR TABLE_SCHEMA = ${this.literal(filter.schema ?? null)})
       ORDER BY TABLE_SCHEMA, TABLE_NAME
       LIMIT ${Math.max(1, Math.min(2_000, filter.limit))}`,
      20_000,
    );
    const kinds = filter.kinds ? new Set<string>(filter.kinds) : undefined;
    return rows
      .map((row) => ({
        schema: String(row[0]),
        name: String(row[1]),
        kind: String(row[2]).toUpperCase().includes("VIEW") ? "view" : "table",
        rowEstimate: row[3] === null || row[3] === undefined ? null : Number(row[3]),
        comment: row[4] ? String(row[4]) : null,
      }))
      .filter((object) => !kinds || kinds.has(object.kind))
      .filter((object) => !this.hiddenScope(object.schema));
  }

  private literal(value: string | null): string {
    if (value === null) return "NULL";
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }

  private like(value: string | null): string {
    if (value === null) return "NULL";
    return `'%${value.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_")}%'`;
  }

  async describeObject(schema: string | null, name: string): Promise<ObjectDescription> {
    const scope = schema ?? (await this.defaultScope());
    const estimateExpr = this.profile.rowEstimate === "table_rows" ? "TABLE_ROWS" : "NULL";
    const { rows: tableRows } = await this.buffered(
      `SELECT TABLE_TYPE, ${estimateExpr}, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ${this.literal(scope)} AND TABLE_NAME = ${this.literal(name)}`,
      15_000,
    );
    if (tableRows.length === 0) throw new Error(`Object ${scope}.${name} was not found or is not accessible`);
    const [tableType, estimate, comment] = tableRows[0]!;

    const { rows: columnRows } = await this.buffered(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ${this.literal(scope)} AND TABLE_NAME = ${this.literal(name)}
       ORDER BY ORDINAL_POSITION`,
      15_000,
    );
    const columns: ColumnInfo[] = columnRows.map((row, index) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: String(row[2]).toUpperCase() === "YES",
      default: row[3] === null || row[3] === undefined ? null : String(row[3]),
      comment: row[4] ? String(row[4]) : null,
      ordinal: Number(row[5] ?? index + 1),
    }));

    // Engines without secondary indexes / foreign keys (Doris, StarRocks) do not expose
    // information_schema.STATISTICS or KEY_COLUMN_USAGE rows; the profile says so instead of
    // letting the driver discover it as an error.
    const indexRows = this.profile.secondaryIndexes
      ? (
          await this.buffered(
            `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ${this.literal(scope)} AND TABLE_NAME = ${this.literal(name)}
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
            15_000,
          )
        ).rows
      : [];
    const indexMap = new Map<string, { name: string; columns: string[]; unique: boolean }>();
    for (const row of indexRows) {
      const indexName = String(row[0]);
      const entry = indexMap.get(indexName) ?? { name: indexName, columns: [], unique: Number(row[1]) === 0 };
      entry.columns.push(String(row[2]));
      indexMap.set(indexName, entry);
    }

    const fkRows = this.profile.foreignKeys
      ? (
          await this.buffered(
            `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ${this.literal(scope)} AND TABLE_NAME = ${this.literal(name)}
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
            15_000,
          )
        ).rows
      : [];
    const fkMap = new Map<string, { name: string; columns: string[]; references: string }>();
    for (const row of fkRows) {
      const fkName = String(row[0]);
      const entry =
        fkMap.get(fkName) ??
        { name: fkName, columns: [], references: `${String(row[2])}.${String(row[3])}.${String(row[4])}` };
      entry.columns.push(String(row[1]));
      fkMap.set(fkName, entry);
    }

    return {
      object: {
        schema: scope,
        name,
        kind: String(tableType).toUpperCase().includes("VIEW") ? "view" : "table",
        rowEstimate: estimate === null || estimate === undefined ? null : Number(estimate),
        comment: comment ? String(comment) : null,
      },
      columns,
      primaryKey: indexMap.get("PRIMARY")?.columns ?? [],
      indexes: [...indexMap.values()],
      foreignKeys: [...fkMap.values()],
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
      const numeric = nonNull.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      return {
        name: field.name,
        type: described.columns[index]?.type ?? field.type,
        nulls: values.length - nonNull.length,
        distinct: distinct.size,
        min: numeric.length ? Math.min(...numeric) : undefined,
        max: numeric.length ? Math.max(...numeric) : undefined,
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
    if (mode === "schema") {
      return { ok: false, note: "MySQL workspaces use a dedicated database; a schema name is the database name" };
    }
    const probe = `${quoteBacktick(name)}.__dwa_probe_${Date.now()}`;
    try {
      await this.executeWorkspace(`CREATE OR REPLACE VIEW ${probe} AS SELECT 1 AS ok`, 15_000);
      await this.executeWorkspace(`DROP VIEW ${probe}`, 15_000);
      return { ok: true };
    } catch (error) {
      return { ok: false, note: `Cannot create objects in database "${name}": ${(error as Error).message}` };
    }
  }

  async createView(workspace: string, name: string, selectSql: string): Promise<void> {
    const target = `${quoteBacktick(workspace)}.${quoteBacktick(name)}`;
    try {
      await this.executeWorkspace(
        // MySQL views accept no COMMENT clause; datasets are identified by the reserved name
        // prefix inside this session's workspace plus the service-side registry.
        `CREATE${this.viewSecurity} VIEW ${target} AS\n${selectSql}`,
        120_000,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") {
        // MySQL resolves unqualified tables in a view definition against the view's own database.
        throw new Error(
          `MySQL resolves unqualified table names against the view's database, so source tables must be qualified ` +
            `(for example \`${this.config.database}.table_name\`). Original error: ${(error as Error).message}`,
        );
      }
      throw error;
    }
  }

  async createTable(workspace: string, name: string, selectSql: string): Promise<void> {
    const target = `${quoteBacktick(workspace)}.${quoteBacktick(name)}`;
    await this.executeWorkspace(`CREATE TABLE ${target} AS\n${selectSql}`, 120_000);
    if (this.tableMarkerComment) {
      await this.executeWorkspace(`ALTER TABLE ${target} COMMENT = '${DATASET_MARKER}'`, 30_000);
    }
  }

  async dropDataset(workspace: string, name: string, kind: "view" | "table"): Promise<void> {
    const target = `${quoteBacktick(workspace)}.${quoteBacktick(name)}`;
    await this.executeWorkspace(kind === "view" ? `DROP VIEW ${target}` : `DROP TABLE ${target}`, 30_000);
  }

  async listDatasets(workspace: string): Promise<DatasetObject[]> {
    // MySQL cannot attach a comment to a view, so dataset ownership is enforced by the
    // reserved name prefix and by the service-side registry.
    const { rows } = await this.buffered(
      `SELECT TABLE_NAME, TABLE_TYPE, CREATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ${this.literal(workspace)}
         AND TABLE_NAME LIKE 'ds\\_%'
       ORDER BY TABLE_NAME`,
      15_000,
    );
    return rows.map((row) => ({
      name: String(row[0]),
      kind: String(row[1]).toUpperCase().includes("VIEW") ? "view" : "table",
      createdAt: row[2] ? String(row[2]) : null,
      definition: null,
    }));
  }

  async defaultScope(): Promise<string> {
    return this.config.database;
  }

  async cancel(): Promise<boolean> {
    const connection = this.connection;
    if (!connection || this.profile.cancel === "none") return false;
    const threadId = connection.threadId;
    if (!threadId) return false;
    // MySQL uses KILL QUERY (statement only); Doris/StarRocks use KILL <connection id>, which tears
    // the pinned connection down as well, so the session must be reopened afterwards.
    const statement =
      this.profile.cancel === "connection-id" ? `KILL ${Number(threadId)}` : `KILL QUERY ${Number(threadId)}`;
    let control: Connection | undefined;
    try {
      const stream = this.tunnel ? await this.tunnel.dial({ host: this.config.host, port: this.config.port }) : undefined;
      control = await this.newConnection(stream);
      await new Promise<void>((resolve, reject) => {
        control!.query(statement, (error) => (error ? reject(error) : resolve()));
      });
      return true;
    } catch {
      return false;
    } finally {
      await new Promise<void>((resolve) => (control ? control.end(() => resolve()) : resolve()));
    }
  }
}

/**
 * Apache Doris and StarRocks speak the MySQL protocol but not MySQL's SQL surface. Capability
 * decisions (read-only proof, explain, indexes, row estimates, cancellation) already live in the
 * profile; this subclass only overrides the DDL statements MySQL would reject.
 */
export class DorisEngine extends MysqlEngine {
  override readonly kind: EngineKind = "doris";
  protected override readonly viewSecurity = "";
  protected override readonly tableMarkerComment = false;

  /** Doris exposes __internal_schema for its own bookkeeping. */
  protected override hiddenScope(name: string): boolean {
    return super.hiddenScope(name) || name.startsWith("__");
  }
}

/** StarRocks shares Doris's SQL surface; the profile still keeps their capabilities separate. */
export class StarrocksEngine extends DorisEngine {
  override readonly kind: EngineKind = "starrocks";
}
