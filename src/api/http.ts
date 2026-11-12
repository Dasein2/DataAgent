import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import { ConnectionConfig } from "../db/types.js";
import { ENGINE_IDS, describeEngine, getProfile } from "../db/engines/profiles.js";
import { AppError, isAppError } from "../errors.js";
import { AnalysisService, callerKey } from "../agent/service.js";

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

  // Let consoles and integrators pull the engine list instead of hard-coding a dropdown. The same
  // descriptors drive session capabilities, so the two can never disagree.
  app.get("/v1/engines", (_req, res) => {
    res.json({ engines: ENGINE_IDS.map((id) => describeEngine(getProfile(id))) });
  });

  app.get("/v1/capabilities", (_req, res) => {
    res.json({
      engines: ENGINE_IDS,
      source_access: "read_only",
      workspace_access: ["none", "views_only", "tables_and_views"],
      tool_names: [
        "session_info",
        "catalog_search",
        "object_describe",
        "data_profile",
        "query_explain",
        "query_execute",
        "job_get",
        "job_cancel",
        "result_read",
        "dataset_create",
        "dataset_list",
        "dataset_drop",
      ],
      budgets: {
        max_turns: config.budgets.maxTurns,
        max_queries: config.budgets.maxQueries,
        task_timeout_ms: config.budgets.taskTimeoutMs,
        query_timeout_ms: config.budgets.queryTimeoutMs,
        preview_rows: config.budgets.previewRows,
        cell_chars: config.budgets.cellChars,
        max_datasets: config.budgets.maxDatasets,
      },
      limits: {
        max_sessions: config.maxSessions,
        session_ttl_ms: config.sessionTtlMs,
        max_sse_backlog_events: 5_000,
      },
    });
  });

  app.post("/v1/connections/test", async (req, res) => {
    const connection = parseConnection(req.body?.connection ?? req.body);
    res.json(await service.testConnection(connection));
  });

  app.post("/v1/sessions", async (req, res) => {
    const connection = parseConnection(req.body?.connection ?? req.body);
    const session = await service.createSession(connection, ownerOf(req));
    res.status(201).json({ session: session.snapshot() });
  });

  app.get("/v1/sessions", (req, res) => {
    res.json({ sessions: service.listSessions(ownerOf(req)) });
  });

  app.get("/v1/sessions/:id", (req, res) => {
    const session = service.getSession(req.params.id, ownerOf(req));
    res.json({ session: session.snapshot() });
  });

  app.delete("/v1/sessions/:id", async (req, res) => {
    await service.closeSession(req.params.id, ownerOf(req));
    res.status(204).end();
  });

  app.get("/v1/sessions/:id/results", (req, res) => {
    const session = service.getSession(req.params.id, ownerOf(req));
    void session.db.listResults().then(
      (results) => res.json({ results }),
      (error) => res.status(500).json({ error: { code: "INTERNAL_ERROR", message: String(error) } }),
    );
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
    const { task, session } = service.findTask(req.params.id, ownerOf(req));
    res.json({ task, session_id: session.id });
  });

  app.post("/v1/tasks/:id/cancel", async (req, res) => {
    const { session, task } = service.findTask(req.params.id, ownerOf(req));
    const cancelled = await session.cancelTask(task.id);
    res.json({ cancelled, task: session.getTask(task.id) });
  });

  app.post("/v1/tasks/:id/steer", async (req, res) => {
    const { session } = service.findTask(req.params.id, ownerOf(req));
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new AppError("INVALID_INPUT", "text is required");
    await session.steer(text);
    res.json({ ok: true });
  });

  app.get("/v1/tasks/:id/events", (req, res) => {
    const taskId = req.params.id;
    const owner = ownerOf(req);
    // Resolve before flushing headers so an unknown task returns a real 404.
    const { session } = service.findTask(taskId, owner);
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
      unsubscribeRef.fn = session.watch(taskId, write, after);
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

  // Lightweight console (same API, no build step).
  const webRoot = new URL("../../web/", import.meta.url);
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
