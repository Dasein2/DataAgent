import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import type { Server } from "node:http";
import { rm, readFile } from "node:fs/promises";
import { AnalysisService } from "../src/agent/service.js";
import { ResultStore } from "../src/results/store.js";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { createHttpApp } from "../src/api/http.js";
import { cleanup, testConfig } from "./support.js";
import { SnapshotStore } from "../src/analysis/snapshots.js";

it("retention purges only old non-live evidence and skips invalid timestamps", async () => {
  const config = await testConfig();
  config.analysis = { retentionDays: 1 };
  const results = new ResultStore(join(config.dataDir, "results"));
  const artifacts = new ArtifactService(new ArtifactStore(join(config.dataDir, "artifacts")), results, config.budgets);
  const service: AnalysisService = new (AnalysisService as any)(config, { hasAuth: true }, results, artifacts);
  try {
    for (const [id, at] of [
      ["sess_retentionold", "2000-01-01T00:00:00Z"],
      ["sess_retentionlive", "2000-01-01T00:00:00Z"],
      ["sess_retentionrecent", new Date().toISOString()],
      ["sess_retentioninvalid", "invalid"],
    ]) {
      service.history.saveSession("alice", { session_id: id, status: "closed", created_at: at });
    }
    const writer = await results.create({ sessionId: "sess_retentionold", sql: "SELECT 1", previewRows: 1 });
    writer.setColumns([{ name: "n", type: "int" }]);
    await writer.append([1]);
    const meta = await writer.finish("none", 1);
    const { artifact } = await artifacts.createChart({
      sessionId: meta.sessionId,
      spec: { result_id: meta.id, type: "table" },
    });
    const snapshots = new SnapshotStore(join(config.dataDir, "snapshots"));
    await snapshots.create(meta.sessionId, meta.id, "old");
    (service as any).sessions.set("sess_retentionlive", { expiresAt: new Date(Date.now() + 60000), isBusy: false });
    await (service as any).sweepExpired();
    assert.equal((service as any).sessions.has("sess_retentionlive"), true);
    (service as any).sessions.clear();
    assert.deepEqual(
      service
        .listSessions("alice")
        .map((s) => s.session_id)
        .sort(),
      ["sess_retentioninvalid", "sess_retentionlive", "sess_retentionrecent"],
    );
    assert.deepEqual(await results.listBySession(meta.sessionId), []);
    assert.equal(await artifacts.get(artifact.id), undefined);
    assert.deepEqual(await snapshots.list(meta.sessionId), []);
  } finally {
    (service as any).sessions.clear();
    await service.shutdown();
    await cleanup(config);
  }
});

it("catalog HTTP search modes keep legacy field search and offer lightweight interactive paths", async () => {
  const config = await testConfig();
  const service = await AnalysisService.create(config);
  const seen: Array<{ namesOnly?: boolean; searchColumns?: boolean; schema?: string }> = [];
  const scopes: boolean[] = [];
  const db = {
    catalogPage: async (filter: typeof seen[number]) => { seen.push(filter); return { objects: [], nextOffset: null }; },
    catalogScopes: async (_refresh: boolean, counts: boolean) => { scopes.push(counts); return { scopes: ["analytics"] }; },
  };
  const sessions = (service as any).sessions;
  sessions.set("sess_catalog", { ownerKey: "alice", db, touch() {} });
  const app = await createHttpApp(service);
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  const call = async (suffix: string, caller = "alice") => {
    const result = await fetch("http://127.0.0.1:" + port + "/v1/sessions/sess_catalog/catalog/" + suffix, {
      headers: { authorization: "Bearer test-token", "x-caller-id": caller },
    });
    await result.text();
    return result.status;
  };
  try {
    assert.equal(await call("objects?search=users&schema=analytics&match=names"), 200);
    assert.equal(await call("objects?search=users&match=objects"), 200);
    assert.equal(await call("objects?search=users"), 200);
    assert.equal(await call("objects?search=users&match=invalid"), 400);
    assert.equal(await call("objects?search=users&match=names", "bob"), 404);
    assert.deepEqual(seen.map(f => [f.namesOnly, f.searchColumns, f.schema]), [
      [true, false, "analytics"], [false, false, undefined], [false, true, undefined],
    ]);
    assert.equal(await call("scopes?counts=false"), 200);
    assert.equal(await call("scopes"), 200);
    assert.deepEqual(scopes, [false, true]);
  } finally {
    sessions.clear();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.shutdown();
    await cleanup(config);
  }
});

