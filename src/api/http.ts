import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import { ConnectionConfig } from "../db/types.js";
import { ENGINE_IDS, describeEngine, getProfile } from "../db/engines/profiles.js";
import { AppError, isAppError } from "../errors.js";
import { AnalysisService, callerKey } from "../agent/service.js";
import { SaveProfileRequest } from "../db/profiles-store.js";
import { ModelPatch } from "../agent/model-settings.js";
import { ChannelSelection } from "../agent/channels.js";
import { toolCatalog } from "../agent/tools.js";
import { z } from "zod";
import { ProviderWrite, ProviderId } from "../agent/provider-store.js";

interface RequestIdentity {
  ownerKey: string;
}

declare module "express-serve-static-core" {
  interface Request {
    identity?: RequestIdentity;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

function authMiddleware(token: string): RequestHandler {
  const expected = token ? digest(token) : undefined;
  return (req, _res, next) => {
    if (expected) {
      const provided = bearer(req);
      if (!provided || !timingSafeEqual(digest(provided), expected)) {
        next(new AppError("UNAUTHORIZED", "Missing or invalid bearer token"));
        return;
      }
    }
    req.identity = { ownerKey: callerKey(token, req.header("x-caller-id")) };
    next();
  };
}

function ownerOf(req: Request): string {
  const identity = req.identity;
  if (!identity) throw new AppError("UNAUTHORIZED", "No request identity");
  return identity.ownerKey;
}

/**
 * Titles and ids end up in filenames. `filename*` carries the UTF-8 form; the ASCII fallback keeps
 * older clients from writing a file with a mangled name.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function intParam(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("INVALID_INPUT", `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseConnection(body: unknown): ConnectionConfig {
  const parsed = ConnectionConfig.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "connection"}: ${issue.message}`);
    throw new AppError("INVALID_INPUT", `Invalid connection configuration — ${issues.join("; ")}`);
  }
  return parsed.data;
}

function parseSseCursor(req: Request): number {
  const last = req.header("last-event-id");
  const raw = last?.includes(":") ? last.split(":").pop() : (req.query.after as string | undefined);
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function createHttpApp(service: AnalysisService): Promise<express.Express> {
  const app = express();
  const config = service.config;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (req.path.startsWith("/v1/")) res.setHeader("cache-control", "no-store");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      model: `${config.model.provider}/${config.model.modelId}`,
      model_ready: service.modelReady,
      api_token_required: Boolean(config.apiToken),
      env: config.env,
    });
  });

  app.use("/v1", authMiddleware(config.apiToken));

  const requestConnection = (req: Request): ConnectionConfig => {
    if (typeof req.body?.profile === "string") {
      const stored = service.profiles.reveal(ownerOf(req), req.body.profile);
      // Only credential overrides are accepted; changing the target requires saving a new profile.
      const overrides = req.body?.credentials ?? {};
      if (typeof overrides.password === "string" && overrides.password) stored.password = overrides.password;
      const ssh = stored.ssh as { hops: Array<{ auth: Record<string, unknown> }> } | undefined;
      if (ssh && Array.isArray(overrides.ssh)) {
        for (let index = 0; index < ssh.hops.length; index++) {
          const auth = overrides.ssh[index];
          if (!auth || typeof auth !== "object") continue;
          for (const field of ["password", "privateKey", "passphrase"]) {
            if (typeof auth[field] === "string" && auth[field]) ssh.hops[index]!.auth[field] = auth[field];
          }
        }
      }
      return parseConnection(stored);
    }
    return parseConnection(req.body?.connection ?? req.body);
  };

  app.get("/v1/connections/profiles", (req, res) => {
    res.json({ profiles: service.profiles.list(ownerOf(req)), secret_storage_enabled: service.profiles.secretStorageEnabled });
  });
  app.put("/v1/connections/profiles/:name", (req, res) => {
    const body = SaveProfileRequest.parse({ connection: requestConnection(req), rememberSecret: req.body?.rememberSecret });
    res.json({ profile: service.profiles.save(ownerOf(req), req.params.name, body.connection, body.rememberSecret) });
  });
  app.delete("/v1/connections/profiles/:name", (req, res) => {
    service.profiles.remove(ownerOf(req), req.params.name);
    res.status(204).end();
  });

  // Let consoles and integrators pull the engine list instead of hard-coding a dropdown. The same
  // descriptors drive session capabilities, so the two can never disagree.
  app.get("/v1/engines", (_req, res) => {
    res.json({ engines: ENGINE_IDS.map((id) => describeEngine(getProfile(id))) });
  });

  const tools = toolCatalog();

  // The console is the only place an operator can see how the model is configured; the API key is
  // never echoed and runtime edits are refused in production unless explicitly enabled.
  app.get("/v1/model", (_req, res) => {
    res.json(service.modelView());
  });

  // The channels the operator can switch between: their own pi models.json entries plus the built-in
  // providers pi's enabledModels keeps on. Keys are never included, only whether one resolves.
  app.get("/v1/model/channels", (_req, res) => {
    res.json(service.channels());
  });

  // Administrative endpoints: guarded by bearer authentication and allowModelEdit, just like
  // the legacy model editor. These are global server settings, not caller-scoped session data.
  app.get("/v1/model/providers", (_req, res) => res.json(service.providerCatalog()));
  app.put("/v1/model/providers/:id", async (req, res) => {
    res.json(await service.saveProvider(ProviderId.parse(req.params.id), ProviderWrite.parse(req.body)));
  });
  app.delete("/v1/model/providers/:id", async (req, res) => {
    res.json(await service.deleteProvider(ProviderId.parse(req.params.id)));
  });
  app.post("/v1/model/providers/:id/test", async (req, res) => {
    const { modelId, config } = z.object({ modelId: z.string().min(1), config: ProviderWrite }).parse(req.body);
    res.json(await service.testProvider(ProviderId.parse(req.params.id), config, modelId));
  });
  app.post("/v1/model/providers/:id/discover", async (req, res) => {
    res.json(await service.discoverProvider(ProviderId.parse(req.params.id), ProviderWrite.parse(req.body)));
  });
  app.post("/v1/model/import-pi", async (req, res) => {
    const body = z.object({ sourceId: ProviderId, targetId: ProviderId }).parse(req.body);
    res.json(await service.importPiProvider(body.sourceId, body.targetId));
  });

  app.post("/v1/model/select", async (req, res) => {
    const body = ChannelSelection.safeParse(req.body ?? {});
    if (!body.success) {
      const issues = body.error.issues.map((issue) => `${issue.path.join(".") || "channel"}: ${issue.message}`);
      throw new AppError("INVALID_INPUT", `Invalid channel selection — ${issues.join("; ")}`);
    }
    res.json(await service.selectChannel(body.data.provider, body.data.modelId, body.data.thinkingLevel));
  });

  app.put("/v1/model", async (req, res) => {
    const patch = ModelPatch.safeParse(req.body ?? {});
    if (!patch.success) {
      const issues = patch.error.issues.map((issue) => `${issue.path.join(".") || "model"}: ${issue.message}`);
      throw new AppError("INVALID_INPUT", `Invalid model settings — ${issues.join("; ")}`);
    }
    res.json(await service.updateModel(patch.data));
  });

  app.delete("/v1/model", async (_req, res) => {
    res.json(await service.resetModel());
  });

  // Readiness only proves a credential exists; a wrong protocol or base URL surfaces as a request
  // error, so the console needs a way to make one real call before trusting the settings.
  app.post("/v1/model/test", async (_req, res) => {
    res.json(await service.testModel());
  });

  app.get("/v1/tools", (_req, res) => {
    res.json({ tools });
  });

  app.get("/v1/capabilities", (_req, res) => {
    res.json({
      engines: ENGINE_IDS,
      source_access: "read_only",
      workspace_access: ["none", "views_only", "tables_and_views"],
      tool_names: tools.map((tool) => tool.name),
      budgets: {
        max_turns: config.budgets.maxTurns,
        max_queries: config.budgets.maxQueries,
        task_timeout_ms: config.budgets.taskTimeoutMs,
        query_timeout_ms: config.budgets.queryTimeoutMs,
        preview_rows: config.budgets.previewRows,
        cell_chars: config.budgets.cellChars,
        max_datasets: config.budgets.maxDatasets,
        max_chart_rows: config.budgets.maxChartRows,
        max_chart_cells: config.budgets.maxChartCells,
        max_artifacts_per_task: config.budgets.maxArtifactsPerTask,
      },
      limits: {
        max_sessions: config.maxSessions,
        session_ttl_ms: config.sessionTtlMs,
        max_sse_backlog_events: 5_000,
      },
    });
  });

  // Reads a jump host's host key before anything is pinned. The browser shows it, the operator
  // confirms, and the fingerprint then travels with the connection like any other profile field.
  app.post("/v1/connections/host-key", async (req, res) => {
    const connection = requestConnection(req);
    const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
    const profile = typeof req.body?.profile === "string" ? req.body.profile : undefined;
    res.json(pin
      ? await service.pinHostKey(connection, ownerOf(req), { profile, fingerprint: pin })
      : await service.probeHostKey(connection, { observe: req.body?.observe === true }));
  });

  app.post("/v1/connections/test", async (req, res) => {
    const connection = requestConnection(req);
    res.json(await service.testConnection(connection));
  });

  app.post("/v1/sessions", async (req, res) => {
    const connection = requestConnection(req);
    const session = await service.createSession(connection, ownerOf(req));
    res.status(201).json({ session: session.snapshot() });
  });

  app.get("/v1/sessions", (req, res) => {
    res.json({ sessions: service.listSessions(ownerOf(req)) });
  });

  app.get("/v1/sessions/:id", (req, res) => {
    res.json({ session: service.sessionSnapshot(req.params.id, ownerOf(req)) });
  });

  app.post("/v1/sessions/:id/reconnect", async (req, res) => {
    const session = await service.createSession(requestConnection(req), ownerOf(req), req.params.id);
    res.json({ session: session.snapshot() });
  });

  // Names the session from its own conversation. The title is persisted with the snapshot, so it
  // survives restarts and shows in the history list.
  app.post("/v1/sessions/:id/title", async (req, res) => {
    const { title, usage } = await service.generateTitle(req.params.id, ownerOf(req));
    res.json({ title, usage: usage ?? null });
  });

  app.get("/v1/sessions/:id/tasks", (req, res) => {
    res.json({ tasks: service.history.listTasks(req.params.id, ownerOf(req)) });
  });

  app.delete("/v1/sessions/:id", async (req, res) => {
    // ?purge=true deletes the saved history, results and artifacts too; the default only closes.
    if (req.query.purge === "true" || req.query.purge === "1") {
      await service.deleteSession(req.params.id, ownerOf(req));
    } else {
      await service.closeSession(req.params.id, ownerOf(req));
    }
    res.status(204).end();
  });

  app.get("/v1/sessions/:id/results", async (req, res) => {
    res.json({ results: await service.listResults(req.params.id, ownerOf(req)) });
  });

  app.post("/v1/sessions/:id/tasks", (req, res) => {
    const session = service.getSession(req.params.id, ownerOf(req));
    const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
    if (!goal || goal.length > 20_000) {
      throw new AppError("INVALID_INPUT", "goal must be a non-empty string under 20000 characters");
    }
    const maxTurns = req.body?.max_turns === undefined
      ? undefined
      : intParam(req.body.max_turns, config.budgets.maxTurns, 1, config.budgets.maxTurns, "max_turns");
    const task = session.submit(goal, { maxTurns });
    res.status(202).json({ task, events_url: `/v1/tasks/${task.id}/events` });
  });

  app.get("/v1/tasks/:id", (req, res) => {
    const { task } = service.findTask(req.params.id, ownerOf(req));
    res.json({ task, session_id: task.session_id });
  });

  app.post("/v1/tasks/:id/cancel", async (req, res) => {
    const { session, task } = service.findTask(req.params.id, ownerOf(req));
    if (!session) throw new AppError("NO_ACTIVE_TASK", "Historical tasks cannot be cancelled");
    const cancelled = await session.cancelTask(task.id);
    res.json({ cancelled, task: session.getTask(task.id) });
  });

  app.post("/v1/tasks/:id/steer", async (req, res) => {
    const { session } = service.findTask(req.params.id, ownerOf(req));
    if (!session) throw new AppError("NO_ACTIVE_TASK", "Historical tasks cannot be steered");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new AppError("INVALID_INPUT", "text is required");
    await session.steer(text);
    res.json({ ok: true });
  });

  app.get("/v1/tasks/:id/events", (req, res) => {
    const taskId = req.params.id;
    const owner = ownerOf(req);
    // Resolve before flushing headers so an unknown task returns a real 404.
    service.findTask(taskId, owner);
    const after = parseSseCursor(req);
    const unsubscribeRef: { fn?: () => void } = {};
    const close = () => {
      unsubscribeRef.fn?.();
      unsubscribeRef.fn = undefined;
    };

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const write = (event: { seq: number; id: string; type: string; data: unknown; at: string; task_id: string }) => {
      if (!res.writableEnded) {
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      unsubscribeRef.fn = service.watchTask(taskId, owner, write, after);
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: (error as AppError).code ?? "ERROR", message: (error as Error).message })}\n\n`);
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      close();
    });
    res.on("close", () => {
      clearInterval(heartbeat);
      close();
    });
  });

  app.get("/v1/results/:id", async (req, res) => {
    const offset = intParam(req.query.offset, 0, 0, 10_000_000, "offset");
    const limit = intParam(req.query.limit, 50, 1, 1_000, "limit");
    const page = await service.readResult(req.params.id, ownerOf(req), offset, limit);
    res.json(page);
  });

  // Streaming keeps a large export to one pass over the file instead of paging from the start.
  app.get("/v1/results/:id/data.csv", async (req, res) => {
    const { filename, truncated, stream } = await service.resultCsv(req.params.id, ownerOf(req), req.ip);
    res.status(200);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", contentDisposition(filename));
    res.setHeader("x-result-truncated", truncated);
    res.setHeader("cache-control", "no-store");
    await pipeline(Readable.from(stream), res);
  });

  // ----------------------------------------------------------------- artifacts

  app.get("/v1/sessions/:id/artifacts", async (req, res) => {
    res.json({ artifacts: await service.listArtifacts(req.params.id, ownerOf(req)) });
  });

  app.get("/v1/artifacts/:id", async (req, res) => {
    res.json({ artifact: await service.getArtifact(req.params.id, ownerOf(req)) });
  });

  app.get("/v1/artifacts/:id/ref", async (req, res) => {
    const artifact = await service.getArtifact(req.params.id, ownerOf(req));
    if (typeof req.query.ref !== "string") throw new AppError("INVALID_INPUT", "ref is required");
    const resolved = service.artifacts.resolve(req.query.ref, artifact);
    if (!resolved) throw new AppError("INVALID_INPUT", "Invalid artifact reference");
    res.json({ ...resolved, columns: artifact.data?.columns, source: artifact.source });
  });

  app.get("/v1/artifacts/:id/data.csv", async (req, res) => {
    const { filename, body } = await service.artifactCsv(req.params.id, ownerOf(req), req.ip);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", contentDisposition(filename));
    res.setHeader("cache-control", "no-store");
    res.send(body);
  });

  // Lightweight console (same API, no build step).
  const webRoot = new URL("../../web/", import.meta.url);
  app.get("/task-stream.js", (_req, res) => {
    void readFile(new URL("task-stream.js", webRoot), "utf8").then(
      (code) => res.type("application/javascript").send(code),
      () => res.status(404).end(),
    );
  });
  app.get("/model-manager.js", (_req, res) => {
    void readFile(new URL("model-manager.js", webRoot), "utf8").then(
      (code) => res.type("application/javascript").send(code),
      () => res.status(404).end(),
    );
  });
  // Vendored ECharts: served from this origin so the console needs no CDN and no build step.
  app.get("/vendor/echarts.min.js", (_req, res) => {
    void readFile(new URL("vendor/echarts.min.js", webRoot)).then(
      (code) => res.type("application/javascript").setHeader("cache-control", "public, max-age=604800").send(code),
      () => res.status(404).end(),
    );
  });
  app.get("/", (_req, res) => {
    void readFile(new URL("index.html", webRoot), "utf8").then(
      (html) => res.type("html").send(html),
      () => res.type("text").send("web console not found; use the HTTP API"),
    );
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (isAppError(error)) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof Error && error.name === "ZodError") {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: error.message } });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Malformed JSON body" } });
      return;
    }
    console.error("unhandled request error", error);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}
