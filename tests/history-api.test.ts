import assert from "node:assert/strict";
import { it } from "node:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { HistoryStore, connectionKey } from "../src/agent/history.js";
import { EventBroker } from "../src/agent/events.js";
import { AnalysisService } from "../src/agent/service.js";
import { ResultStore } from "../src/results/store.js";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { rowRef } from "../src/artifacts/refs.js";
import { ProfileStore } from "../src/db/profiles-store.js";
import { ConnectionConfig } from "../src/db/types.js";
import { createHttpApp } from "../src/api/http.js";
import type { TaskRecord } from "../src/agent/runtime.js";
import { cleanup, testConfig } from "./support.js";

const connection = ConnectionConfig.parse({ engine: "postgres", host: "localhost", port: 5432,
  database: "fixture", user: "analyst", password: "db-secret-123", environment: "non_production",
  ssh: { hops: [{ host: "jump", username: "jump-user", auth: { method: "password", password: "ssh-secret-456" } }] } });
const task = (status: TaskRecord["status"] = "succeeded"): TaskRecord => ({ id: "task_test1234", session_id: "sess_test1234",
  goal: "count rows", status, created_at: new Date().toISOString(), turns: 1, queries_used: 1, results: [], answer: "12 rows" });
function seed(history: HistoryStore, status: TaskRecord["status"] = "succeeded") {
  history.saveSession("alice", { session_id: "sess_test1234", status: "ready", current_task_id: "task_test1234", queued_tasks: 1 }, connectionKey(connection));
  history.saveTask("alice", task(status));
}

for (const status of ["queued", "running"] as const) {
  it(`marks a persisted ${status} task incomplete on restart and repairs terminal events`, async () => {
    const app = await testConfig();
    try {
      const path = join(app.dataDir, "history");
      const first = new HistoryStore(path); seed(first, status);
      const broker = new EventBroker(5_000, first);
      broker.publish(task().id, "task_started"); broker.publish(task().id, "message_delta", { text: "partial" });
      appendFileSync(join(path, "events", `${task().id}.ndjson`), '{"seq":3,"incomplete":');
      const second = new HistoryStore(path);
      const record = second.getTask(task().id, "alice");
      assert.equal(record.status, "incomplete"); assert.equal(record.error?.code, "SERVICE_RESTARTED");
      assert.equal(record.answer, "partial");
      const snapshot = second.getSession(record.session_id, "alice").snapshot;
      assert.equal(snapshot.status, "disconnected"); assert.equal(snapshot.current_task_id, null);
      assert.equal(snapshot.tasks[0].status, "incomplete");
      const events = second.listEvents(record.id);
      assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]); assert.equal(events[2]?.type, "task_finished");
      assert.equal(new EventBroker(5_000, second).publish(record.id, "notice").seq, 4);
      assert.equal(new HistoryStore(path).listEvents(record.id).filter((e) => e.type === "task_finished").length, 1);
      assert.throws(() => second.getSession(record.session_id, "bob"), /not found/);
      assert.throws(() => second.getTask(record.id, "bob"), /not found/);
    } finally { await cleanup(app); }
  });
}

it("heals a saved terminal task with a missing final event and preserves a complete last line", async () => {
  const app = await testConfig();
  try {
    const path = join(app.dataDir, "history"); const history = new HistoryStore(path); seed(history);
    new EventBroker(5_000, history).publish(task().id, "task_started");
    const file = join(path, "events", `${task().id}.ndjson`);
    writeFileSync(file, readFileSync(file, "utf8").trimEnd());
    const reopened = new HistoryStore(path);
    assert.equal(reopened.getTask(task().id, "alice").status, "succeeded");
    assert.equal(reopened.listEvents(task().id).at(-1)?.type, "task_finished");
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  } finally { await cleanup(app); }
});

