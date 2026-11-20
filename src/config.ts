import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isKnownModelApi, unknownApiMessage } from "./agent/model-apis.js";
import { readPiConfig } from "./agent/pi-config.js";
import type { AnalysisOptions } from "./analysis/options.js";

/**
 * Thinking levels pi accepts. Kept in step with pi-ai's `ModelThinkingLevel`: `xhigh` and `max` are
 * only served by some model families, but pi clamps an unsupported level itself, so listing them is
 * safe and lets the operator pick what their pi config already defaults to.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelConfig {
  provider: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  /** pi-ai wire protocol, e.g. openai-completions / anthropic-messages / openai-responses. */
  api?: string;
  headers?: Record<string, string>;
  thinkingLevel: ThinkingLevel;
  /** Overrides the model's declared thinking capability; defaults to `thinkingLevel !== "off"`. */
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Path to an existing pi auth.json; avoids exporting a key into the service environment. */
  authPath?: string;
}

export interface BudgetConfig {
  maxTurns: number;
  maxQueries: number;
  taskTimeoutMs: number;
  queryTimeoutMs: number;
  maxResultRows: number;
  previewRows: number;
  cellChars: number;
  maxResultBytes: number;
  maxDatasets: number;
  /** Hard cap on rows loaded into a chart artifact; the chart layer never aggregates. */
  maxChartRows: number;
  /** Heatmap cells / cartesian points above this are refused with a TopN or bucketing hint. */
  maxChartCells: number;
  /** Artifacts one task may produce. 0 disables the cap. */
  maxArtifactsPerTask: number;
}

export interface AppConfig {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  sessionTtlMs: number;
  maxSessions: number;
  /** Allow connecting to loopback / RFC1918 targets. Self-hosted deployments usually need this on. */
  allowPrivateNetwork: boolean;
  model: ModelConfig;
  budgets: BudgetConfig;
  analysis?: Partial<AnalysisOptions>;
  env: "development" | "production";
  profileSecretKey?: string;
  requireAuth?: boolean;
  adminPassword?: string;
  secureAuthCookie?: boolean;
  /** Allow the console to override model settings at runtime. Off by default in production. */
  allowModelEdit: boolean;
  /**
   * Express `trust proxy`. Unset keeps `req.ip` on the socket peer, which is the only spoof-proof
   * choice when the port is reachable directly. Behind a reverse proxy set it to the proxy's address
   * or hop count, and bind the published port to loopback so no client can forge X-Forwarded-For.
   */
  trustProxy?: boolean | number | string;
  /**
   * The operator's own pi `models.json` / `settings.json`, read (never written) so the console can
   * offer the channels they already configured. Undefined means "do not look outside the data dir".
   */
  piModelsPath?: string;
  piSettingsPath?: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function nonnegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Express accepts a boolean, a hop count or an address/subnet string in `trust proxy`. */
function trustProxy(name: string): boolean | number | string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  // `1` is a hop count; `true` trusts every hop in the chain, which is only safe when nothing but
  // the proxy can reach this port. Never collapse the two.
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return raw;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** `--env-file <path>` or DATA_AGENT_ENV_FILE override the default `.env`; useful for test profiles. */
function envFileFromArgv(): string | undefined {
  const index = process.argv.indexOf("--env-file");
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return process.argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length);
}

