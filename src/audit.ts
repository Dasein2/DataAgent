import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Export audit.
 *
 * Session audit lives in `data/audit/<session>.ndjson` and is written by DbSession, but an export is
 * an HTTP operation that may happen long after the session closed — and it is the main way data
 * leaves the platform. So exports go to their own append-only file with enough context to answer
 * "who took which rows out of here".
 */

export type ExportFormat = "csv" | "excel" | "svg" | "png" | "pdf";

export interface ExportAuditEvent {
  format: ExportFormat;
  object: "result" | "artifact";
  object_id: string;
  session_id: string | null;
  owner_key: string;
  rows: number;
  /** `partial` exports are allowed only with an explicit marker; the audit records which. */
  complete: boolean;
  truncated?: "none" | "rows" | "bytes";
  client?: string | null;
}

export async function auditExport(dataDir: string, event: ExportAuditEvent): Promise<void> {
  const line = JSON.stringify({ action: "export", at: new Date().toISOString(), ...event });
  try {
    await mkdir(join(dataDir, "audit"), { recursive: true });
    await appendFile(join(dataDir, "audit", "exports.ndjson"), `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Auditing must not break the download the user asked for; the failure is still visible in logs.
    console.warn(`export audit write failed: ${line}`);
  }
}
