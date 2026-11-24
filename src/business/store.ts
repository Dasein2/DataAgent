import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors.js";
import type { CatalogDraft, CatalogVersion } from "./types.js";

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only live server-side scopes may access this store; SQL stores definitions and evidence, not source rows. */
export class BusinessCatalogStore {
  private db?: DatabaseSync;
  constructor(private readonly path: string) {}
  private get sql() {
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS versions(scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS active(scope TEXT PRIMARY KEY, id TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(scope, version, kind UNINDEXED, id UNINDEXED, content, tokenize='trigram');`);
    return this.db = db;
  }
  close() { this.db?.close(); this.db = undefined; }

  get(scope: string, id: string): CatalogVersion {
    const row = this.sql.prepare("SELECT body FROM versions WHERE scope = ? AND id = ?").get(scope, id);
    if (!row) throw new AppError("NOT_FOUND", "Business catalog version not found in the current permission scope");
    return JSON.parse(String(row.body)) as CatalogVersion;
  }

  list(scope: string) {
    return this.sql.prepare("SELECT body FROM versions WHERE scope = ? ORDER BY rowid DESC LIMIT 100").all(scope)
      .map(r => { const { id, at, reviewer, catalog } = JSON.parse(String(r.body)) as CatalogVersion; return { id, at, reviewer, domain: catalog.domain }; });
  }

  active(connection: string) {
    const row = this.sql.prepare("SELECT id, enabled FROM active WHERE scope = ?").get(connection);
    return row && { id: String(row.id), enabled: Boolean(row.enabled) };
  }

  save(scope: string, catalog: CatalogDraft, release?: { reviewer: string; binding: Record<string, string>; connection: string }) {
    const version: CatalogVersion = { id: `biz_${randomUUID().replaceAll("-", "")}`, at: new Date().toISOString(), catalog,
      reviewer: release?.reviewer, binding: release?.binding };
    const sql = this.sql;
    sql.exec("BEGIN");
    try {
      if (Number(sql.prepare("SELECT COUNT(*) AS n FROM versions WHERE scope = ?").get(scope)?.n) >= 100)
        throw new AppError("INVALID_INPUT", "Business catalog has reached 100 versions for this scope");
      sql.prepare("INSERT INTO versions VALUES(?, ?, ?)").run(scope, version.id, JSON.stringify(version));
      const index = sql.prepare("INSERT INTO terms VALUES(?, ?, ?, ?, ?)");
      for (const m of catalog.metrics) index.run(scope, version.id, "metric", m.id, [catalog.domain, m.id, m.label, ...m.aliases].join(" "));
      for (const t of catalog.tables) index.run(scope, version.id, "table", t.id, [t.name, t.schema, t.label, ...t.aliases, ...t.fields.flatMap(f => [f.column, f.label, ...f.aliases])].join(" "));
      // Every published revision starts dark until the operator explicitly enables it.
      if (release) sql.prepare("INSERT INTO active VALUES(?, ?, 0) ON CONFLICT(scope) DO UPDATE SET id=excluded.id, enabled=0").run(release.connection, version.id);
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
    return version;
  }

  enable(scope: string, enabled: boolean) {
    if (!this.sql.prepare("UPDATE active SET enabled = ? WHERE scope = ?").run(Number(enabled), scope).changes)
      throw new AppError("INVALID_INPUT", "Publish a signed version first");
  }

  lookup(scope: string, version: string, question: string) {
    // Trigrams also work for phrases not separated by spaces (e.g. Chinese). Parameters are bound;
    // the bounded LIKE fallback handles short aliases or a question containing a full alias.
    const escaped = question.trim().replace(/[\\%_]/g, "\\$&");
    return this.sql.prepare(`SELECT kind, id FROM terms WHERE scope=? AND version=? AND content LIKE ? ESCAPE '\\' LIMIT 20`)
      .all(scope, version, `%${escaped}%`) as Array<{ kind: "metric" | "table"; id: string }>;
  }
}
