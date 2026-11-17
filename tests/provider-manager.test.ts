import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { AnalysisService } from "../src/agent/service.js";
import { ProviderWrite, ProviderStore } from "../src/agent/provider-store.js";
import { createHttpApp } from "../src/api/http.js";
import { cleanup, testConfig } from "./support.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function close(server?: Server) {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("project providers work without pi, isolate credentials, test drafts and survive restart", async () => {
  const app = await testConfig(); app.allowModelEdit = true; app.profileSecretKey = "fixture-master-key";
  const requests: { auth?: string; org?: string; path?: string }[] = [];
  const upstream = createServer(async (req, res) => {
    requests.push({ auth: req.headers.authorization, org: req.headers["x-org"] as string, path: req.url });
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }, { id: "alpha" }] })); return; }
    for await (const _ of req) { /* drain */ }
    if (req.url?.includes("echo")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "project-secret private-org", type: "invalid_request_error" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "alpha", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const baseUrl = await listen(upstream) + "/v1";
  let service: AnalysisService | undefined, http: Server | undefined;
  try {
    service = await AnalysisService.create(app);
    const web = await createHttpApp(service); http = createServer(web);
    const origin = await listen(http);
    // The HTML and optional module must be deployable together, including retry cache-busters.
    const module = await fetch(origin + "/model-manager.js?load=2");
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") || "", /javascript/);
    assert.match(await module.text(), /export function initModelManager/);
    const call = async (path: string, method = "GET", body?: unknown, auth = true) => {
      const res = await fetch(origin + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer test-token" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
    const config = { name: "Independent", api: "openai-completions", baseUrl, models: [{ id: "alpha", reasoning: true }, { id: "beta" }], apiKey: "project-secret", headers: { "X-Org": "private-org" } };
    assert.equal((await call("/v1/model/providers", "GET", undefined, false)).status, 401);
    assert.equal((await call("/v1/model/providers/gw", "PUT", config)).status, 200);
    let listing = (await call("/v1/model/providers")).body;
    assert.equal(listing.providers[0].has_api_key, true);
    assert.deepEqual(listing.providers[0].header_names, ["X-Org"]);
    assert.equal(JSON.stringify(listing).includes("project-secret"), false);
    assert.equal(JSON.stringify(listing).includes("private-org"), false);
    assert.equal((await call("/v1/model/providers/gw/discover", "POST", { ...config, apiKey: undefined, headers: undefined })).body.models.length, 2);
    const before = service.modelView();
    const probe = (await call("/v1/model/providers/gw/test", "POST", { config: { ...config, apiKey: undefined, headers: undefined }, modelId: "alpha" })).body;
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(service.modelView().provider, before.provider, "testing a draft cannot activate it");
    assert.equal(requests.at(-1)?.auth, "Bearer project-secret");
    assert.equal(requests.at(-1)?.org, "private-org");
    const badProbe = (await call("/v1/model/providers/gw/test", "POST", { config: { ...config, baseUrl: baseUrl + "/echo" }, modelId: "alpha" })).body;
    assert.equal(badProbe.ok, false);
    assert.equal(JSON.stringify(badProbe).includes("project-secret"), false);
    assert.equal(JSON.stringify(badProbe).includes("private-org"), false);
    // New destinations do not get saved credentials without explicit re-entry.
    await call("/v1/model/providers/gw/test", "POST", { config: { ...config, baseUrl: baseUrl + "/new", apiKey: undefined, headers: undefined }, modelId: "alpha" });
    assert.equal(requests.at(-1)?.path?.includes("/new"), false);
    const switched = await call("/v1/model/select", "POST", { provider: "gw", modelId: "alpha", thinkingLevel: "high" });
    assert.equal(switched.status, 200); assert.equal(switched.body.api_key_source, "managed");
    assert.equal(service.modelView().thinking_level, "high");
    assert.equal(service.channels().channels.find((c) => c.id === "gw")?.source, "project");
    assert.equal((await call("/v1/model/providers/gw", "DELETE")).status, 400);
    assert.equal((await call("/v1/model/providers/gw", "PUT", { ...config, models: [{ id: "beta" }] })).status, 400);
    assert.equal((await call("/v1/model/providers/gw", "PUT", { ...config, baseUrl: baseUrl + "/other", apiKey: undefined, headers: undefined })).status, 400);
    assert.equal((await call("/v1/model/providers/gw", "PUT", { ...config, apiKey: "!whoami" })).status, 400);
    const publicFile = await readFile(join(app.dataDir, "model-providers.json"), "utf8");
    const generated = await readFile(join(app.dataDir, "pi", "models.json"), "utf8");
    const keys = await readFile(join(app.dataDir, "model-provider-secrets.json"), "utf8");
    for (const secret of ["project-secret", "private-org"]) {
      assert.equal(publicFile.includes(secret), false); assert.equal(generated.includes(secret), false); assert.equal(keys.includes(secret), false);
    }
    // Restart from a fresh config, without any pi directory or environment key.
    await service.shutdown(); const fresh = { ...app, model: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "off" as const } };
    service = await AnalysisService.create(fresh);
    assert.equal(service.modelView().provider, "gw"); assert.equal(service.modelView().ready, true);
    assert.equal((await service.testModel()).ok, true);
    assert.equal(requests.at(-1)?.auth, "Bearer project-secret");
    // A second channel never borrows the first one's credential.
    await service.saveProvider("other", ProviderWrite.parse({ ...config, name: "Other", apiKey: undefined, headers: undefined }));
    // Concurrent writes serialize instead of dropping each other's catalogue additions.
    await Promise.all(["parallel-a", "parallel-b"].map((id) => service!.saveProvider(id, ProviderWrite.parse({ ...config, name: id, apiKey: undefined, headers: undefined }))));
    assert.ok(service.providerCatalog().providers.some((p) => p.id === "parallel-a"));
    assert.ok(service.providerCatalog().providers.some((p) => p.id === "parallel-b"));
    await service.deleteProvider("parallel-a"); await service.deleteProvider("parallel-b");
    await service.selectChannel("other", "beta");
    assert.equal(service.modelReady, false); assert.equal((await service.testModel()).ok, false);
    await service.saveProvider("other", ProviderWrite.parse({ ...config, name: "Other", apiKey: null, headers: {}, authMode: "none" }));
    assert.equal(service.modelReady, true); assert.equal((await service.testModel()).ok, true);
    await service.deleteProvider("gw");
    assert.equal(service.providerCatalog().providers.some((p) => p.id === "gw"), false);
    await service.selectChannel("openai", "gpt-5.2");
    await service.deleteProvider("other");
    assert.equal(service.providerCatalog().providers.length, 0);
    app.allowModelEdit = false;
    // HTTP retains the original service, whose configuration gate still applies.
    assert.equal((await call("/v1/model/providers/denied", "PUT", config)).status, 403);
  } finally { await close(http); await close(upstream); await service?.shutdown(); await cleanup(app); }
});

