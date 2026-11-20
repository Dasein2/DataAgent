import assert from "node:assert/strict";
import { test } from "node:test";
import * as echarts from "echarts";
import { chartViewport } from "../web/charts.js";

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
