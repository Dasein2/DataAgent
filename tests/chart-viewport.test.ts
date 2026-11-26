import assert from "node:assert/strict";
import { test } from "node:test";
import * as echarts from "echarts";
import { chartViewport, heatmapDisplay } from "../web/charts.js";
import { businessTrendOption } from "../web/business-report.js";

const paymentDays = Array.from({ length: 10 }, (_, i) => ({ day: `2026-11-${i + 11}`, current: i < 8 ? null : { value: { value: i === 8 ? "450" : "360" } }, comparison: null }));

test("business trend exports a static selected view with zoom on desktop and mobile", () => {
  const days = paymentDays;
  for (const width of [950, 340]) {
    for (const type of ["bar", "line"]) {
      const option = businessTrendOption({ days, type, index: 9, comparison: false, zoom: { start: 77, end: 100 }, animation: false });
      assert.deepEqual(option.series[0]!.markPoint!.data[0]!.coord, ["2026-11-20", 360]);
      assert.deepEqual(option.series[0]!.data.slice(-2), [450, 360]);
      assert.deepEqual(option.dataZoom.map(z => [z.start, z.end]), [[77, 100], [77, 100]]);
      const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width, height: 240 });
      try {
        chart.setOption(option as echarts.EChartsOption);
        const svg = chart.renderToSVGString();
        assert.match(svg, /11-19/); assert.match(svg, /11-20/); assert.match(svg, /#256e64/);
        assert.match(svg, /本期/); assert.doesNotMatch(svg, /@keyframes/);
      } finally { chart.dispose(); }
    }
  }
});

test("a full business trend update keeps the zoom and data across series type changes", () => {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 760, height: 275 });
  try {
    const option = (type: string, zoom?: { start: number; end: number }) => businessTrendOption({ days: paymentDays, type, index: 9, comparison: false, zoom, animation: false });
    chart.setOption(option("line") as echarts.EChartsOption);
    chart.dispatchAction({ type: "dataZoom", start: 84, end: 100 });
    for (const type of ["bar", "line"]) {
      const [zoom] = chart.getOption().dataZoom as { start: number; end: number }[];
      assert.deepEqual([zoom!.start, zoom!.end], [84, 100]);
      chart.setOption(option(type, { start: zoom!.start, end: zoom!.end }) as echarts.EChartsOption, true);
      const [series] = chart.getOption().series as { type: string; data: unknown[] }[];
      assert.equal(series!.type, type);
      assert.deepEqual(series!.data.slice(-2), [450, 360]);
      const svg = chart.renderToSVGString();
      assert.match(svg, />11-19<\/text>/);
      assert.match(svg, />11-20<\/text>/);
      assert.doesNotMatch(svg, />11-11<\/text>/);
    }
  } finally { chart.dispose(); }
});

const grid = { left: 64, right: 32, top: 24, bottom: 32, containLabel: true };
const labels = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

function bar(count: number) {
  return {
    animation: false,
    grid,
    xAxis: { type: "category", data: labels("C", count) },
    yAxis: { type: "value" },
    series: [{ type: "bar", data: Array.from({ length: count }, (_, i) => (i + 1) * 10) }],
  };
}

function heatmap(xCount: number, yCount: number) {
  const x = labels("X", xCount);
  const y = labels("Y", yCount);
  return {
    animation: false,
    grid: { ...grid, bottom: 80 },
    xAxis: { type: "category", data: x },
    yAxis: [{ type: "category", data: y }],
    visualMap: { min: 0, max: 3600, bottom: 8 },
    series: [{ type: "heatmap", data: y.flatMap((_, j) => x.map((_, i) => [i, j, i * j])) }],
  };
}

test("axis sliders are only added where the chart's available space requires them", () => {
  const small = bar(10);
  assert.equal(chartViewport(small, 900, 300), small);
  assert.deepEqual(chartViewport(small, 400, 300).dataZoom.map((z) => z.id), ["viewport-xAxis"]);
  const yOnly = heatmap(3, 40);
  const yView = chartViewport(yOnly, 700, 460);
  assert.deepEqual(yView.dataZoom.map((z) => z.id), ["viewport-yAxis"]);
  assert.equal(yView.grid.bottom, yOnly.grid.bottom);
  assert.ok(yView.grid.right > yOnly.grid.right);
  assert.deepEqual(chartViewport(heatmap(7, 40), 500, 460).dataZoom.map((z) => z.id), [
    "viewport-xAxis", "viewport-yAxis",
  ]);
  const optionsWithoutAxes = { series: [{ type: "pie", data: [1, 2, 3] }] };
  assert.equal(chartViewport(optionsWithoutAxes, 400, 300), optionsWithoutAxes);
});