test("copies a pi channel once and then runs without either source file", async () => {
  const app = await testConfig(); app.allowModelEdit = true;
  const modelsPath = join(app.dataDir, "source-models.json"), settingsPath = join(app.dataDir, "source-settings.json");
  let service: AnalysisService | undefined;
  try {
    await writeFile(modelsPath, JSON.stringify({ providers: { "pi-source": { api: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "import-secret", models: [{ id: "alpha", reasoning: true }] } } }));
    await writeFile(settingsPath, JSON.stringify({ enabledModels: ["pi-source/*"] }));
    const original = await readFile(modelsPath, "utf8");
    app.piModelsPath = modelsPath; app.piSettingsPath = settingsPath;
    service = await AnalysisService.create(app);
    await service.importPiProvider("pi-source", "independent");
    await assert.rejects(service.importPiProvider("pi-source", "independent"), /already exists/);
    assert.equal(await readFile(modelsPath, "utf8"), original);
    await service.selectChannel("independent", "alpha"); await service.shutdown();
    app.piModelsPath = app.piSettingsPath = undefined;
    service = await AnalysisService.create(app);
    assert.equal(service.modelView().provider, "independent");
    assert.equal(service.modelView().ready, true);
    assert.equal(service.modelView().api_key_source, "managed");
  } finally { await service?.shutdown(); await cleanup(app); }
});

test("provider validation rejects unsafe or ambiguous configurations and refuses corrupt stores", async () => {
  const app = await testConfig();
  try {
    const valid = { name: "a", api: "openai-completions", baseUrl: "https://example.com/v1", models: [{ id: "a" }] };
    for (const patch of [{ baseUrl: "file:///etc/passwd" }, { baseUrl: "https://user:secret@example.com" }, { models: [{ id: "a", contextWindow: 1024, maxTokens: 2048 }] }, { models: [{ id: "a" }, { id: "a" }] }, { apiKey: "${KEY}" }, { headers: { Authorization: "!read-secret" } }]) {
      assert.equal(ProviderWrite.safeParse({ ...valid, ...patch }).success, false, JSON.stringify(patch));
    }
    const path = join(app.dataDir, "model-providers.json");
    await writeFile(path, "{broken");
    const store = new ProviderStore(path);
    assert.equal(store.status, "invalid");
    assert.throws(() => store.save({}), /unreadable/);
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await cleanup(app); }
});
