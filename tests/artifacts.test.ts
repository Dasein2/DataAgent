import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compileChart, specHash } from "../src/artifacts/charts.js";
import { csvCell, csvDocument, UTF8_BOM } from "../src/artifacts/csv.js";
import { cellRef, parseRef, resolveRef } from "../src/artifacts/refs.js";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ECHARTS_VERSION, type ArtifactData, type ChartSpec } from "../src/artifacts/types.js";
import { ResultStore } from "../src/results/store.js";
import type { BudgetConfig } from "../src/config.js";

/**
 * The chart layer's contract, tested without a model and without a browser: a spec plus rows must
 * either produce a byte-stable artifact or a specific, actionable error code.
 */

const LIMITS = { maxCells: 3_600, maxRows: 20_000 };
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOURS = Array.from({ length: 24 }, (_, hour) => `${hour}时`);

const columns = [
  { name: "weekday", type: "text" },
  { name: "hour", type: "text" },
  { name: "orders", type: "int8" },
];

function source(overrides: Partial<{ result_id: string; row_count: number; truncated: "none" | "rows" | "bytes" }> = {}) {
  return {
    result_id: overrides.result_id ?? "res_heatmap0001",
    sql: "SELECT weekday, hour, count(*) FROM orders GROUP BY 1, 2",
    session_id: "sess_1",
    executed_at: "2025-01-01T00:00:00.000Z",
    row_count: overrides.row_count ?? 0,
    truncated: overrides.truncated ?? ("none" as const),
  };
}

/** 7×24 grid with one deliberately missing cell; values are strings, like PG int8 comes back. */
function heatmapRows(): unknown[][] {
  const rows: unknown[][] = [];
  for (const weekday of WEEKDAYS) {
    for (const hour of HOURS) {
      if (weekday === "周日" && hour === "23时") continue;
      rows.push([weekday, hour, String(10 + rows.length)]);
    }
  }
  return rows;
}

function heatmapSpec(extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    result_id: "res_heatmap0001",
    type: "heatmap",
    title: "下单时段",
    x: { field: "hour", order: HOURS },
    y: { field: "weekday", order: WEEKDAYS },
    value: { field: "orders", format: "integer" },
    ...extra,
  };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

