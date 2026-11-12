import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;
import type { EngineKind } from "./types.js";
import { getProfile } from "./engines/profiles.js";

/**
 * Read-only SQL guard.
 *
 * This is a defence-in-depth layer, not the security boundary. The boundary is the
 * database account (SELECT only) plus the read-only transaction. The guard exists so
 * that the agent gets a fast, explicit rejection instead of a database permission error,
 * and so that statements which are read-only but still dangerous (locks, file access,
 * transaction control) never reach the server.
 *
 * The statement scanner is a real tokenizer, engine-aware for string/identifier quoting
 * and comments. It is deliberately strict: unquoted words that collide with a denied
 * keyword are rejected. Callers can always quote identifiers.
 */

export type SqlKind = "select" | "explain" | "show" | "describe" | "other";

export interface GuardOptions {
  engine: EngineKind;
  /** Schemas (PostgreSQL) or databases (MySQL) the session may reference. */
  allowedScopes: string[];
  /** Workspace schema/database owned by this session. */
  workspace?: string;
  /** Identifier prefix reserved for analysis workspaces of all sessions. */
  reservedPrefix?: string;
}

export interface GuardResult {
  ok: boolean;
  kind: SqlKind;
  tables: string[];
  warnings: string[];
  parsed: boolean;
  hasLimit: boolean;
  /** EXPLAIN ANALYZE executes the query, so budgets still apply. */
  executesQuery: boolean;
  code?: string;
  reason?: string;
}

const DENIED = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "replace",
  "truncate",
  "drop",
  "alter",
  "create",
  "rename",
  "grant",
  "revoke",
  "comment",
  "copy",
  "call",
  "do",
  "lock",
  "vacuum",
  "analyze",
  "analyse",
  "share",
  "reindex",
  "cluster",
  "refresh",
  "set",
  "reset",
  "discard",
  "listen",
  "notify",
  "unlisten",
  "prepare",
  "execute",
  "deallocate",
  "declare",
  "move",
  "close",
  "into",
  "outfile",
  "dumpfile",
  "kill",
  "shutdown",
  "flush",
  "optimize",
  "repair",
  "use",
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "attach",
  "detach",
  "import",
  "load",
  "handler",
  "install",
  "uninstall",
  "security",
  "transaction",
  "pragma",
  "system",
  "shell",
  "createuser",
]);

/** Denied words that are also scalar functions in MySQL when followed by "(". */
const FUNCTION_WORDS = new Set(["replace", "truncate", "insert"]);

const DENIED_FUNCTIONS = new Set([
  // PostgreSQL: file system, OS, other sessions, config, replication
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
  "lo_create",
  "lo_unlink",
  "dblink",
  "dblink_connect",
  "dblink_exec",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_promote",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_drop_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_logical_emit_message",
  "pg_file_write",
  "pg_file_rename",
  "pg_file_unlink",
  "set_config",
  "query_to_xml",
  "cursor_to_xml",
  "pg_export_snapshot",
  "pg_advisory_lock",
  "pg_advisory_xact_lock",
  "pg_try_advisory_lock",
  // MySQL: file system, locks, CPU abuse
  "load_file",
  "sleep",
  "benchmark",
  "get_lock",
  "release_lock",
  "release_all_locks",
  "sys_exec",
  "sys_eval",
  "master_pos_wait",
  "uuid_short",
]);

const ALLOWED_LEADING = new Set(["select", "with", "explain", "show", "describe", "desc", "values", "table"]);

const RESERVED_PREFIX_DEFAULT = "dwa_";

interface Token {
  type: "word" | "quoted" | "string" | "punct";
  value: string;
  /** Lower-cased value for words, unquoted value for quoted identifiers. */
  lower: string;
}

