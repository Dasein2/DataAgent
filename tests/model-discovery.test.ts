import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelList } from "../src/agent/model-discovery.js";

test("normalizes model discovery lists without inventing capabilities", () => {
  assert.deepEqual(parseModelList({ data: [{ id: "beta" }, { id: "alpha", name: "Alpha" }, { id: "beta" }, null] }), [{ id: "alpha", name: "Alpha" }, { id: "beta" }]);
  assert.deepEqual(parseModelList({ models: [{ name: "models/gemini", displayName: "Gemini" }] }), [{ id: "gemini", name: "Gemini" }]);
  assert.deepEqual(parseModelList(["plain"]), [{ id: "plain" }]);
  assert.throws(() => parseModelList({ error: "not a list" }), /model list/);
});