it("does not silently replace corrupt ownership history or connection profiles", async () => {
  const app = await testConfig();
  try {
    const path = join(app.dataDir, "history"); const history = new HistoryStore(path); seed(history);
    writeFileSync(join(path, "sessions", "sess_test1234.json"), "broken");
    assert.throws(() => new HistoryStore(path));
    const file = join(app.dataDir, "connections.json"); writeFileSync(file, "broken");
    assert.throws(() => new ProfileStore(file)); assert.equal(readFileSync(file, "utf8"), "broken");
  } finally { await cleanup(app); }
});

it("encrypts opted-in profile secrets across restart, isolates callers and clears on opt-out", async () => {
  const app = await testConfig();
  try {
    const file = join(app.dataDir, "connections.json"); const store = new ProfileStore(file, "test-stable-key");
    const view = store.save("alice", "fixture", connection, true);
    assert.equal(view.hasSecret, true);
    for (const value of ["db-secret-123", "ssh-secret-456"]) {
      assert.ok(!JSON.stringify(view).includes(value)); assert.ok(!readFileSync(file, "utf8").includes(value));
    }
    const reopened = new ProfileStore(file, "test-stable-key");
    assert.deepEqual(reopened.reveal("alice", "fixture"), connection);
    assert.equal(reopened.list("bob").length, 0); assert.throws(() => reopened.reveal("bob", "fixture"), /not found/);
    assert.throws(() => new ProfileStore(file, "wrong-key").reveal("alice", "fixture"), /cannot be decrypted/);
    view.config.host = "changed";
    const exposed = reopened.reveal("alice", "fixture") as any; exposed.ssh.hops[0].auth.password = "override";
    assert.equal((reopened.reveal("alice", "fixture") as any).ssh.hops[0].auth.password, "ssh-secret-456");
    reopened.save("alice", "fixture", connection, false);
    assert.equal(new ProfileStore(file, "test-stable-key").get("alice", "fixture")?.hasSecret, false);
    assert.equal(reopened.reveal("alice", "fixture").password, "");
    assert.throws(() => new ProfileStore(join(app.dataDir, "no-key.json")).save("alice", "fixture", connection, true), /cannot store/);
  } finally { await cleanup(app); }
});