export function loadConfig(): AppConfig {
  const root = resolve(import.meta.dirname, "..");
  const explicitEnv = process.env.DATA_AGENT_ENV_FILE ?? envFileFromArgv();
  loadDotEnv(explicitEnv ? resolve(root, explicitEnv) : resolve(root, ".env"));

  const env = (process.env.NODE_ENV === "production" ? "production" : "development") as AppConfig["env"];
  const apiToken = process.env.DATA_AGENT_API_TOKEN?.trim() ?? "";
  const requireAuth = bool("DATA_AGENT_REQUIRE_AUTH", Boolean(process.env.DATA_AGENT_ADMIN_PASSWORD));
  if (!requireAuth && !apiToken && env === "production") {
    throw new Error("Set DATA_AGENT_REQUIRE_AUTH=1 or DATA_AGENT_API_TOKEN when NODE_ENV=production");
  }

  const dataDir = resolve(process.env.DATA_AGENT_DATA_DIR ?? resolve(root, "data"));
  mkdirSync(resolve(dataDir, "results"), { recursive: true });
  mkdirSync(resolve(dataDir, "pi"), { recursive: true });

  // pi accepts an unknown protocol and only fails mid-task, so reject it where it is read.
  const modelApi = process.env.DATA_AGENT_MODEL_API?.trim() || undefined;
  if (modelApi && !isKnownModelApi(modelApi)) {
    throw new Error(unknownApiMessage(modelApi, "DATA_AGENT_MODEL_API"));
  }
  // Reuse the operator's own pi setup when it is there: their auth.json makes built-in providers
  // (deepseek, moonshotai-cn, ...) usable without exporting a key, and their models.json supplies the
  // custom channels the console lists. Both are only read here; this service never writes to them.
  const importPi = bool("DATA_AGENT_PI_IMPORT", env !== "production");
  const piHome = process.env.DATA_AGENT_PI_HOME ?? join(homedir(), ".pi", "agent");
  const piFile = (envName: string, name: string): string | undefined => {
    if (!importPi) return undefined;
    const explicit = process.env[envName];
    if (explicit) return explicit;
    const candidate = join(piHome, name);
    return existsSync(candidate) ? candidate : undefined;
  };
  const piModelsPath = piFile("DATA_AGENT_PI_MODELS_PATH", "models.json");
  const piSettingsPath = piFile("DATA_AGENT_PI_SETTINGS_PATH", "settings.json");
  const piAuthPath = piFile("DATA_AGENT_MODEL_AUTH_PATH", "auth.json");
  // The model baseline follows pi: whatever channel pi is set to start on is what this service uses,
  // unless `.env` pins it explicitly. Reading it (rather than copying the values here) means a pi
  // upgrade that changes provider, model or thinking level needs no edit in this project.
  const piDefaults = readPiConfig(undefined, piSettingsPath).defaults;
  const modelProvider = process.env.DATA_AGENT_MODEL_PROVIDER?.trim() || piDefaults.provider || "openai";
  const modelId = process.env.DATA_AGENT_MODEL_ID?.trim() || piDefaults.modelId || "gpt-5.2";
  const thinkingLevel = process.env.DATA_AGENT_MODEL_THINKING?.trim() || piDefaults.thinkingLevel || "medium";
  if (!(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    throw new Error(
      `DATA_AGENT_MODEL_THINKING must be one of ${THINKING_LEVELS.join(", ")}` +
        (process.env.DATA_AGENT_MODEL_THINKING ? "" : ` (read "${thinkingLevel}" from pi settings.json)`),
    );
  }

  const reasoningRaw = process.env.DATA_AGENT_MODEL_REASONING?.trim().toLowerCase();
  if (reasoningRaw && reasoningRaw !== "env") {
    if (!["1", "0", "true", "false"].includes(reasoningRaw)) {
      throw new Error("DATA_AGENT_MODEL_REASONING must be 1, 0 or env (follow the thinking level)");
    }
  }

  return {
    host: process.env.DATA_AGENT_HOST ?? "0.0.0.0",
    port: num("DATA_AGENT_PORT", 8787),
    apiToken,
    dataDir,
    sessionTtlMs: num("DATA_AGENT_SESSION_TTL_MS", 60 * 60 * 1000),
    maxSessions: num("DATA_AGENT_MAX_SESSIONS", 20),
    allowPrivateNetwork: bool("DATA_AGENT_ALLOW_PRIVATE_NETWORK", true),
    env,
    profileSecretKey: process.env.DATA_AGENT_PROFILE_SECRET_KEY,
    requireAuth,
    adminPassword: requireAuth ? process.env.DATA_AGENT_ADMIN_PASSWORD : undefined,
    secureAuthCookie: bool("DATA_AGENT_SECURE_AUTH_COOKIE", env === "production"),
    piModelsPath,
    piSettingsPath,
    // Repointing the model (especially `baseUrl`) sends database answers to another endpoint, so a
    // shared production token must not be able to do it by accident.
    allowModelEdit: bool("DATA_AGENT_ALLOW_MODEL_EDIT", env !== "production"),
    trustProxy: trustProxy("DATA_AGENT_TRUST_PROXY"),
    model: {
      // Deliberately NOT PI_*: those are inherited by the pi harness itself and would collide.
      provider: modelProvider,
      modelId,
      apiKey: process.env.DATA_AGENT_MODEL_API_KEY,
      baseUrl: process.env.DATA_AGENT_MODEL_BASE_URL,
      authPath: piAuthPath,
      api: process.env.DATA_AGENT_MODEL_API,
      headers: process.env.DATA_AGENT_MODEL_HEADERS
        ? (JSON.parse(process.env.DATA_AGENT_MODEL_HEADERS) as Record<string, string>)
        : undefined,
      thinkingLevel: thinkingLevel as ModelConfig["thinkingLevel"],
      reasoning: reasoningRaw === "1" || reasoningRaw === "true" ? true : reasoningRaw === "0" || reasoningRaw === "false" ? false : undefined,
      contextWindow: process.env.DATA_AGENT_MODEL_CONTEXT_WINDOW
        ? num("DATA_AGENT_MODEL_CONTEXT_WINDOW", 128000)
        : undefined,
      maxTokens: process.env.DATA_AGENT_MODEL_MAX_TOKENS ? num("DATA_AGENT_MODEL_MAX_TOKENS", 16384) : undefined,
    },
    analysis: {
      metadataTtlMs: nonnegative("DATA_AGENT_METADATA_TTL_MS", 300_000),
      metadataConcurrency: Math.max(1, Math.min(4, Math.floor(num("DATA_AGENT_METADATA_CONCURRENCY", 2)))),
      resultCacheTtlMs: nonnegative("DATA_AGENT_RESULT_CACHE_TTL_MS", 60_000),
      preflight: (() => { const v = process.env.DATA_AGENT_PREFLIGHT ?? "warn"; if (!["off", "warn", "enforce"].includes(v)) throw new Error("DATA_AGENT_PREFLIGHT must be off|warn|enforce"); return v as "off" | "warn" | "enforce"; })(),
      maxEstimatedScanRows: num("DATA_AGENT_MAX_ESTIMATED_SCAN_ROWS", 5_000_000),
      maxEstimatedCost: num("DATA_AGENT_MAX_ESTIMATED_COST", 1_000_000),
      maxLocalRows: num("DATA_AGENT_MAX_LOCAL_ROWS", 100_000),
      maxLocalBytes: num("DATA_AGENT_MAX_LOCAL_BYTES", 64 * 1024 * 1024),
      maxSessionBytes: num("DATA_AGENT_MAX_SESSION_BYTES", 1024 * 1024 * 1024),
      // Unbounded growth is a production outage, so production defaults to 30 days. Development
      // keeps evidence around until asked; set 0 explicitly to disable it anywhere.
      retentionDays: nonnegative("DATA_AGENT_RETENTION_DAYS", env === "production" ? 30 : 0),
      maxSeries: num("DATA_AGENT_MAX_CHART_SERIES", 30),
      masking: (() => {
        const rules: unknown = JSON.parse(process.env.DATA_AGENT_COLUMN_MASKS ?? "[]");
        if (!Array.isArray(rules) || rules.some(r => !r || typeof r.column !== "string" || !/^[\\p{L}\\p{N}_ .-]{1,128}$/u.test(r.column) || !["partial", "hash", "deny"].includes(r.mode))) throw new Error("Invalid DATA_AGENT_COLUMN_MASKS");
        return rules;
      })(),
    },
    budgets: {
      maxTurns: num("DATA_AGENT_MAX_TURNS", 40),
      maxQueries: num("DATA_AGENT_MAX_QUERIES", 60),
      taskTimeoutMs: num("DATA_AGENT_TASK_TIMEOUT_MS", 15 * 60 * 1000),
      queryTimeoutMs: num("DATA_AGENT_QUERY_TIMEOUT_MS", 60 * 1000),
      maxResultRows: num("DATA_AGENT_MAX_RESULT_ROWS", 1_000_000),
      previewRows: num("DATA_AGENT_PREVIEW_ROWS", 30),
      cellChars: num("DATA_AGENT_CELL_CHARS", 200),
      maxResultBytes: num("DATA_AGENT_MAX_RESULT_BYTES", 512 * 1024 * 1024),
      maxDatasets: num("DATA_AGENT_MAX_DATASETS", 50),
      maxChartRows: num("DATA_AGENT_MAX_CHART_ROWS", 20_000),
      maxChartCells: num("DATA_AGENT_MAX_CHART_CELLS", 3_600),
      maxArtifactsPerTask: num("DATA_AGENT_MAX_ARTIFACTS_PER_TASK", 12),
    },
  };
}

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|authorization|credential|sshKey|privateKeyPassword/i;

/** Recursively redact values under secret-looking keys. Used for logs and API echoes. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redact(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "***" : redact(item);
    }
    return out as T;
  }
  return value;
}