function tokenize(sql: string, engine: EngineKind): Token[] {
  const tokens: Token[] = [];
  // Quoting rules come from the declared dialect: Doris/StarRocks are MySQL dialect even though
  // they are not MySQL, and a new MySQL-dialect engine inherits the same tokenizer for free.
  const { quote, dialect } = getProfile(engine);
  const backtickSyntax = quote === "`";
  const backslashEscapes = dialect === "MySQL";
  const postgresSyntax = dialect === "Postgresql";
  let i = 0;
  const n = sql.length;

  const isWordStart = (ch: string) => /[A-Za-z_\u0080-\uffff]/.test(ch);
  const isWordPart = (ch: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);

  while (i < n) {
    const ch = sql[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*" && postgresSyntax) {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < n) {
        if (backslashEscapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new GuardParseError("SQL_UNTERMINATED_STRING", "unterminated string literal");
      tokens.push({ type: "string", value: "", lower: "" });
      continue;
    }

    if (ch === '"' || (backtickSyntax && ch === "`")) {
      const quote = ch;
      i += 1;
      let value = "";
      let closed = false;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        if (backslashEscapes && sql[i] === "\\") {
          value += sql[i + 1] ?? "";
          i += 2;
          continue;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) throw new GuardParseError("SQL_UNTERMINATED_IDENTIFIER", "unterminated quoted identifier");
      tokens.push({ type: "quoted", value, lower: value.toLowerCase() });
      continue;
    }

    if (ch === "$" && postgresSyntax) {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new GuardParseError("SQL_UNTERMINATED_STRING", "unterminated dollar-quoted string");
        i = end + tag.length;
        tokens.push({ type: "string", value: "", lower: "" });
        continue;
      }
    }

    if (isWordStart(ch)) {
      const start = i;
      i += 1;
      while (i < n && isWordPart(sql[i]!)) i += 1;
      const value = sql.slice(start, i);
      tokens.push({ type: "word", value, lower: value.toLowerCase() });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && /[0-9a-fx._eE+-]/.test(sql[i]!) && !/\s/.test(sql[i]!)) i += 1;
      tokens.push({ type: "punct", value: sql.slice(start, i), lower: sql.slice(start, i) });
      continue;
    }

    // Everything else is an operator/punctuation character. Keep ';' as its own token.
    tokens.push({ type: "punct", value: ch, lower: ch });
    i += 1;
  }

  return tokens;
}

export class GuardParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseTables(engine: EngineKind, sql: string): string[] {
  try {
    // Note: node-sql-parser's tableList covers the SQL string form; the AST overload is
    // broken in the bundled build ("r.trim is not a function"), so always pass SQL.
    const parser = new Parser();
    return parser.tableList(sql, { database: getProfile(engine).dialect }) as string[];
  } catch {
    return [];
  }
}

