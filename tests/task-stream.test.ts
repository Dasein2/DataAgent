import assert from "node:assert/strict";
import { it } from "node:test";
import { followTask } from "../web/task-stream.js";

const taskId = "task_test";
const event = (seq: number, type = "message_delta") => ({ seq, task_id: taskId, id: `${taskId}:${seq}`, type, data: { text: String(seq) } });
const stream = (...events: any[]) => new Response(events.map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
const json = (data: unknown) => Response.json(data);

it("resumes after a dropped stream using a cursor and suppresses duplicate events", async () => {
  const cursors: string[] = [];
  let streams = 0;
  const seen: any[] = [];
  await followTask({ taskId, signal: new AbortController().signal, wait: async () => {}, onEvent: (e: any) => seen.push(e),
    fetchImpl: async (path: string, options: any) => {
      if (!path.endsWith("/events")) return json({ task: { status: "running" } });
      cursors.push(options.headers["Last-Event-ID"]);
      return streams++ === 0 ? stream(event(1)) : stream(event(1), event(2), event(3, "task_finished"));
    } });
  assert.deepEqual(cursors, ["task_test:0", "task_test:1"]);
  assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3]);
});

it("repairs a missed terminal event by polling even when no SSE event arrived", async () => {
  const seen: any[] = [];
  const calls: string[] = [];
  await followTask({ taskId, signal: new AbortController().signal, onEvent: (e: any) => seen.push(e),
    fetchImpl: async (path: string) => {
      calls.push(path);
      if (path.endsWith("/events")) throw new Error("network disconnected");
      return json({ task: { status: "failed", error: { code: "MODEL_ERROR" }, answer: "partial" } });
    } });
  assert.equal(calls.length, 2);
  assert.equal(seen[0].type, "task_finished");
  assert.equal(seen[0].data.status, "failed");
});

it("stops on an authorization failure rather than retrying forever", async () => {
  await assert.rejects(followTask({ taskId, signal: new AbortController().signal, onEvent: () => {},
    fetchImpl: async () => new Response("unauthorized", { status: 401 }) }), /401/);
});

it("aborts pending reconnection when the user switches sessions", async () => {
  const controller = new AbortController();
  let calls = 0;
  await followTask({ taskId, signal: controller.signal, onEvent: () => {},
    fetchImpl: async () => { calls++; throw new Error("offline"); },
    wait: async () => { controller.abort(); } });
  assert.equal(calls, 2);
});

it("polls a terminal task after a silent SSE connection stalls", async () => {
  const seen: any[] = [];
  await followTask({ taskId, signal: new AbortController().signal, idleTimeoutMs: 5, onEvent: (e: any) => seen.push(e),
    fetchImpl: async (path: string) => path.endsWith("/events")
      ? new Response(new ReadableStream({ start() {} }))
      : json({ task: { status: "incomplete", error: { code: "SERVICE_RESTARTED" } } }),
  });
  assert.equal(seen[0].data.status, "incomplete");
});