it("serves historical results/tasks/events and server profiles over HTTP after restart with ownership", async () => {
  const config = await testConfig(); config.profileSecretKey = "test-key";
  let server: Server | undefined; let service: AnalysisService | undefined;
  try {
    const results = new ResultStore(join(config.dataDir, "results"));
    const artifacts = new ArtifactService(new ArtifactStore(join(config.dataDir, "artifacts")), results, config.budgets);
    const first: AnalysisService = new (AnalysisService as any)(config, { hasAuth: true }, results, artifacts);
    seed(first.history); first.history.saveSession("alice", { session_id: task().session_id, status: "closed" });
    const writer = await results.create({ sessionId: task().session_id, taskId: task().id, sql: "SELECT 12", previewRows: 2 });
    writer.setColumns([{ name: "count", type: "int" }]); await writer.append([12]); const meta = await writer.finish("none", 1);
    const { artifact } = await artifacts.createChart({ sessionId: task().session_id, taskId: task().id,
      spec: { result_id: meta.id, type: "table", title: "计数" } });
    const partialWriter = await results.create({ sessionId: task().session_id, sql: "SELECT label", previewRows: 1 });
    partialWriter.setColumns([{ name: "label", type: "text" }]);
    await partialWriter.append(["=SUM(A1)"]);
    await partialWriter.append(["x".repeat(9000)]);
    const partial = await partialWriter.finish("rows", 1);
    const failed = await results.create({ sessionId: task().session_id, sql: "SELECT * FROM missing", previewRows: 2 });
    const failedMeta = await failed.abort("table missing does not exist");
    await first.shutdown();
    const restartedResults = new ResultStore(join(config.dataDir, "results"));
    service = new (AnalysisService as any)(config, { hasAuth: true }, restartedResults,
      new ArtifactService(new ArtifactStore(join(config.dataDir, "artifacts")), restartedResults, config.budgets));
    const web = await createHttpApp(service!);
    server = await new Promise<Server>((resolve) => { const s = web.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server.address() as any).port;
    const request = (path: string, owner = "alice", init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, headers: { authorization: "Bearer test-token", "x-caller-id": owner, "content-type": "application/json", ...init.headers },
    });
    assert.equal((await (await request(`/v1/results/${meta.id}`)).json()).rows[0][0], 12);
    const stored = await request(`/v1/artifacts/${artifact.id}`);
    assert.equal(stored.status, 200);
    assert.deepEqual((await stored.json()).artifact, artifact);
    const listed = await (await request(`/v1/sessions/${task().session_id}/artifacts`)).json();
    assert.equal(listed.artifacts[0].id, artifact.id);
    const refPath = `/v1/artifacts/${artifact.id}/ref?ref=${encodeURIComponent(rowRef(artifact.id, 0))}`;
    const resolved = await (await request(refPath)).json();
    assert.equal(resolved.value, 12);
    assert.equal(resolved.source.sql, "SELECT 12");
    const csv = await request(`/v1/artifacts/${artifact.id}/data.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-disposition")!, /filename\*=UTF-8''/);
    assert.equal(await csv.text(), "count\r\n12\r\n");
    const partialCsv = await request(`/v1/results/${partial.id}/data.csv`);
    assert.equal(partialCsv.headers.get("x-result-truncated"), "rows");
    assert.match(partialCsv.headers.get("content-disposition")!, /-partial\.csv/);
    assert.equal(await partialCsv.text(), "label\r\n'=SUM(A1)\r\n" + "x".repeat(9000) + "\r\n");
    assert.equal((await request(`/v1/results/${failedMeta.id}/data.csv`)).status, 409);
    for (const path of [`/v1/artifacts/${artifact.id}`, `/v1/artifacts/${artifact.id}/data.csv`, refPath,
      `/v1/sessions/${task().session_id}/artifacts`, `/v1/results/${meta.id}/data.csv`]) {
      assert.equal((await request(path, "bob")).status, 404);
    }
    const audit = readFileSync(join(config.dataDir, "audit", "exports.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(audit.length, 2);
    assert.ok(audit.every((entry) => entry.owner_key === "alice"));
    for (const file of ["task-activity.js", "task-tools.js"]) {
      const module = await request("/" + file);
      assert.equal(module.status, 200);
      assert.match(module.headers.get("content-type")!, /javascript/);
    }
    const vendor = await request("/vendor/echarts.min.js");
    assert.equal(vendor.status, 200);
    assert.ok((await vendor.text()).length > 1_000_000);
    const failedResponse = await request(`/v1/results/${failedMeta.id}`);
    assert.equal(failedResponse.status, 409); assert.equal((await failedResponse.json()).error.code, "RESULT_FAILED");
    assert.equal((await (await request(`/v1/sessions/${task().session_id}`)).json()).session.status, "closed");
    const tasksWithActivity = (await (await request(`/v1/sessions/${task().session_id}/tasks`)).json()).tasks;
    assert.equal(tasksWithActivity[0].status, "succeeded");
    assert.equal(tasksWithActivity[0].activity.available, true);
    const activity = await request(`/v1/tasks/${task().id}/activity`);
    assert.equal(activity.status, 200);
    assert.equal((await activity.json()).summary.available, true);
    assert.equal((await request(`/v1/tasks/${task().id}/activity`, "bob")).status, 404);
    assert.equal((await (await request(`/v1/sessions/${task().session_id}/results`)).json()).results[0].id, meta.id);
    for (const path of [`/v1/results/${meta.id}`, `/v1/tasks/${task().id}`, `/v1/sessions/${task().session_id}/tasks`, `/v1/tasks/${task().id}/events`]) {
      assert.equal((await request(path, "bob")).status, 404);
    }
    const stream = await request(`/v1/tasks/${task().id}/events`);
    const reader = stream.body!.getReader(); let sse = "";
    while (!sse.includes("task_finished")) sse += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); assert.ok(sse.includes('"status":"succeeded"'));
    const saved = await request("/v1/connections/profiles/fixture", "alice", { method: "PUT", body: JSON.stringify({ connection, rememberSecret: true }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).profile.hasSecret, true);
    const again = await request("/v1/connections/profiles/fixture", "alice", { method: "PUT", body: JSON.stringify({ profile: "fixture", rememberSecret: true }) });
    assert.equal(again.status, 200); assert.equal((await again.json()).profile.hasSecret, true);
    const noSecret = await request("/v1/connections/profiles/no-secret", "alice", { method: "PUT", body: JSON.stringify({ connection, rememberSecret: false }) });
    assert.equal(noSecret.status, 200);
    let seen: any;
    service!.testConnection = async (value: any) => { seen = value; return { ok: true } as any; };
    assert.equal((await request("/v1/connections/test", "alice", { method: "POST", body: JSON.stringify({ profile: "no-secret", credentials: { password: "request-only", ssh: [{ password: "ssh-request-only" }] } }) })).status, 200);
    assert.equal(seen.ssh.hops[0].auth.password, "ssh-request-only");
    assert.ok(!JSON.stringify(service!.profiles.list("alice")).includes("request-only"));
    assert.ok(!(service!.profiles.reveal("alice", "no-secret") as any).ssh.hops[0].auth.password);
    const list = await (await request("/v1/connections/profiles")).json();
    assert.equal(list.profiles.length, 2); assert.equal(list.secret_storage_enabled, true);
    assert.equal((await (await request("/v1/connections/profiles", "bob")).json()).profiles.length, 0);
    service!.profiles.save("bob", "other", connection, false);
    const renameGroup = (from: string, to: string, owner = "alice") => request("/v1/connections/groups", owner, { method: "PATCH", body: JSON.stringify({ from, to }) });
    assert.equal((await renameGroup("unknown", "missing")).status, 404);
    assert.equal((await renameGroup("", "   ")).status, 400);
    const renamed = await renameGroup("", " 分析环境 ");
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { updated: 2 });
    const reopenedProfiles = new ProfileStore(join(config.dataDir, "connections.json"), "test-key");
    assert.deepEqual(reopenedProfiles.list("alice").map(({ id, group }) => [id, group]),
      list.profiles.map(({ id }: { id: string }) => [id, "分析环境"]));
    assert.equal(reopenedProfiles.get("bob", "other")?.group, undefined);
    assert.deepEqual(reopenedProfiles.reveal("alice", "fixture"), connection);
    assert.equal(reopenedProfiles.get("alice", "no-secret")?.hasSecret, false);
    assert.equal((await request(`/v1/sessions/${task().session_id}/reconnect`, "alice", { method: "POST", body: JSON.stringify({ connection: { ...connection, database: "wrong-db" } }) })).status, 400);
    assert.equal((await request("/v1/connections/profiles/fixture", "alice", { method: "DELETE" })).status, 204);
    // Purge deletes the saved history, results and artifacts; ownership is enforced first.
    assert.equal((await request(`/v1/sessions/${task().session_id}?purge=true`, "bob", { method: "DELETE" })).status, 404);
    assert.equal((await request(`/v1/sessions/${task().session_id}?purge=true`, "alice", { method: "DELETE" })).status, 204);
    for (const path of [`/v1/sessions/${task().session_id}`, `/v1/sessions/${task().session_id}/tasks`,
      `/v1/sessions/${task().session_id}/results`, `/v1/results/${meta.id}`, `/v1/artifacts/${artifact.id}`, `/v1/tasks/${task().id}`]) {
      assert.equal((await request(path)).status, 404);
    }
    assert.equal((await (await request("/v1/sessions")).json()).sessions.length, 0);
    assert.equal(existsSync(join(config.dataDir, "history", "sessions", `${task().session_id}.json`)), false);
    assert.equal(existsSync(join(config.dataDir, "history", "events", `${task().id}.ndjson`)), false);
  } finally {
    server?.closeAllConnections(); await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await service?.shutdown(); await cleanup(config);
  }
});
