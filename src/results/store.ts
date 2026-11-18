import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ColumnMeta } from "../db/engines/base.js";

export interface ResultMeta {
  id: string;
  sessionId: string;
  taskId?: string;
  label?: string;
  sql: string;
  columns: ColumnMeta[];
  rowCount: number;
  bytes: number;
  truncated: "none" | "rows" | "bytes";
  durationMs: number;
  createdAt: string;
  /** First rows kept inline so previews never touch disk. */
  preview: unknown[][];
  previewRows: number;
  error?: string;
  warnings?: string[];
  cached?: boolean;
  cacheAgeMs?: number;
  timezone?: string;
  lineage?: { parent_result_id: string; operation: string; parameters?: unknown };
  privacy?: { masked_columns: string[]; boundary: "output-name-defense-in-depth" };
}

export interface ResultPage {
  id: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  offset: number;
  rowCount: number;
  nextOffset: number | null;
  truncated: ResultMeta["truncated"];
  createdAt: string;
  sql: string;
}

const META_SUFFIX = ".meta.json";
const DATA_SUFFIX = ".ndjson";

export class ResultWriter {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private closed = false;
  private bytes = 0;
  private rows = 0;
  private readonly preview: unknown[][] = [];
  private columns: ColumnMeta[] = [];

  constructor(
    private readonly store: ResultStore,
    readonly id: string,
    private readonly sessionId: string,
    private readonly sql: string,
    private readonly previewRows: number,
    private readonly taskId?: string,
    private readonly label?: string,
  ) {
    this.stream = createWriteStream(store.dataPath(id), { flags: "wx" });
  }

  setColumns(columns: ColumnMeta[]): void {
    this.columns = columns;
  }

  async append(row: unknown[]): Promise<void> {
    if (this.closed) throw new Error("result writer is closed");
    if (this.preview.length < this.previewRows) this.preview.push(row);
    this.rows += 1;
    const line = `${JSON.stringify(row)}\n`;
    this.bytes += Buffer.byteLength(line);
    const ok = this.stream.write(line);
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          this.stream.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          this.stream.off("drain", onDrain);
          reject(error);
        };
        this.stream.once("drain", onDrain);
        this.stream.once("error", onError);
      });
    }
  }

  async finish(truncated: ResultMeta["truncated"], durationMs: number): Promise<ResultMeta> {
    await this.close();
    const meta: ResultMeta = {
      id: this.id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      label: this.label,
      sql: this.sql,
      columns: this.columns,
      rowCount: this.rows,
      bytes: this.bytes,
      truncated,
      durationMs,
      createdAt: new Date().toISOString(),
      preview: this.preview,
      previewRows: this.preview.length,
    };
    await this.store.saveMeta(meta);
    return meta;
  }

  async abort(error: string): Promise<ResultMeta> {
    await this.close();
    const meta: ResultMeta = {
      id: this.id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      label: this.label,
      sql: this.sql,
      columns: this.columns,
      rowCount: this.rows,
      bytes: this.bytes,
      truncated: "none",
      durationMs: 0,
      createdAt: new Date().toISOString(),
      preview: this.preview,
      previewRows: this.preview.length,
      error,
    };
    await this.store.saveMeta(meta);
    return meta;
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }
}

