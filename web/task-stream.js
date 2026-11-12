const terminal = new Set(["succeeded", "failed", "cancelled", "incomplete"]);
export const isTerminal = (status) => terminal.has(status);

function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Resume a task without replaying events; task polling repairs a missed terminal event. */
export async function followTask({ taskId, headers = {}, signal, onEvent, onConnection = () => {},
  onCursor = () => {}, fetchImpl = fetch, wait = pause, initialCursor = 0, idleTimeoutMs = 45_000 }) {
  let cursor = initialCursor;
  let attempt = 0;
  const path = "/v1/tasks/" + encodeURIComponent(taskId);
  const accept = (event) => {
    if (event.task_id !== taskId || !Number.isInteger(event.seq) || event.seq <= cursor) return false;
    onEvent(event);
    cursor = event.seq;
    onCursor(cursor);
    return event.type === "task_finished";
  };
  while (!signal.aborted) {
    let reader;
    const connection = new AbortController();
    const abort = () => { connection.abort(); void reader?.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let idleTimer;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(abort, idleTimeoutMs); };
    resetIdle();
    try {
      const res = await fetchImpl(path + "/events", {
        headers: { ...headers, "Last-Event-ID": taskId + ":" + cursor }, signal: connection.signal,
      });
      if ([401, 403, 404].includes(res.status)) throw Object.assign(new Error("Task stream HTTP " + res.status), { fatal: true });
      if (!res.ok || !res.body) throw new Error("Task stream HTTP " + res.status);
      onConnection("connected");
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const payload = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!payload) continue;
          const event = JSON.parse(payload);
          const previous = cursor;
          if (accept(event)) return;
          if (cursor > previous) attempt = 0;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.fatal) throw error;
    } finally {
      clearTimeout(idleTimer);
      signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
    }
    if (signal.aborted) return;
    // A task may finish while the stream is unavailable. Poll before every reconnect.
    try {
      const res = await fetchImpl(path, { headers, signal });
      if ([401, 403, 404].includes(res.status)) throw Object.assign(new Error("Task status HTTP " + res.status), { fatal: true });
      if (res.ok) {
        const { task } = await res.json();
        if (isTerminal(task.status)) {
          onEvent({ task_id: taskId, type: "task_finished", data: task });
          return;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.fatal) throw error;
    }
    onConnection("reconnecting");
    await wait(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)), signal);
  }
}
