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

/** One-line human summary of what a write-capable account can do. */
export function summarizeWrites(analysis: GrantAnalysis, limit = 5): string {
  return analysis.writes
    .slice(0, limit)
    .map((write) => `${write.privilege} on ${write.scope}`)
    .join(", ");
}
