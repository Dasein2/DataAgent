import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AnalysisService } from "../src/agent/service.js";
import { createHttpApp } from "../src/api/http.js";
import { DbSession } from "../src/db/session.js";
import { describeEngine, getProfile } from "../src/db/engines/profiles.js";
import { ConnectionConfig } from "../src/db/types.js";
import { cleanup, testConfig } from "./support.js";

const connection = ConnectionConfig.parse({ engine: "postgres", host: "account-fixture.internal", port: 5432,
  user: "fixture-reader", database: "analytics", password: "fixture-db-password", ssh: { hops: [
    { host: "bastion.internal", username: "jump", hostFingerprint: "SHA256:" + "A".repeat(43),
      auth: { method: "privateKey", privateKey: "fixture-ssh-private-key", passphrase: "fixture-key-passphrase" } },
    { host: "next-hop.internal", username: "jump", hostFingerprint: "SHA256:" + "B".repeat(43),
      auth: { method: "password", password: "fixture-ssh-password" } },
  ] } });

const capabilities = { engine: "postgres", engineLabel: "PostgreSQL", engineProfile: describeEngine(getProfile("postgres")),
  environment: "production", serverVersion: "fixture", readOnlyProof: "transaction", notes: [],
  sourceAccess: "read_only", workspaceAccess: "none", features: { cancel: true, explain: true, explainAnalyze: true, streaming: true } };

