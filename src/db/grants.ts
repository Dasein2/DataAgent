/**
 * Account grant analysis: the substitute for a read-only transaction on engines that have none.
 *
 * MySQL and PostgreSQL can be held read-only inside the connection (`START TRANSACTION READ ONLY`).
 * Doris/StarRocks cannot, so the only hard guarantee left is the account's own privileges. This
 * module reads `SHOW GRANTS` output and decides whether the account can write anywhere.
 *
 * Fail-closed: a privilege name that is not on the read-only allow-list counts as a write, and a
 * line that cannot be parsed counts as a write as well. A new engine with new privilege names can
 * therefore never be read-only by accident.
 */

/** Privileges that genuinely cannot change data or structure. Everything else is a write. */
const READ_ONLY_PRIVILEGES = new Set([
  "SELECT",
  "SELECT_PRIV",
  "USAGE",
  "USAGE_PRIV",
  "SHOW DATABASES",
  "SHOW VIEW",
  "SHOW_VIEW",
  "SHOW_VIEW_PRIV",
  "SHOW_ROLE",
  "SHOW_ROLE_PRIV",
  "SHOW_USER",
  "SHOW_USER_PRIV",
  "PROCESS",
  "REPLICATION CLIENT",
]);

export interface GrantWrite {
  privilege: string;
  scope: string;
  line: string;
}

export interface GrantAnalysis {
  /** Privileges that allow writing; empty means the account is read-only. */
  writes: GrantWrite[];
  /** Distinct read-only privileges seen. */
  reads: string[];
  /** `GRANT` lines that were understood. */
  parsed: number;
  /** Lines that could not be parsed; each one is also reported as a write. */
  unparsed: string[];
}

