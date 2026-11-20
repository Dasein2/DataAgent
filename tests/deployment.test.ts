import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisService } from "../src/agent/service.js";
import { EventBroker, type TaskEvent } from "../src/agent/events.js";
import { createHttpApp } from "../src/api/http.js";
import { loadConfig } from "../src/config.js";
import { cleanup, testConfig } from "./support.js";

// ---------------------------------------------------------------- config parsing

const CONFIG_ENV = [
  "NODE_ENV",
  "DATA_AGENT_ENV_FILE",
  "DATA_AGENT_DATA_DIR",
  "DATA_AGENT_API_TOKEN",
  "DATA_AGENT_REQUIRE_AUTH",
  "DATA_AGENT_ADMIN_PASSWORD",
  "DATA_AGENT_TRUST_PROXY",
  "DATA_AGENT_RETENTION_DAYS",
  "DATA_AGENT_PI_IMPORT",
  "DATA_AGENT_MODEL_PROVIDER",
  "DATA_AGENT_MODEL_ID",
];

async function withConfigEnv(patch: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = new Map(CONFIG_ENV.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "data-agent-deploy-config-"));
  const emptyEnv = join(dir, "empty.env");
  writeFileSync(emptyEnv, "# nothing pinned\n");
  try {
    for (const key of CONFIG_ENV) delete process.env[key];
    Object.assign(process.env, {
      DATA_AGENT_ENV_FILE: emptyEnv,
      DATA_AGENT_DATA_DIR: dir,
      DATA_AGENT_PI_IMPORT: "0",
      DATA_AGENT_MODEL_PROVIDER: "openai",
      DATA_AGENT_MODEL_ID: "gpt-5.2",
      ...patch,
    });
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("trust proxy stays off unless the operator opts in, and accepts hop/subnet forms", async () => {
  await withConfigEnv({ NODE_ENV: "development" }, async () => {
    assert.equal(loadConfig().trustProxy, undefined);
  });
  await withConfigEnv({ NODE_ENV: "development", DATA_AGENT_TRUST_PROXY: "1" }, async () => {
    assert.equal(loadConfig().trustProxy, 1);
  });
  await withConfigEnv({ NODE_ENV: "development", DATA_AGENT_TRUST_PROXY: "loopback" }, async () => {
    assert.equal(loadConfig().trustProxy, "loopback");
  });
  await withConfigEnv({ NODE_ENV: "development", DATA_AGENT_TRUST_PROXY: "false" }, async () => {
    assert.equal(loadConfig().trustProxy, false);
  });
});

test("production retention defaults to 30 days and stays explicitly disableable", async () => {
  await withConfigEnv({ NODE_ENV: "production", DATA_AGENT_API_TOKEN: "token" }, async () => {
    assert.equal(loadConfig().analysis?.retentionDays, 30);
  });
  await withConfigEnv({ NODE_ENV: "production", DATA_AGENT_API_TOKEN: "token", DATA_AGENT_RETENTION_DAYS: "0" }, async () => {
    assert.equal(loadConfig().analysis?.retentionDays, 0);
  });
  await withConfigEnv({ NODE_ENV: "development" }, async () => {
    assert.equal(loadConfig().analysis?.retentionDays, 0);
  });
});

// ---------------------------------------------------------------- probes and login keying

async function startApp(configure: (config: Awaited<ReturnType<typeof testConfig>>) => void) {
  const config = await testConfig();
  configure(config);
  const service = await AnalysisService.create(config);
  const server = createServer(await createHttpApp(service));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    service,
    origin,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.shutdown();
    },
  };
}

test("healthz is liveness while readyz reports whether a model credential resolves", async () => {
  const app = await startApp(() => {});
  try {
    // testConfig carries no model key, so no analysis task could run.
    assert.equal(app.service.modelReady, false);
    const health = await fetch(app.origin + "/healthz");
    assert.equal(health.status, 200);
    const ready = await fetch(app.origin + "/readyz");
    assert.equal(ready.status, 503);
    assert.equal((await ready.json() as { model_ready: boolean }).model_ready, false);

    Object.defineProperty(app.service, "modelReady", { get: () => true });
    const readyNow = await fetch(app.origin + "/readyz");
    assert.equal(readyNow.status, 200);
    assert.equal((await readyNow.json() as { model_ready: boolean }).model_ready, true);
  } finally {
    await app.stop();
    await cleanup(app.service.config);
  }
});