describe("chart compiler", () => {
  it("compiles a heatmap with explicit axis order and reports the missing cell as a gap", () => {
    const rows = heatmapRows();
    const out = compileChart({
      artifact_id: "art_heatmap0001",
      spec: heatmapSpec(),
      columns,
      rows,
      source: source({ row_count: rows.length }),
      limits: LIMITS,
    });
    assert.equal(out.summary.shape, "24×7");
    assert.equal(out.summary.cells, 167);
    assert.equal(out.summary.missing, 1);
    assert.match(out.summary.text, /heatmap 24×7 cells=167 missing=1/);
    // Values arrive as strings from PostgreSQL; the chart must still get numbers.
    assert.equal(out.summary.value_min, 10);
    assert.equal(out.summary.value_max, 176);

    const option = out.compiled.option as Record<string, any>;
    assert.deepEqual(option.xAxis.data, HOURS);
    assert.deepEqual(option.yAxis.data, WEEKDAYS);
    assert.equal(option.series[0].data.length, 167, "the missing cell is not drawn as a zero");
    assert.equal(out.compiled.engine_version, ECHARTS_VERSION);

    // The alias the model sees must be a real ref that resolves back to the row.
    const top = out.summary.top[0]!;
    assert.ok(top.ref.startsWith("art_heatmap0001#cell["));
    const resolved = resolveRef(top.ref, out.data);
    assert.equal(resolved?.value, String(top.value));

    // Snapshot columns carry roles, and rows are the long-format projection.
    assert.deepEqual(out.data.columns.map((column) => [column.name, column.role]), [
      ["hour", "x"],
      ["weekday", "y"],
      ["orders", "value"],
    ]);
    assert.equal(out.data.rows.length, 167);
    assert.deepEqual(out.data.row_key, ["hour", "weekday"]);
  });

  it("rejects a duplicated (x, y) pair instead of summing it silently", () => {
    const rows = [...heatmapRows(), ["周一", "1时", "999"]];
    assert.equal(
      errorCode(() =>
        compileChart({
          artifact_id: "art_dup00001",
          spec: heatmapSpec(),
          columns,
          rows,
          source: source({ row_count: rows.length }),
          limits: LIMITS,
        }),
      ),
      "CHART_DUPLICATE_CELL",
    );
  });

  it("refuses a non-numeric value column and says which values are wrong", () => {
    const rows = [["周一", "0时", "12 单"]];
    let message = "";
    try {
      compileChart({
        artifact_id: "art_textvalue",
        spec: heatmapSpec(),
        columns,
        rows,
        source: source({ row_count: 1 }),
        limits: LIMITS,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /not numeric/);
    assert.match(message, /12 单/);
  });

  it("names the available columns when a field does not exist", () => {
    let message = "";
    try {
      compileChart({
        artifact_id: "art_unknown1",
        spec: heatmapSpec({ value: { field: "amount" } }),
        columns,
        rows: heatmapRows(),
        source: source({ row_count: 168 }),
        limits: LIMITS,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /No column named "amount"/);
    assert.match(message, /weekday, hour, orders/);
  });

  it("refuses to chart a truncated result, because it would understate the data", () => {
    assert.equal(
      errorCode(() =>
        compileChart({
          artifact_id: "art_trunc001",
          spec: heatmapSpec(),
          columns,
          rows: heatmapRows(),
          source: source({ row_count: 168, truncated: "rows" }),
          limits: LIMITS,
        }),
      ),
      "CHART_RESULT_TRUNCATED",
    );
  });

  it("caps cells and suggests TopN or bucketing", () => {
    let message = "";
    try {
      compileChart({
        artifact_id: "art_toobig001",
        spec: heatmapSpec({ x: { field: "hour", order: HOURS }, y: { field: "weekday", order: WEEKDAYS } }),
        columns,
        rows: heatmapRows(),
        source: source({ row_count: 168 }),
        limits: { maxCells: 100, maxRows: 20_000 },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /TOP|top|ORDER BY/);
  });

  it("requires an explicit order for a two-dimensional categorical axis", () => {
    assert.equal(
      errorCode(() =>
        compileChart({
          artifact_id: "art_noorder1",
          spec: heatmapSpec({ y: { field: "weekday" } }),
          columns,
          rows: heatmapRows(),
          source: source({ row_count: 168 }),
          limits: LIMITS,
        }),
      ),
      "CHART_ORDER_REQUIRED",
    );
  });

  it("appends labels missing from the declared order instead of dropping their data", () => {
    const rows = [...heatmapRows(), ["节假日", "0时", "5"]];
    const out = compileChart({
      artifact_id: "art_extra001",
      spec: heatmapSpec(),
      columns,
      rows,
      source: source({ row_count: rows.length }),
      limits: LIMITS,
    });
    const option = out.compiled.option as Record<string, any>;
    assert.equal(option.yAxis.data.at(-1), "节假日");
    assert.ok(out.compiled.warnings.some((warning) => /absent from order/.test(warning)));
  });

  it("keeps SQL row order when no sort is requested, and never sorts strings implicitly", () => {
    const rows = [
      ["10", "9"],
      ["2", "4"],
    ];
    const out = compileChart({
      artifact_id: "art_order0001",
      spec: {
        result_id: "res_bar000001",
        type: "bar",
        x: { field: "label" },
        value: { field: "amount" },
      },
      columns: [
        { name: "label", type: "text" },
        { name: "amount", type: "int4" },
      ],
      rows,
      source: source({ result_id: "res_bar000001", row_count: 2 }),
      limits: LIMITS,
    });
    const option = out.compiled.option as Record<string, any>;
    assert.deepEqual(option.xAxis.data, ["10", "2"], "insertion order, not lexicographic");
  });

  it("sorts when asked, and rejects sort=numeric on non-numeric labels", () => {
    const out = compileChart({
      artifact_id: "art_numeric01",
      spec: {
        result_id: "res_bar000002",
        type: "line",
        x: { field: "label", sort: "numeric" },
        value: { field: "amount" },
      },
      columns: [
        { name: "label", type: "text" },
        { name: "amount", type: "int4" },
      ],
      rows: [["10", "1"], ["2", "2"]],
      source: source({ result_id: "res_bar000002", row_count: 2 }),
      limits: LIMITS,
    });
    assert.deepEqual((out.compiled.option as Record<string, any>).xAxis.data, ["2", "10"]);

    assert.equal(
      errorCode(() =>
        compileChart({
          artifact_id: "art_numeric02",
          spec: {
            result_id: "res_bar000003",
            type: "bar",
            x: { field: "label", sort: "numeric" },
            value: { field: "amount" },
          },
          columns: [
            { name: "label", type: "text" },
            { name: "amount", type: "int4" },
          ],
          rows: [["甲", "1"], ["2", "2"]],
          source: source({ result_id: "res_bar000003", row_count: 2 }),
          limits: LIMITS,
        }),
      ),
      "CHART_ORDER_REQUIRED",
    );
  });

  it("stores a bar chart's line alternate so switching figure type needs no model call", () => {
    const rows = [
      ["2025-01", "华东", 10],
      ["2025-01", "华北", 7],
      ["2025-02", "华东", 12],
      ["2025-02", "华北", 9],
    ];
    const out = compileChart({
      artifact_id: "art_series001",
      spec: {
        result_id: "res_series001",
        type: "bar",
        x: { field: "month" },
        series: { field: "region" },
        value: { field: "amount" },
      },
      columns: [
        { name: "month", type: "text" },
        { name: "region", type: "text" },
        { name: "amount", type: "int4" },
      ],
      rows,
      source: source({ result_id: "res_series001", row_count: 4 }),
      limits: LIMITS,
    });
    assert.equal(out.alternates.length, 1);
    assert.equal(out.alternates[0]!.type, "line");
    const bar = out.compiled.option as Record<string, any>;
    const line = out.alternates[0]!.option as Record<string, any>;
    assert.equal(bar.series[0].type, "bar");
    assert.equal(line.series[0].type, "line");
    assert.deepEqual(bar.xAxis.data, line.xAxis.data);
    assert.equal(out.data.row_key.length, 2);
    // A snapshot is written to disk as JSON: undefined must not survive, or two identical specs
    // would serialise differently.
    assert.ok(!JSON.stringify(out.compiled).includes("undefined"));
  });

  it("brings a result with more rows than the cap to a stop before drawing anything", () => {
    assert.equal(
      errorCode(() =>
        compileChart({
          artifact_id: "art_toomany1",
          spec: heatmapSpec(),
          columns,
          rows: heatmapRows(),
          source: source({ row_count: 168 }),
          limits: { maxCells: 3_600, maxRows: 10 },
        }),
      ),
      "CHART_TOO_MANY_ROWS",
    );
  });

  it("hashes specs deterministically, ignoring key order", () => {
    const a: ChartSpec = { result_id: "r", type: "bar", x: { field: "a" }, value: { field: "b" } };
    const b: ChartSpec = { value: { field: "b" }, x: { field: "a" }, type: "bar", result_id: "r" };
    assert.equal(specHash(a), specHash(b));
    assert.notEqual(specHash(a), specHash({ ...a, type: "line" }));
  });
});

describe("artifact refs", () => {
  const data: ArtifactData = {
    columns: [
      { name: "hour", type: "text", role: "x" },
      { name: "weekday", type: "text", role: "y" },
      { name: "orders", type: "int8", role: "value" },
    ],
    row_key: ["hour", "weekday"],
    rows: [
      ["20时", "周五", "1284"],
      ["21时", "周五", "998"],
    ],
  };

  it("round-trips a cell ref through percent-encoding, including non-ASCII labels", () => {
    const ref = cellRef("art_abcdefabcdef", [
      ["hour", "20时"],
      ["weekday", "周五"],
    ]);
    assert.match(ref, /^art_abcdefabcdef#cell\[/);
    const target = parseRef(ref);
    assert.equal(target?.kind, "cell");
    const resolved = resolveRef(ref, data);
    assert.equal(resolved?.value, "1284");
    assert.deepEqual(resolved?.row, ["20时", "周五", "1284"]);
  });

  it("resolves a missing heatmap combination to null rather than failing", () => {
    const ref = cellRef("art_abcdefabcdef", [
      ["hour", "23时"],
      ["weekday", "周日"],
    ]);
    const resolved = resolveRef(ref, data);
    assert.equal(resolved?.value, null);
    assert.equal(resolved?.row, null);
  });

  it("rejects incomplete or repeated keys and preserves large numeric values", () => {
    assert.equal(resolveRef(cellRef("art_abcdefabcdef", [["hour", "20时"]]), data), undefined);
    assert.equal(resolveRef(cellRef("art_abcdefabcdef", [["hour", "20时"], ["hour", "20时"]]), data), undefined);
    const exact = { ...data, rows: [["20时", "周五", "9007199254740993.0001"]] };
    assert.equal(resolveRef(cellRef("art_abcdefabcdef", [["hour", "20时"], ["weekday", "周五"]]), exact)?.value, "9007199254740993.0001");
  });

  it("parses artifact identity and rejects malformed syntax", () => {
    const ref = cellRef("art_otherother", [["hour", "20时"]]);
    assert.equal(parseRef(ref)?.artifactId, "art_otherother");
    assert.equal(resolveRef("not-a-ref", data), undefined);
  });
});

describe("csv export", () => {
  it("neutralises formula injection in text but leaves numbers alone", () => {
    assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
    assert.equal(csvCell("@SUM(1)"), "'@SUM(1)");
    assert.equal(csvCell(-12.5), "-12.5");
    assert.equal(csvCell("-12 apples"), "'-12 apples");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell({ __type: "text", preview: "long…", chars: 99 }), "long…");
  });

  it("emits a BOM and CRLF so Excel opens Chinese text correctly", () => {
    const body = csvDocument(["名称", "值"], [["华东", 1], ['含"引号', null]]);
    assert.ok(body.startsWith(UTF8_BOM));
    assert.ok(body.includes("\r\n"));
    assert.ok(body.includes('"含""引号"'));
  });
});

describe("artifact store and service", () => {
  async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "data-agent-artifacts-"));
  }

  async function writtenResult(results: ResultStore, rows: unknown[][], truncated: "none" | "rows" = "none") {
    const writer = await results.create({ sessionId: "sess_1", sql: "SELECT weekday, hour, orders", previewRows: 5, taskId: "task_1" });
    writer.setColumns(columns);
    for (const row of rows) await writer.append(row);
    return writer.finish(truncated, 4);
  }

  it("creates an artifact once per (result, spec) and lists it by session", async () => {
    const root = await tempDir();
    const results = new ResultStore(join(root, "results"));
    const service = new ArtifactService(
      new ArtifactStore(join(root, "artifacts")),
      results,
      { maxChartRows: 1_000, maxChartCells: 3_600, maxArtifactsPerTask: 5 } as BudgetConfig,
    );
    const meta = await writtenResult(results, heatmapRows());
    const first = await service.createChart({ sessionId: "sess_1", taskId: "task_1", spec: heatmapSpec({ result_id: meta.id }) });
    assert.equal(first.reused, false);
    const second = await service.createChart({ sessionId: "sess_1", taskId: "task_1", spec: heatmapSpec({ result_id: meta.id }) });
    assert.equal(second.reused, true);
    assert.equal(second.artifact.id, first.artifact.id);

    const list = await service.listBySession("sess_1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, first.artifact.id);
    assert.equal(list[0]!.task_id, "task_1");

    // Ownership is enforced per artifact, not just per session listing.
    assert.equal(await service.ownedBy(first.artifact.id, "sess_2").catch((error) => error.code), "FORBIDDEN");
    const csv = service.csv(first.artifact);
    assert.match(csv.filename, new RegExp(`^${first.artifact.id}`));
    assert.ok(csv.body.startsWith(UTF8_BOM));
    assert.equal(csv.body.trim().split("\r\n").length, 168);
  });

  it("enforces the per-task artifact cap", async () => {
    const root = await tempDir();
    const results = new ResultStore(join(root, "results"));
    const service = new ArtifactService(
      new ArtifactStore(join(root, "artifacts")),
      results,
      { maxChartRows: 1_000, maxChartCells: 3_600, maxArtifactsPerTask: 1 } as BudgetConfig,
    );
    const meta = await writtenResult(results, heatmapRows());
    await service.createChart({ sessionId: "sess_1", taskId: "task_1", spec: heatmapSpec({ result_id: meta.id }) });
    const error = await service
      .createChart({ sessionId: "sess_1", taskId: "task_1", spec: heatmapSpec({ result_id: meta.id, title: "另一个" }) })
      .catch((caught) => caught);
    assert.equal(error.code, "ARTIFACT_LIMIT_REACHED");
  });

  it("refuses a result owned by another session", async () => {
    const root = await tempDir();
    const results = new ResultStore(join(root, "results"));
    const service = new ArtifactService(
      new ArtifactStore(join(root, "artifacts")),
      results,
      { maxChartRows: 1_000, maxChartCells: 3_600, maxArtifactsPerTask: 5 } as BudgetConfig,
    );
    const meta = await writtenResult(results, heatmapRows());
    const error = await service
      .createChart({ sessionId: "sess_2", spec: heatmapSpec({ result_id: meta.id }) })
      .catch((caught) => caught);
    assert.equal(error.code, "FORBIDDEN");
  });

  it("rejects a truncated result and an unknown result id", async () => {
    const root = await tempDir();
    const results = new ResultStore(join(root, "results"));
    const service = new ArtifactService(
      new ArtifactStore(join(root, "artifacts")),
      results,
      { maxChartRows: 1_000, maxChartCells: 3_600, maxArtifactsPerTask: 5 } as BudgetConfig,
    );
    const meta = await writtenResult(results, heatmapRows(), "rows");
    const truncated = await service
      .createChart({ sessionId: "sess_1", spec: heatmapSpec({ result_id: meta.id }) })
      .catch((caught) => caught);
    assert.equal(truncated.code, "CHART_RESULT_TRUNCATED");

    const missing = await service
      .createChart({ sessionId: "sess_1", spec: heatmapSpec({ result_id: "res_missing01" }) })
      .catch((caught) => caught);
    assert.equal(missing.code, "RESULT_NOT_FOUND");
  });

  it("rebuilds a lost index from the objects on disk", async () => {
    const root = await tempDir();
    const store = new ArtifactStore(join(root, "artifacts"));
    const results = new ResultStore(join(root, "results"));
    const service = new ArtifactService(store, results, {
      maxChartRows: 1_000,
      maxChartCells: 3_600,
      maxArtifactsPerTask: 5,
    } as BudgetConfig);
    const meta = await writtenResult(results, heatmapRows());
    const { artifact } = await service.createChart({ sessionId: "sess_1", spec: heatmapSpec({ result_id: meta.id }) });
    await rm(join(root, "artifacts", "index", "sess_1.json"));
    assert.deepEqual((await store.listBySession("sess_1")).map((entry) => entry.id), [artifact.id]);
    const rebuilt = await store.rebuildIndex("sess_1");
    assert.deepEqual(rebuilt.map((entry) => entry.id), [artifact.id]);
    const before = await store.get(artifact.id);
    await assert.rejects(() => store.save({ ...artifact, spec: { ...artifact.spec, title: "changed" } }));
    assert.deepEqual(await store.get(artifact.id), before, "an existing artifact must not be overwritten");
  });
});