test("the ECharts viewport independently pans both heatmap axes without dropping cells", () => {
  const saved = heatmap(25, 30);
  const original = structuredClone(saved);
  const view = chartViewport(saved, 600, 460);
  const [x, y] = view.dataZoom;
  assert.equal(x.xAxisIndex, 0);
  assert.equal(y.yAxisIndex, 0);
  assert.ok(x.bottom > saved.visualMap.bottom);
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 460 });
  try {
    chart.setOption(structuredClone(view));
    const initial = chart.renderToSVGString();
    assert.match(initial, />X0<\/text>/);
    assert.match(initial, />Y0<\/text>/);
    assert.doesNotMatch(initial, />X24<\/text>|>Y29<\/text>/);
    chart.dispatchAction({ type: "dataZoom", dataZoomId: x.id, start: 75, end: 100 });
    const horizontal = chart.renderToSVGString();
    assert.match(horizontal, />X24<\/text>/);
    assert.match(horizontal, />Y0<\/text>/);
    chart.dispatchAction({ type: "dataZoom", dataZoomId: y.id, start: 70, end: 100 });
    const both = chart.renderToSVGString();
    assert.match(both, />X24<\/text>/);
    assert.match(both, />Y29<\/text>/);
    assert.doesNotMatch(both, />X0<\/text>|>Y0<\/text>/);
    assert.deepEqual(chart.getOption().series[0].data, original.series[0].data);
    assert.deepEqual(saved, original);
  } finally {
    chart.dispose();
  }
});

test("an expanded historical heatmap renders all 30 dates and 34 characters with optional numbers", () => {
  const option = heatmap(30, 34);
  const saved = { ...option, series: [{ ...option.series[0]!, label: { show: false } }] };
  saved.series[0]!.data[0] = [0, 0, 961];
  saved.series[0]!.data[1019] = [29, 33, 487];
  const original = structuredClone(saved);
  const compact = chartViewport(heatmapDisplay(saved, { showValues: true }).option, 400, 460);
  assert.equal(compact.dataZoom.length, 2);
  const expanded = heatmapDisplay(compact, { full: true, showValues: true });
  assert.equal(expanded.option.dataZoom, undefined);
  assert.ok(expanded.width > 1400 && expanded.height > 900);
  assert.deepEqual(expanded.option.series[0].data, saved.series[0]!.data);
  assert.deepEqual(expanded.option.visualMap, saved.visualMap);
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: expanded.width, height: expanded.height });
  try {
    chart.setOption(structuredClone(expanded.option), true);
    const visible = chart.renderToSVGString();
    for (const name of [...labels("X", 30), ...labels("Y", 34)]) assert.ok(visible.includes(`>${name}</text>`), name);
    assert.match(visible, />961<\/text>/);
    assert.match(visible, />487<\/text>/);
    assert.match(visible, />0<\/text>/, "zero-valued cells remain labeled");
    chart.setOption(heatmapDisplay(saved, { full: true, showValues: false }).option, true);
    const hidden = chart.renderToSVGString();
    assert.doesNotMatch(hidden, />961<\/text>|>487<\/text>/);
    assert.match(hidden, />Y33<\/text>/);
    assert.deepEqual(saved, original);
  } finally { chart.dispose(); }
});

test("a bar viewport keeps the value scale while a dense scatter exposes both value sliders", () => {
  const saved = bar(50);
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
  try {
    chart.setOption(chartViewport(saved, 600, 300));
    const scale = chart.getModel().getComponent("yAxis").axis.scale.getExtent();
    chart.dispatchAction({ type: "dataZoom", dataZoomId: "viewport-xAxis", start: 80, end: 100 });
    assert.deepEqual(chart.getModel().getComponent("yAxis").axis.scale.getExtent(), scale);
  } finally {
    chart.dispose();
  }
  const scatter = (count: number) => ({
    grid,
    xAxis: { type: "value" },
    yAxis: { type: "value" },
    series: [{ type: "scatter", data: Array.from({ length: count }, (_, i) => [i, i * 2]) }],
  });
  const sparse = scatter(5);
  assert.equal(chartViewport(sparse, 600, 300), sparse);
  assert.deepEqual(chartViewport(scatter(150), 600, 300).dataZoom.map(({ id, start, end }) => [id, start, end]), [
    ["viewport-xAxis", 0, 100],
    ["viewport-yAxis", 0, 100],
  ]);
});