test("login attempts are keyed by the socket peer unless trust proxy is configured", async () => {
  // A forged X-Forwarded-For must not hand a client a fresh rate-limit bucket while the port is
  // reachable directly: with trust proxy unset, all eleven attempts share the loopback peer.
  const untrusted = await startApp((config) => {
    config.requireAuth = true;
    config.profileSecretKey = "fixture-stable-key";
    config.adminPassword = "fixture-admin-password";
    config.secureAuthCookie = false;
    config.trustProxy = undefined;
  });
  try {
    for (let index = 0; index < 10; index++) {
      const response = await fetch(untrusted.origin + "/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${index}` },
        body: JSON.stringify({ username: "admin", password: "wrong-password" }),
      });
      assert.equal(response.status, 401, `attempt ${index + 1} should be a normal auth failure`);
    }
    const limited = await fetch(untrusted.origin + "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await untrusted.stop();
    await cleanup(untrusted.service.config);
  }

  // Behind a trusted proxy the same header is honoured, so distinct clients get distinct buckets.
  const trusted = await startApp((config) => {
    config.requireAuth = true;
    config.profileSecretKey = "fixture-stable-key";
    config.adminPassword = "fixture-admin-password";
    config.secureAuthCookie = false;
    config.trustProxy = 1;
  });
  try {
    for (let index = 0; index < 10; index++) {
      const response = await fetch(trusted.origin + "/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${index}` },
        body: JSON.stringify({ username: "admin", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
    }
    const fresh = await fetch(trusted.origin + "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.200" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    assert.equal(fresh.status, 401, "a different client keeps its own budget");
  } finally {
    await trusted.stop();
    await cleanup(trusted.service.config);
  }
});

// ---------------------------------------------------------------- event log retention

function fakeHistory() {
  const events = new Map<string, TaskEvent[]>();
  return {
    events,
    history: {
      appendEvent(event: TaskEvent) {
        const list = events.get(event.task_id) ?? [];
        list.push(event);
        events.set(event.task_id, list);
      },
      listEvents: (taskId: string) => events.get(taskId) ?? [],
    },
  };
}

test("the in-memory event map is bounded only when history can restore a log", () => {
  const { history } = fakeHistory();
  const broker = new EventBroker(5_000, history, 2);
  for (const id of ["task_a", "task_b", "task_c"]) broker.publish(id, "task_queued", {});
  assert.equal((broker as any).logs.size, 2, "oldest finished log is evicted");
  // Eviction does not lose data: the on-disk log is reloaded and keeps its monotonic seq.
  assert.deepEqual(broker.list("task_a").map((event) => event.seq), [1]);
  broker.publish("task_a", "notice", { code: "RESUMED" });
  assert.deepEqual(broker.list("task_a").map((event) => event.seq), [1, 2]);

  // Without a history store an evicted log would restart at seq 1, so nothing is evicted.
  const bare = new EventBroker(5_000, undefined, 1);
  for (const id of ["task_x", "task_y", "task_z"]) bare.publish(id, "task_queued", {});
  assert.equal((bare as any).logs.size, 3);
});

test("a task with live subscribers is never evicted", () => {
  const { history } = fakeHistory();
  const broker = new EventBroker(5_000, history, 2);
  broker.publish("task_watched", "task_queued", {});
  const unsubscribe = broker.subscribe("task_watched", () => {});
  try {
    for (const id of ["task_b", "task_c", "task_d"]) broker.publish(id, "task_queued", {});
    assert.equal((broker as any).logs.has("task_watched"), true);
    assert.equal((broker as any).logs.size, 2);
  } finally {
    unsubscribe();
  }
});