it(
  "analysis HTTP APIs preserve ownership, pagination, lineage, archive refs and export audit",
  { timeout: 30000 },
  async () => {
    const config = await testConfig();
    const results = new ResultStore(join(config.dataDir, "results"));
    const artifacts = new ArtifactService(
      new ArtifactStore(join(config.dataDir, "artifacts")),
      results,
      config.budgets,
    );
    const service: AnalysisService = new (AnalysisService as any)(config, { hasAuth: true }, results, artifacts);
    let server: Server | undefined;
    try {
      service.history.saveSession("alice", {
        session_id: "sess_analysisapi",
        status: "closed",
        created_at: new Date().toISOString(),
      });
      const w = await results.create({
        sessionId: "sess_analysisapi",
        sql: "SELECT category, amount FROM sales",
        previewRows: 2,
      });
      w.setColumns([
        { name: "category", type: "text" },
        { name: "amount", type: "numeric" },
      ]);
      for (let i = 0; i < 205; i++) await w.append([String(i), "1.20"]);
      const m = await w.finish("none", 1);
      const { artifact } = await artifacts.createChart({
        sessionId: m.sessionId,
        spec: { result_id: m.id, type: "table", title: "证据" },
      });
      const app = await createHttpApp(service);
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const port = (server.address() as any).port;
      const request = (path: string, owner = "alice", method = "GET", body?: any) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: "Bearer test-token",
            "x-caller-id": owner,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const page = await (await request(`/v1/results/${m.id}?offset=200&limit=100&columns=amount`)).json();
      assert.equal(page.rows.length, 5);
      assert.equal(page.columns.length, 1);
      assert.equal(page.nextOffset, null);
      assert.equal(page.sessionId, m.sessionId);
      assert.equal((await request(`/v1/results/${m.id}?columns=missing`)).status, 400);
      assert.equal((await request(`/v1/results/${m.id}/summary`)).status, 200);
      const transformed = await request(`/v1/results/${m.id}/transform`, "alice", "POST", {
        sql: "SELECT SUM(amount) AS total FROM data",
      });
      assert.equal(transformed.status, 200);
      const derived = (await transformed.json()).result;
      assert.equal(derived.preview[0][0], "246.00");
      assert.equal(derived.lineage.parent_result_id, m.id);
      const pin = await request(`/v1/sessions/${m.sessionId}/snapshots`, "alice", "POST", {
        result_id: m.id,
        name: "快照",
      });
      assert.equal(pin.status, 201);
      const snapshot = (await pin.json()).snapshot;
      assert.equal((await request(`/v1/sessions/${m.sessionId}/snapshots`)).status, 200);
      const snapshotQuery = await request(`/v1/sessions/${m.sessionId}/snapshots/${snapshot.id}/query`, "alice", "POST", {
        sql: "SELECT SUM(amount) AS total FROM data",
      });
      assert.equal(snapshotQuery.status, 200);
      const snapshotDerived = (await snapshotQuery.json()).result;
      assert.equal(snapshotDerived.preview[0][0], "246.00");
      assert.equal(snapshotDerived.lineage.parent_result_id, m.id);
      for (const [path, method, body] of [
        [`/v1/results/${m.id}/summary`, "GET", undefined],
        [`/v1/results/${m.id}/transform`, "POST", { sql: "SELECT * FROM data" }],
        [`/v1/sessions/${m.sessionId}/catalog`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/catalog/scopes`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/catalog/objects?schema=public`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/object?name=sales`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/datasets`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/snapshots/${snapshot.id}`, "DELETE", undefined],
        [`/v1/sessions/${m.sessionId}/snapshots/${snapshot.id}/query`, "POST", { sql: "SELECT COUNT(*) FROM data" }],
        [`/v1/sessions/${m.sessionId}/snapshots`, "GET", undefined],
        [`/v1/sessions/${m.sessionId}/snapshots`, "POST", { result_id: m.id, name: "stolen" }],
        [`/v1/artifacts/${artifact.id}/archive`, "POST", { archived: true }],
        [`/v1/artifacts/${artifact.id}/export-action`, "POST", { format: "png" }],
      ] as Array<[string, string, any]>)
        assert.equal((await request(path, "bob", method, body)).status, 404, path);
      assert.equal(
        (await request(`/v1/artifacts/${artifact.id}/archive`, "alice", "POST", { archived: true })).status,
        200,
      );
      assert.deepEqual(await service.listArtifacts(m.sessionId, "alice"), []);
      assert.equal((await service.getArtifact(artifact.id, "alice")).id, artifact.id);
      await rm(join(config.dataDir, "artifacts", "index", m.sessionId + ".json"));
      assert.deepEqual(await service.listArtifacts(m.sessionId, "alice"), []);
      assert.equal(
        (await request(`/v1/artifacts/${artifact.id}/export-action`, "alice", "POST", { format: "svg" })).status,
        200,
      );
      assert.match(await readFile(join(config.dataDir, "audit", "exports.ndjson"), "utf8"), /"format":"svg"/);
      assert.equal(
        (await request(`/v1/sessions/${m.sessionId}/snapshots/${snapshot.id}`, "alice", "DELETE")).status,
        204,
      );
      for (const path of ["/explore.js", "/charts.js", "/workbench.js", "/workbench.css"])
        assert.equal((await request(path)).status, 200);
      await service.deleteSession(m.sessionId, "alice");
      assert.deepEqual(await results.listBySession(m.sessionId), []);
      assert.equal((await request(`/v1/artifacts/${artifact.id}`)).status, 404);
      assert.equal((await request(`/v1/sessions/${m.sessionId}/snapshots`)).status, 404);
    } finally {
      server?.closeAllConnections();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      await service.shutdown();
      await cleanup(config);
    }
  },
);