function unquoteTableRef(ref: string): { scope: string | null; name: string } {
  // node-sql-parser format: action::scope::table
  const parts = ref.split("::");
  const scope = parts.length >= 3 ? parts[1] : null;
  const name = parts[parts.length - 1] ?? ref;
  const clean = (value: string | null | undefined) =>
    value === null || value === "null" || value === "" ? null : value === undefined ? null : value.replace(/^["`]|["`]$/g, "").toLowerCase();
  return { scope: clean(scope), name: name.replace(/^["`]|["`]$/g, "").toLowerCase() };
}

export function guardSql(sql: string, options: GuardOptions): GuardResult {
  const warnings: string[] = [];
  const result: GuardResult = {
    ok: false,
    kind: "other",
    tables: [],
    warnings,
    parsed: false,
    hasLimit: false,
    executesQuery: false,
  };

  const trimmed = sql.trim();
  if (!trimmed) return { ...result, code: "SQL_EMPTY", reason: "SQL statement is empty" };

  let tokens: Token[];
  try {
    tokens = tokenize(trimmed, options.engine);
  } catch (error) {
    if (error instanceof GuardParseError) return { ...result, code: error.code, reason: error.message };
    throw error;
  }

  // Statement splitting: reject anything after a top-level semicolon.
  const semicolons = tokens.filter((token) => token.type === "punct" && token.value === ";");
  if (semicolons.length > 0) {
    const lastSemicolon = tokens.map((token) => token.value === ";").lastIndexOf(true);
    const trailing = tokens.slice(lastSemicolon + 1);
    if (trailing.length > 0 || tokens.slice(0, lastSemicolon).some((token) => token.value === ";")) {
      return {
        ...result,
        code: "SQL_MULTIPLE_STATEMENTS",
        reason: "Only a single SQL statement is allowed per call",
      };
    }
    // A single trailing semicolon is harmless; drop it from analysis.
    tokens = tokens.slice(0, lastSemicolon);
  }

  if (tokens.length === 0) return { ...result, code: "SQL_EMPTY", reason: "SQL statement is empty" };

  const firstWord = tokens.find((token) => token.type === "word")?.lower;
  if (!firstWord || !ALLOWED_LEADING.has(firstWord)) {
    return {
      ...result,
      code: "SQL_FORBIDDEN_STATEMENT",
      reason: `Only read-only statements are allowed (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE); got "${firstWord ?? tokens[0]?.value ?? ""}"`,
    };
  }

  const kind: SqlKind =
    firstWord === "select" || firstWord === "with" || firstWord === "values" || firstWord === "table"
      ? "select"
      : firstWord === "explain"
        ? "explain"
        : firstWord === "show"
          ? "show"
          : "describe";
  result.kind = kind;
  result.executesQuery = kind === "select" || (kind === "explain" && tokens.some((token) => token.lower === "analyze" || token.lower === "analyse"));
  result.hasLimit = tokens.some((token) => token.lower === "limit");

  // EXPLAIN ANALYZE / SHOW CREATE are read-only despite containing a denied keyword.
  const skipKeywordCheck = kind === "show" || kind === "describe";
  const allowedInContext = new Set<string>();
  if (kind === "explain") {
    allowedInContext.add("analyze");
    allowedInContext.add("analyse");
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type !== "word") continue;
    // A few denied words are also legitimate scalar functions when followed by "(".
    const calledAsFunction = FUNCTION_WORDS.has(token.lower) && tokens[index + 1]?.value === "(";
    if (!skipKeywordCheck && DENIED.has(token.lower) && !allowedInContext.has(token.lower) && !calledAsFunction) {
      return {
        ...result,
        code: "SQL_FORBIDDEN_KEYWORD",
        reason: `Keyword "${token.value}" is not allowed in analysis queries; source data is read-only`,
      };
    }
    if (DENIED_FUNCTIONS.has(token.lower) && tokens[index + 1]?.value === "(") {
      return {
        ...result,
        code: "SQL_FORBIDDEN_FUNCTION",
        reason: `Function "${token.value}" is blocked for analysis sessions`,
      };
    }
  }

  const tables = parseTables(options.engine, trimmed);
  result.tables = tables;
  result.parsed = tables.length > 0 || kind === "select";

  const reservedPrefix = (options.reservedPrefix ?? RESERVED_PREFIX_DEFAULT).toLowerCase();
  const allowed = new Set(options.allowedScopes.map((scope) => scope.toLowerCase()));
  if (options.workspace) allowed.add(options.workspace.toLowerCase());

  for (const ref of tables) {
    const { scope, name } = unquoteTableRef(ref);
    if (scope && !allowed.has(scope)) {
      if (scope.startsWith(reservedPrefix) && scope !== options.workspace?.toLowerCase()) {
        return {
          ...result,
          code: "SQL_SCOPE_VIOLATION",
          reason: `Object "${scope}.${name}" belongs to another analysis workspace`,
        };
      }
      warnings.push(`References schema/database "${scope}" outside the declared scope; the database account decides access.`);
      continue;
    }
    if (!scope && name.startsWith(reservedPrefix) && name !== options.workspace?.toLowerCase()) {
      return {
        ...result,
        code: "SQL_SCOPE_VIOLATION",
        reason: `Object "${name}" belongs to another analysis workspace`,
      };
    }
  }

  return { ...result, ok: true };
}
