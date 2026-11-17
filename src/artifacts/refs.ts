import { cellText } from "../db/engines/base.js";
import type { ArtifactData } from "./types.js";

/**
 * Refs address one number inside an artifact:
 *
 *   art_7x2f#cell[weekday=周五,hour=20]
 *
 * They are derived from the long-format snapshot and never stored separately, so they stay valid
 * for the life of the (immutable) artifact. A report cites `value_ref` instead of copying "1284"
 * into prose; the renderer resolves the ref back to the row, the source SQL and the execution.
 */

const REF_PATTERN = /^(art_[a-z0-9]{8,32})#(cell\[(.*)\]|row=(\d+))$/;

export type RefTarget =
  | { artifactId: string; kind: "cell"; pairs: Array<[string, string]> }
  | { artifactId: string; kind: "row"; row: number };

function encode(value: unknown): string {
  return encodeURIComponent(cellText(value, Infinity));
}

/** Build the ref for one keyed point of the snapshot. */
export function cellRef(artifactId: string, key: Array<[string, unknown]>): string {
  const parts = key.map(([name, value]) => `${encodeURIComponent(name)}=${encode(value)}`);
  return `${artifactId}#cell[${parts.join(",")}]`;
}

export function rowRef(artifactId: string, index: number): string {
  return `${artifactId}#row=${index}`;
}

export function parseRef(ref: string): RefTarget | undefined {
  const match = REF_PATTERN.exec(ref.trim());
  if (!match) return undefined;
  const artifactId = match[1]!;
  if (match[2]!.startsWith("row=")) return { artifactId, kind: "row", row: Number(match[4]) };
  const pairs: Array<[string, string]> = [];
  for (const chunk of match[3]!.split(",")) {
    const index = chunk.indexOf("=");
    if (index <= 0) return undefined;
    try {
      pairs.push([decodeURIComponent(chunk.slice(0, index)), decodeURIComponent(chunk.slice(index + 1))]);
    } catch {
      return undefined;
    }
  }
  return { artifactId, kind: "cell", pairs };
}

export interface ResolvedRef {
  ref: string;
  value: unknown;
  /** Position in `data.rows`, or null when the ref names a cell with no data (a missing heatmap cell). */
  row_index: number | null;
  row: unknown[] | null;
  key: Record<string, unknown> | null;
}

/**
 * Resolve a ref against the snapshot. A missing heatmap combination resolves to `value: null`
 * instead of failing: "this cell was empty" is a legitimate answer, and hiding it would turn the
 * distinction the compiler reports as `missing` back into an error.
 */
export function resolveRef(ref: string, data: ArtifactData): ResolvedRef | undefined {
  const target = parseRef(ref);
  if (!target) return undefined;
  if (target.kind === "row") {
    const row = data.rows[target.row];
    if (!row) return undefined;
    const valueIndex = data.columns.findIndex((column) => column.role === "value");
    return { ref, value: row[valueIndex >= 0 ? valueIndex : data.columns.length - 1] ?? null, row_index: target.row, row, key: null };
  }

  // A partial or repeated key can match several rows and is not a stable citation.
  const names = target.pairs.map(([name]) => name);
  if (!data.row_key.length || names.length !== data.row_key.length ||
      new Set(names).size !== names.length || data.row_key.some((name) => !names.includes(name))) return undefined;
  const indexes = target.pairs.map(([name]) => {
    const index = data.columns.findIndex((column) => column.name === name);
    return index;
  });
  if (indexes.some((index) => index < 0)) return undefined;
  const key: Record<string, unknown> = {};
  for (const row of data.rows) {
    let match = true;
    for (let i = 0; i < target.pairs.length; i += 1) {
      const pair = target.pairs[i]!;
      const cell = row[indexes[i]!];
      if (cellText(cell, Infinity) !== pair[1]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    for (let i = 0; i < target.pairs.length; i += 1) key[target.pairs[i]![0]] = row[indexes[i]!];
    const valueIndex = data.columns.findIndex((column) => column.role === "value");
    return {
      ref,
      // Keep numeric/int8 strings exact; chart coordinates may use floating point, citations may not.
      value: valueIndex >= 0 ? row[valueIndex] ?? null : null,
      row_index: data.rows.indexOf(row),
      row,
      key,
    };
  }
  for (let i = 0; i < target.pairs.length; i += 1) key[target.pairs[i]![0]] = target.pairs[i]![1];
  return { ref, value: null, row_index: null, row: null, key };
}