function normalize(privilege: string): string {
  return privilege.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Parses `SHOW GRANTS` rows. Accepts the MySQL form (`GRANT SELECT ON `db`.* TO ...`) and the
 * Doris/StarRocks form (`GRANT SELECT_PRIV ON db.* TO ...`), including multi-privilege grants.
 */
export function analyzeGrants(lines: string[]): GrantAnalysis {
  const writes: GrantWrite[] = [];
  const reads = new Set<string>();
  const unparsed: string[] = [];
  let parsed = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!/^GRANT\b/i.test(line)) continue;
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(line);
    if (!match) {
      unparsed.push(line);
      writes.push({ privilege: "UNPARSED", scope: "unknown", line });
      continue;
    }
    parsed += 1;
    const scope = match[2]!.replace(/[`"]/g, "").trim();
    for (const part of match[1]!.split(",")) {
      const privilege = normalize(part);
      if (!privilege) continue;
      if (READ_ONLY_PRIVILEGES.has(privilege)) {
        reads.add(privilege);
        continue;
      }
      writes.push({ privilege, scope, line });
    }
  }

  return { writes, reads: [...reads].sort(), parsed, unparsed };
}

/**
 * Doris/StarRocks answer `SHOW GRANTS` with one row of privilege *columns* instead of MySQL's
 * `GRANT ... ON ... TO ...` lines (see apache/doris `SHOW GRANTS`: UserIdentity, Comment, Password,
 * Roles, GlobalPrivs, CatalogPrivs, DatabasePrivs, TablePrivs, ColPrivs, ResourcePrivs,
 * WorkloadGroupPrivs, ...). Each non-empty cell holds `scope: Priv,Priv; scope: Priv` entries, so
 * the line-oriented parser above can never match it and fail-closed would refuse every account.
 */
const DORIS_PRIVILEGE_COLUMNS = new Set([
  "globalprivs",
  "catalogprivs",
  "databaseprivs",
  "tableprivs",
  "colprivs",
  "resourceprivs",
  "workloadgroupprivs",
  "storagevaultprivs",
]);

interface CellAnalysis {
  reads: string[];
  writes: GrantWrite[];
  unparsed: string[];
}

/** Splits one Doris privilege cell into `scope: Priv,Priv` entries. */
function splitPrivilegeEntries(cell: string): string[] {
  return cell
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parses one privilege cell. An entry is `scope: Priv,Priv` or a bare privilege list (global
 * scope). Some builds render the cell as a JSON object keyed by privilege name; both are accepted,
 * and anything unrecognisable is reported as a write so the caller stays fail-closed.
 */
function analyzePrivilegeCell(cell: string): CellAnalysis {
  const reads: string[] = [];
  const writes: GrantWrite[] = [];
  const unparsed: string[] = [];

  for (const entry of splitPrivilegeEntries(cell)) {
    let scope = "*";
    let privileges = entry;

    if (entry.startsWith("{")) {
      try {
        const parsed = JSON.parse(entry) as Record<string, unknown>;
        privileges = Object.keys(parsed)
          .filter((key) => {
            const value = parsed[key];
            return value !== false && value !== null && String(value).toLowerCase() !== "false";
          })
          .join(",");
      } catch {
        unparsed.push(entry);
        writes.push({ privilege: "UNPARSED", scope: "unknown", line: entry });
        continue;
      }
    } else {
      const colon = entry.indexOf(":");
      if (colon > 0) {
        scope = entry.slice(0, colon).trim() || "*";
        privileges = entry.slice(colon + 1);
      }
    }

    for (const part of privileges.split(",")) {
      const privilege = normalize(part);
      if (!privilege) continue;
      if (READ_ONLY_PRIVILEGES.has(privilege)) {
        reads.push(privilege);
        continue;
      }
      writes.push({ privilege, scope, line: entry });
    }
  }

  return { reads, writes, unparsed };
}

/** Parses the columnar `SHOW GRANTS` shape used by Doris and StarRocks. */
export function analyzeDorisGrants(
  fields: ReadonlyArray<{ name: string }>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): GrantAnalysis {
  const columns = fields
    .map((field, index) => ({ index, name: field.name.toLowerCase() }))
    .filter((column) => DORIS_PRIVILEGE_COLUMNS.has(column.name));

  if (columns.length === 0) {
    return {
      writes: [],
      reads: [],
      parsed: 0,
      unparsed: rows.map((row) => row.map((cell) => String(cell ?? "")).join(" ").trim()),
    };
  }

  const reads = new Set<string>();
  const writes: GrantWrite[] = [];
  const unparsed: string[] = [];
  let parsed = 0;

  for (const row of rows) {
    // A recognised shape is enough to judge the row: empty or NULL cells simply list no privileges.
    parsed += 1;
    for (const column of columns) {
      const raw = row[column.index];
      if (raw === null || raw === undefined) continue;
      const cell = String(raw).trim();
      if (!cell || /^(null|\\N|none)$/i.test(cell)) continue;
      const analysis = analyzePrivilegeCell(cell);
      for (const read of analysis.reads) reads.add(read);
      writes.push(...analysis.writes);
      unparsed.push(...analysis.unparsed);
    }
  }

  return { writes, reads: [...reads].sort(), parsed, unparsed };
}

/**
 * Dispatches on the shape actually returned: MySQL emits one `GRANT` line per row, Doris/StarRocks
 * emit a single columnar row. Both end up in the same analysis structure.
 */
export function analyzeGrantRows(
  fields: ReadonlyArray<{ name: string }>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): GrantAnalysis {
  const lines = rows
    .map((row) => row.map((cell) => String(cell ?? "")).join(" ").trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => /^GRANT\b/i.test(line))) return analyzeGrants(lines);
  return analyzeDorisGrants(fields, rows);
}

/** One-line human summary of what a write-capable account can do. */
export function summarizeWrites(analysis: GrantAnalysis, limit = 5): string {
  return analysis.writes
    .slice(0, limit)
    .map((write) => `${write.privilege} on ${write.scope}`)
    .join(", ");
}
