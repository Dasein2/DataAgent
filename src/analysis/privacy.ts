import { createHash } from "node:crypto";
import type { ColumnMeta } from "../db/engines/base.js";
import type { AnalysisOptions } from "./options.js";
import { AppError } from "../errors.js";

/** Output-name masking is defense in depth, not source authorization (aliases can hide names). */
export function rowMasker(columns: ColumnMeta[], rules: AnalysisOptions["masking"], salt: string) {
  const modes = columns.map((c) => rules.find((r) => r.column.toLowerCase() === c.name.toLowerCase())?.mode);
  return (row: unknown[]) =>
    row.map((value, i) => {
      const mode = modes[i];
      if (!mode || value == null) return value;
      if (mode === "deny") return null;
      const s = typeof value === "string" ? value : JSON.stringify(value);
      if (mode === "hash")
        return createHash("sha256")
          .update(salt + "\0" + s)
          .digest("hex");
      return s.length <= 4 ? "***" : s.slice(0, 2) + "***" + s.slice(-2);
    });
}
export function checkLocalSize(
  rows: number,
  bytes: number,
  limits: { maxLocalRows: number; maxLocalBytes: number },
): void {
  if (rows > limits.maxLocalRows || bytes > limits.maxLocalBytes)
    throw new AppError(
      "RESULT_ROW_LIMIT",
      "Local analysis input exceeds configured row/byte cap. Reduce or aggregate the source query first.",
      {
        rows,
        bytes,
        max_rows: limits.maxLocalRows,
        max_bytes: limits.maxLocalBytes,
      },
    );
}