test("account cookies isolate profiles and history, and saved credentials support restart/reconnect", async () => {
  const config = await testConfig();
  config.requireAuth = true;
  config.profileSecretKey = "fixture-stable-key";
  config.adminPassword = "fixture-admin-password";
  config.secureAuthCookie = true;
  config.model.apiKey = "fixture-model-key";
  let service: AnalysisService | undefined, server: Server | undefined, origin: string;
  const original = DbSession.open;
  const opened: unknown[] = [];
  DbSession.open = async (opts) => {
    opened.push(opts.config);
    const id = opts.sessionId ?? `sess_fixture${opened.length}`;
    return { id, engineProfile: getProfile("postgres"), capabilitiesView: capabilities, scopesView: ["public"],
      expiresAt: new Date(Date.now() + 60_000), touch() {}, close: async () => {}, cancel: async () => true,
      snapshot: () => ({ session_id: id, database: "analytics", status: "ready", capabilities, queries: { used: 0, limit: 60 } }),
    } as any;
  };
  async function start() {
    service = await AnalysisService.create(config);
    server = createServer(await createHttpApp(service));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function stop() {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await service?.shutdown();
    service = undefined;
  }
  async function call(path: string, status: number, opts: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const response = await fetch(origin + "/v1" + path, { method: opts.method,
      headers: { authorization: "Bearer test-token", "x-caller-id": "admin", ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const raw = await response.text();
    assert.equal(response.status, status, raw);
    return { data: raw ? JSON.parse(raw) : null, cookie: response.headers.get("set-cookie") };
  }
  async function login(username: string, password: string) {
    const result = await call("/auth/login", 200, { method: "POST", body: { username, password } });
    assert.equal(result.data.account.username, username.toLowerCase());
    assert.match(result.cookie!, /^__Host-data_agent_login=/);
    assert.match(result.cookie!, /HttpOnly/);
    assert.match(result.cookie!, /SameSite=Strict/);
    assert.match(result.cookie!, /Secure/);
    return result.cookie!.split(";")[0]!;
  }
  try {
    await start();
    await service!.accounts!.setPassword("bob", "fixture-bob-password", "add");
    // Minimum password length is 8 characters.
    await service!.accounts!.setPassword("shorty", "12345678", "add");
    await assert.rejects(() => service!.accounts!.setPassword("tiny", "1234567", "add"));
    await service!.accounts!.deleteAccount("shorty");
    assert.deepEqual((await call("/auth/status", 200)).data, { required: true, account: null });
    await call("/connections", 401); // legacy bearer and caller headers cannot bypass account auth
    await call("/auth/login", 401, { method: "POST", body: { username: "admin", password: "bad-password" } });
    await call("/auth/login", 403, { method: "POST", headers: { origin: "https://other.invalid" }, body: { username: "admin", password: config.adminPassword } });
    const admin = await login("ADMIN", config.adminPassword!);
    const bob = await login("bob", "fixture-bob-password");
    await call("/connections", 401, { cookie: bob, headers: { "x-data-agent-account": "admin" } });
    await call("/model/providers", 403, { cookie: bob });
    await call("/model/providers", 200, { cookie: admin });
    const profilePath = "/connections/profiles/analytics";
    await call(profilePath, 403, { cookie: admin, method: "PUT", body: { connection }, headers: { "sec-fetch-site": "same-site" } });
    const saved = (await call(profilePath, 200, { cookie: admin, method: "PUT", body: { connection, rememberSecret: false, group: "  数据分析  " } })).data.profile;
    assert.equal(saved.hasSecret, true, "account saves always include credentials");
    assert.equal(saved.group, "数据分析");
    assert.deepEqual((await call("/connections", 200, { cookie: bob })).data.profiles, []);
    await call("/sessions", 404, { cookie: bob, method: "POST", body: { profile: "analytics" } });
    await call(profilePath, 404, { cookie: bob, method: "DELETE" });
    const store = await readFile(join(config.dataDir, "connections.json"), "utf8");
    for (const secret of ["fixture-db-password", "fixture-key-passphrase", "fixture-ssh-private-key", "fixture-ssh-password"]) {
      assert.ok(!store.includes(secret) && !JSON.stringify(saved).includes(secret));
    }
    assert.ok(!store.includes(connection.host));
    const db = await readFile(join(config.dataDir, "accounts.db"));
    assert.ok(!db.includes(config.adminPassword!));
    assert.ok(!db.includes(admin.split("=")[1]!));
    const { session } = (await call("/sessions", 201, { cookie: admin, method: "POST", body: { profile: "analytics" } })).data;
    assert.deepEqual(opened.at(-1), connection);
    const path = `/sessions/${session.session_id}`;
    await call(path, 404, { cookie: bob });
    await call(path + "/models", 404, { cookie: bob });
    const bobSession = (await call("/sessions", 201, { cookie: bob, method: "POST", body: { connection } })).data.session;
    const bobPath = `/sessions/${bobSession.session_id}`;
    const modelList = (await call(bobPath + "/models", 200, { cookie: bob })).data;
    assert.ok(Array.isArray(modelList.channels));
    assert.equal(modelList.sources, undefined);
    await call(bobPath + "/model", 200, { cookie: bob, method: "POST", body: { provider: "openai", modelId: "gpt-5.2" } });
    await call(bobPath + "/model", 403, { cookie: bob, method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: { provider: "openai", modelId: "gpt-5.2" } });
    await call(bobPath + "?purge=true", 204, { cookie: bob, method: "DELETE" });
    await call(path + "/reconnect", 404, { cookie: bob, method: "POST" });
    await call(profilePath, 404, { cookie: bob, method: "PUT", body: { connection, session_id: session.session_id } });

    const direct = (await call("/sessions", 201, { cookie: admin, method: "POST", body: { connection } })).data.session.session_id;
    const openCount = opened.length;
    const sessionProfiles = async () => Object.fromEntries((await call("/sessions", 200, { cookie: admin })).data.sessions
      .map((item: { session_id: string; connection_profile_id?: string }) => [item.session_id, item.connection_profile_id]));
    assert.deepEqual(await sessionProfiles(), { [session.session_id]: saved.id, [direct]: saved.id });
    assert.deepEqual((await call("/sessions", 200, { cookie: bob })).data.sessions, []);
    const duplicatePath = "/connections/profiles/analytics-copy";
    await call(duplicatePath, 200, { cookie: admin, method: "PUT", body: { connection } });
    assert.deepEqual(await sessionProfiles(), { [session.session_id]: saved.id, [direct]: undefined });
    await call(duplicatePath, 204, { cookie: admin, method: "DELETE" });
    assert.equal(opened.length, openCount, "listing history must not connect to the database");
    await call(`/sessions/${direct}/reconnect`, 409, { cookie: admin, method: "POST" });
    await call(profilePath, 200, { cookie: admin, method: "PUT", body: { profile: "analytics", session_id: direct } });
    await stop();
    config.adminPassword = undefined;
    await start();
    assert.equal((await call("/connections", 200, { cookie: admin })).data.profiles[0].group, "数据分析");
    assert.deepEqual(await sessionProfiles(), { [session.session_id]: saved.id, [direct]: saved.id });
    assert.equal((await call(path, 200, { cookie: admin })).data.session.status, "disconnected");
    await call(path + "/reconnect", 200, { cookie: admin, method: "POST" });
    await call(`/sessions/${direct}/reconnect`, 200, { cookie: admin, method: "POST", body: {} });
    assert.deepEqual(opened.at(-1), connection);
    const moved = { ...connection, ssh: { hops: [{ ...connection.ssh!.hops[0]!, host: "changed-hop.internal" }] } };
    const replaced = (await call(profilePath, 200, { cookie: admin, method: "PUT", body: { connection: moved } })).data.profile;
    assert.equal(replaced.id, saved.id);
    assert.equal((await call(path + "/reconnect", 409, { cookie: admin, method: "POST" })).data.error.code, "RECONNECT_PROFILE_REQUIRED");
    await call(path + "/reconnect", 400, { cookie: admin, method: "POST", body: { profile: "analytics" } });
    await call(profilePath, 204, { cookie: admin, method: "DELETE" });
    const recreated = (await call(profilePath, 200, { cookie: admin, method: "PUT", body: { connection } })).data.profile;
    assert.notEqual(recreated.id, saved.id);
    assert.equal((await call(path + "/reconnect", 409, { cookie: admin, method: "POST" })).data.error.code, "RECONNECT_PROFILE_REQUIRED");
    await call(path + "/reconnect", 200, { cookie: admin, method: "POST", body: { profile: "analytics" } });
    await call("/auth/logout", 204, { cookie: admin, method: "POST" });
    await call(path, 401, { cookie: admin });
    const otherLogin = await login("admin", "fixture-admin-password");
    await service!.accounts!.setPassword("admin", "fixture-admin-new-password", "reset");
    await call("/connections", 401, { cookie: otherLogin });
    await call("/auth/login", 401, { method: "POST", body: { username: "admin", password: "fixture-admin-password" } });
    const nextAdmin = await login("admin", "fixture-admin-new-password");
    await call(path + "/reconnect", 200, { cookie: nextAdmin, method: "POST" });
    assert.deepEqual(opened.at(-1), connection);
    const sqlite = new DatabaseSync(join(config.dataDir, "accounts.db"));
    try { sqlite.exec("UPDATE sessions SET expires_at = 0"); } finally { sqlite.close(); }
    await call("/connections", 401, { cookie: nextAdmin });
  } finally {
    DbSession.open = original;
    await stop();
    await cleanup(config);
  }
});

test("account mode fails closed without a profile key or an initialized admin", async () => {
  const config = await testConfig();
  config.requireAuth = true;
  try {
    await assert.rejects(() => AnalysisService.create(config), /PROFILE_SECRET_KEY/);
    config.profileSecretKey = "fixture-key";
    await assert.rejects(() => AnalysisService.create(config), /ADMIN_PASSWORD/);
  } finally { await cleanup(config); }
});
