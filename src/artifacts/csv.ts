/**
 * CSV rendering and export auditing.
 *
 * Two details decide whether an exported file is usable:
 *  - a UTF-8 BOM, otherwise Excel opens Chinese text as mojibake;
 *  - formula injection protection, otherwise a value like `=HYPERLINK(...)` coming from the
 *    database becomes a live formula in the reviewer's spreadsheet.
 * The protection is applied to *text* cells only: prefixing a number such as -12.5 would turn a
 * usable column into strings.
 */

export const UTF8_BOM = "\uFEFF";
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Flatten the serialised cell wrappers the result store writes for oversized values. */
export function plainCell(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.__type === "text" || record.__type === "json") return record.preview ?? "";
    if (record.__type === "bytes") return `<${String(record.bytes)} bytes>`;
  }
  return value;
}

function escapeFormula(text: string): string {
  if (text.length === 0) return text;
  const first = text[0]!;
  if (first === "=" || first === "+" || first === "@" || first === "\t" || first === "\r") return `'${text}`;
  // A bare leading "-" is only dangerous when the value is not a number.
  if (first === "-" && !NUMERIC.test(text)) return `'${text}`;
  return text;
}

export function csvCell(value: unknown): string {
  const cell = plainCell(value);
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  const text = escapeFormula(typeof cell === "string" ? cell : JSON.stringify(cell) ?? "");
  const needsQuotes = /[",\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

export function csvDocument(header: string[], rows: unknown[][]): string {
  return UTF8_BOM + csvLine(header) + rows.map((row) => csvLine(row)).join("");
}
