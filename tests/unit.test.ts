import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { redact } from "../src/config.js";
import { serializeValue, cellText } from "../src/db/engines/base.js";
import { ConnectionConfig } from "../src/db/types.js";
import { EventBroker } from "../src/agent/events.js";
import { ResultStore } from "../src/results/store.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-agent-test-"));
  dirs.push(dir);
  return dir;
}

describe("connection schema", () => {
  const base = {
    engine: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app",
    user: "ro_analyst",
    password: "secret",
  };

  it("defaults an undeclared environment to production (fail closed)", () => {
    const parsed = ConnectionConfig.parse(base);
    assert.equal(parsed.environment, "production");
  });

  it("accepts SSH hops as a chain without collapsing host names", () => {
    const parsed = ConnectionConfig.parse({
      ...base,
      environment: "non_production",
      ssl: { mode: "verify-full", serverName: "db.internal", ca: "PEM" },
      ssh: {
        hops: [
          { host: "bastion-1", port: 22, username: "jump", auth: { method: "password", password: "p" }, hostFingerprint: "SHA256:abc" },
          { host: "bastion-2", username: "jump2", auth: { method: "privateKey", privateKey: "KEY" }, hostFingerprint: "SHA256:def" },
        ],
      },
      workspace: { name: "analysis_ws" },
    });
    assert.equal(parsed.host, "db.internal");
    assert.equal(parsed.ssh?.hops.length, 2);
    assert.equal(parsed.ssh?.hops[1]?.port, 22, "hop port defaults to 22");
    assert.equal(parsed.ssl?.serverName, "db.internal");
  });

  it("rejects an unknown engine and a bad port", () => {
    assert.equal(ConnectionConfig.safeParse({ ...base, engine: "oracle" }).success, false);
    assert.equal(ConnectionConfig.safeParse({ ...base, port: 0 }).success, false);
  });

  it("rejects a workspace name that is not a simple identifier", () => {
    assert.equal(ConnectionConfig.safeParse({ ...base, workspace: { name: "bad name;drop" } }).success, false);
  });
});

describe("redaction", () => {
  it("hides secret-shaped keys at any depth", () => {
    const redacted = redact({
      connection: { host: "db", password: "p", ssh: { hops: [{ auth: { privateKey: "K", passphrase: "q" } }] } },
      apiKey: "k",
      token: "t",
      keep: "visible",
    });
    assert.equal(redacted.connection.password, "***");
    assert.equal(redacted.connection.ssh.hops[0]?.auth.privateKey, "***");
    assert.equal(redacted.connection.ssh.hops[0]?.auth.passphrase, "***");
    assert.equal(redacted.apiKey, "***");
    assert.equal(redacted.keep, "visible");
    assert.equal(redacted.connection.host, "db");
  });
});

describe("value serialisation", () => {
  it("keeps int8/numeric precision as strings", () => {
    assert.equal(serializeValue(9007199254740993n), "9007199254740993");
  });

  it("marks binary payloads instead of dumping them", () => {
    const value = serializeValue(Buffer.from("hello world")) as { __type: string; bytes: number; base64Preview: string };
    assert.equal(value.__type, "bytes");
    assert.equal(value.bytes, 11);
    assert.equal(Buffer.from(value.base64Preview, "base64").toString(), "hello world");
  });

  it("truncates long text with a marker the model can notice", () => {
    const value = serializeValue("x".repeat(10_000)) as { __type: string; chars: number; truncated: boolean };
    assert.equal(value.__type, "text");
    assert.equal(value.truncated, true);
    assert.equal(value.chars, 10_000);
  });

  it("truncates cells for tool output without losing the table shape", () => {
    assert.equal(cellText("short", 100), "short");
    assert.equal(cellText("x".repeat(50), 10), "xxxxxxxxxx…");
  });
});

describe("result store", () => {
  it("writes NDJSON and pages through it with a stable next_offset", async () => {
    const store = new ResultStore(await tempDir());
    const writer = await store.create({ sessionId: "sess_1", sql: "SELECT 1", previewRows: 2 });
    writer.setColumns([{ name: "id", type: "int4" }, { name: "name", type: "text" }]);
    for (let index = 0; index < 7; index += 1) await writer.append([index, `row-${index}`]);
    const meta = await writer.finish("none", 5);

    assert.equal(meta.rowCount, 7);
    assert.equal(meta.preview.length, 2);

    const first = await store.read(meta.id, 0, 3);
    assert.deepEqual(first?.rows, [[0, "row-0"], [1, "row-1"], [2, "row-2"]]);
    assert.equal(first?.nextOffset, 3);

    const second = await store.read(meta.id, first!.nextOffset!, 10);
    assert.deepEqual(second?.rows, [[3, "row-3"], [4, "row-4"], [5, "row-5"], [6, "row-6"]]);
    assert.equal(second?.nextOffset, null);

    assert.equal((await store.listBySession("sess_1")).length, 1);
    assert.equal((await store.listBySession("sess_2")).length, 0);
  });

  it("rejects result ids that could escape the result directory", async () => {
    const store = new ResultStore(await tempDir());
    assert.equal(await store.get("../../etc/passwd"), undefined);
  });
});

describe("event broker", () => {
  it("assigns monotonic per-task sequence numbers and supports resume", () => {
    const broker = new EventBroker(3);
    broker.publish("task_a", "task_started", {});
    broker.publish("task_a", "tool_started", { tool: "query_execute" });
    broker.publish("task_b", "task_started", {});

    const all = broker.list("task_a");
    assert.deepEqual(all.map((event) => event.seq), [1, 2]);
    assert.equal(all[1]?.id, "task_a:2");
    assert.deepEqual(broker.list("task_a", 1).map((event) => event.type), ["tool_started"]);
    assert.equal(broker.list("task_b").length, 1);
  });

  it("bounds the in-memory log", () => {
    const broker = new EventBroker(2);
    for (let index = 0; index < 5; index += 1) broker.publish("task_c", "message_delta", { text: String(index) });
    const events = broker.list("task_c");
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.data.text), ["3", "4"]);
  });

  it("delivers to subscribers and survives a throwing subscriber", () => {
    const broker = new EventBroker();
    const seen: string[] = [];
    const unsubscribe = broker.subscribe("task_d", (event) => {
      seen.push(event.type);
      throw new Error("subscriber bug");
    });
    broker.publish("task_d", "task_queued", {});
    broker.publish("task_d", "task_started", {});
    unsubscribe();
    broker.publish("task_d", "task_finished", {});
    assert.deepEqual(seen, ["task_queued", "task_started"]);
  });
});
