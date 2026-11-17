import { randomUUID } from "node:crypto";
import type { BudgetConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ResultStore } from "../results/store.js";
import { compileChart, specHash } from "./charts.js";
import { csvDocument } from "./csv.js";
import { resolveRef, type ResolvedRef } from "./refs.js";
import { ArtifactStore } from "./store.js";
import type { Artifact, ChartSpec } from "./types.js";

/**
 * Turns a chart spec plus a stored result into an immutable artifact.
 *
 * Ownership is *not* checked here: artifacts outlive sessions, so the caller (the analysis service or
 * the HTTP layer) proves the caller owns the session before asking. Keeping that split means a closed
 * session can still render its charts.
 */
export class ArtifactService {
  constructor(
    readonly store: ArtifactStore,
    private readonly results: ResultStore,
    private readonly budgets: BudgetConfig,
  ) {}

  async createChart(options: {
    sessionId: string;
    taskId?: string;
    spec: ChartSpec;
  }): Promise<{ artifact: Artifact; reused: boolean }> {
    const { sessionId, taskId, spec } = options;
    if (!spec || typeof spec !== "object") {
      throw new AppError("CHART_SPEC_INVALID", "A chart spec object is required");
    }
    if (!spec.result_id || typeof spec.result_id !== "string") {
      throw new AppError("CHART_SPEC_INVALID", "result_id is required: run query_execute first and chart its result");
    }

    const meta = await this.results.get(spec.result_id);
    if (!meta) throw new AppError("RESULT_NOT_FOUND", `Result ${spec.result_id} was not found`);
    if (meta.sessionId !== sessionId) throw new AppError("FORBIDDEN", "Result belongs to another session");
    if (meta.error) throw new AppError("CHART_SPEC_INVALID", `Result ${meta.id} did not complete: ${meta.error}`);

    // Same result + same spec is the same chart: a retried tool call must not create a second copy.
    const hash = specHash(spec);
    const existing = await this.store.findBySpec(sessionId, hash, spec.result_id);
    if (existing) {
      const artifact = await this.store.get(existing.id);
      if (artifact) return { artifact, reused: true };
    }

    if (this.budgets.maxArtifactsPerTask > 0 && taskId) {
      const used = await this.store.countByTask(sessionId, taskId);
      if (used >= this.budgets.maxArtifactsPerTask) {
        throw new AppError(
          "ARTIFACT_LIMIT_REACHED",
          `This task already produced ${used} artifacts (limit ${this.budgets.maxArtifactsPerTask}). ` +
            "Reuse an existing chart or ask one consolidated question instead of many small ones.",
          { limit: this.budgets.maxArtifactsPerTask },
        );
      }
    }

    const rows = await this.readRows(meta.rowCount, meta.id);
    const source = {
      result_id: meta.id,
      sql: meta.sql,
      session_id: meta.sessionId,
      task_id: taskId ?? meta.taskId,
      executed_at: meta.createdAt,
      row_count: meta.rowCount,
      truncated: meta.truncated,
    };

    const id = `art_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const compiled = compileChart({
      artifact_id: id,
      spec,
      columns: meta.columns,
      rows,
      source,
      limits: { maxCells: this.budgets.maxChartCells, maxRows: this.budgets.maxChartRows },
    });

    const artifact: Artifact = {
      id,
      session_id: sessionId,
      task_id: taskId,
      kind: "chart",
      status: "ready",
      spec,
      spec_version: compiled.compiled.spec_version,
      spec_hash: compiled.spec_hash,
      data: compiled.data,
      compiled: compiled.compiled,
      alternates: compiled.alternates,
      summary: compiled.summary,
      source,
      created_at: new Date().toISOString(),
    };
    await this.store.save(artifact);
    return { artifact, reused: false };
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.store.get(id);
  }

  async listBySession(sessionId: string) {
    return this.store.listBySession(sessionId);
  }

  /** Load an artifact and re-check it belongs to a session the caller can see. */
  async ownedBy(id: string, sessionId: string): Promise<Artifact> {
    const artifact = await this.store.get(id);
    if (!artifact) throw new AppError("ARTIFACT_NOT_FOUND", `Artifact ${id} was not found`);
    if (artifact.session_id !== sessionId) throw new AppError("FORBIDDEN", "Artifact belongs to another session");
    return artifact;
  }

  resolve(ref: string, artifact: Artifact): ResolvedRef | undefined {
    if (!artifact.data) return undefined;
    if (!ref.startsWith(`${artifact.id}#`)) {
      throw new AppError(
        "INVALID_INPUT",
        `Ref ${ref} does not belong to artifact ${artifact.id}`,
      );
    }
    return resolveRef(ref, artifact.data);
  }

  /** CSV of the snapshot, not of the original result: the artifact is the durable, complete object. */
  csv(artifact: Artifact): { filename: string; body: string } {
    if (!artifact.data) throw new AppError("ARTIFACT_FAILED", `Artifact ${artifact.id} has no data snapshot`);
    const header = artifact.data.columns.map((column) => column.name);
    const body = csvDocument(header, artifact.data.rows);
    const slug = (artifact.spec.title ?? artifact.spec.type)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return { filename: `${artifact.id}${slug ? `-${slug}` : ""}.csv`, body };
  }

  /**
   * Read at most `maxChartRows` rows. Reading is capped on purpose: the chart layer never aggregates,
   * so a result bigger than the cap is a spec problem, and loading a million rows to say so would be
   * wasteful.
   */
  private async readRows(rowCount: number, resultId: string): Promise<unknown[][]> {
    if (rowCount > this.budgets.maxChartRows) {
      throw new AppError(
        "CHART_TOO_MANY_ROWS",
        `Result ${resultId} has ${rowCount} rows, above the ${this.budgets.maxChartRows} row chart limit. ` +
          "GROUP BY the axes in SQL so the result already has one row per chart point.",
        { result_id: resultId, rows: rowCount, limit: this.budgets.maxChartRows },
      );
    }
    const rows: unknown[][] = [];
    for await (const row of this.results.iterateRows(resultId)) {
      if (rows.length >= this.budgets.maxChartRows) {
        throw new AppError("CHART_TOO_MANY_ROWS", "Stored rows exceed the chart row limit");
      }
      rows.push(row);
    }
    return rows;
  }
}