export class ResultStore {
  private static readonly writes = new Map<string, Promise<unknown>>();
  /** Coordinates source and local writers in this single-process service so quotas cannot race. */
  serializeWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.root + ":" + sessionId;
    const previous = ResultStore.writes.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation), settled = next.then(() => undefined, () => undefined);
    ResultStore.writes.set(key, settled);
    void settled.then(() => { if (ResultStore.writes.get(key) === settled) ResultStore.writes.delete(key); });
    return next;
  }
  constructor(private readonly root: string) {}
  get directory() { return this.root; }

  dataPath(id: string): string {
    return join(this.root, `${id}${DATA_SUFFIX}`);
  }

  metaPath(id: string): string {
    return join(this.root, `${id}${META_SUFFIX}`);
  }

  async create(options: {
    /** Internal preallocation lets a terminated local worker clean up partial output. */
    id?: string;
    sessionId: string;
    sql: string;
    previewRows: number;
    taskId?: string;
    label?: string;
  }): Promise<ResultWriter> {
    await mkdir(this.root, { recursive: true });
    const id = options.id ?? `res_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    if (!/^res_[a-z0-9]{8,32}$/.test(id)) throw new Error("Invalid result id");
    return new ResultWriter(this, id, options.sessionId, options.sql, options.previewRows, options.taskId, options.label);
  }

  async saveMeta(meta: ResultMeta): Promise<void> {
    await writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), "utf8");
  }

  async get(id: string): Promise<ResultMeta | undefined> {
    if (!/^res_[a-z0-9]{8,32}$/i.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(this.metaPath(id), "utf8")) as ResultMeta;
    } catch {
      return undefined;
    }
  }

  async read(id: string, offset: number, limit: number, cellLimit = 2_000): Promise<ResultPage | undefined> {
    const meta = await this.get(id);
    if (!meta) return undefined;
    if (!existsSync(this.dataPath(id))) {
      return { ...meta, rows: meta.preview, offset: 0, nextOffset: null };
    }
    const rows: unknown[][] = [];
    const start = Math.max(0, offset);
    const max = Math.max(1, Math.min(1_000, limit));
    let index = 0;
    let nextOffset: number | null = null;
    const input = createReadStream(this.dataPath(id));
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line) continue;
        if (index < start) {
          index += 1;
          continue;
        }
        if (rows.length >= max) {
          nextOffset = index;
          break;
        }
        rows.push(JSON.parse(line) as unknown[]);
        index += 1;
      }
      if (nextOffset === null && rows.length < max) nextOffset = null;
    } finally {
      reader.close();
      input.destroy();
    }
    return {
      id,
      columns: meta.columns,
      rows: rows.map((row) => row.map((cell) => truncateCell(cell, cellLimit))),
      offset: start,
      rowCount: meta.rowCount,
      nextOffset,
      truncated: meta.truncated,
      createdAt: meta.createdAt,
      sql: meta.sql,
    };
  }

  /**
   * Streams every stored row once. `read()` pages from the start of the file each time, so a full
   * export through it would be quadratic; exports of large results need a single forward pass.
   */
  async *iterateRows(id: string): AsyncGenerator<unknown[]> {
    const meta = await this.get(id);
    if (!meta) return;
    if (!existsSync(this.dataPath(id))) {
      if (meta.preview.length !== meta.rowCount) throw new Error(`Result ${id} data file is missing`);
      yield* meta.preview;
      return;
    }
    const input = createReadStream(this.dataPath(id));
    const reader = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of reader) {
        if (!line) continue;
        count += 1;
        yield JSON.parse(line) as unknown[];
      }
      if (count !== meta.rowCount) throw new Error(`Result ${id} row count does not match metadata`);
    } finally {
      reader.close();
      input.destroy();
    }
  }

  async listBySession(sessionId: string): Promise<ResultMeta[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root);
    const results: ResultMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(META_SUFFIX)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.root, entry), "utf8")) as ResultMeta;
        if (meta.sessionId === sessionId) results.push(meta);
      } catch {
        /* ignore corrupt metadata */
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const metas = await this.listBySession(sessionId);
    await Promise.all(
      metas.flatMap((meta) => [
        rm(this.metaPath(meta.id), { force: true }),
        rm(this.dataPath(meta.id), { force: true }),
      ]),
    );
  }
}

function truncateCell(value: unknown, max: number): unknown {
  if (typeof value === "string" && value.length > max) {
    return { __type: "text", chars: value.length, preview: value.slice(0, max), truncated: true };
  }
  return value;
}
