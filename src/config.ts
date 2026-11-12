import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ModelConfig {
  provider: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  /** pi-ai protocol, e.g. openai-completions / anthropic-messages / openai-responses */
  api?: string;
  headers?: Record<string, string>;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
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
  env: "development" | "production";
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
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
  if (!apiToken && env === "production") {
    throw new Error("DATA_AGENT_API_TOKEN is required when NODE_ENV=production");
  }

  const dataDir = resolve(process.env.DATA_AGENT_DATA_DIR ?? resolve(root, "data"));
  mkdirSync(resolve(dataDir, "results"), { recursive: true });
  mkdirSync(resolve(dataDir, "pi"), { recursive: true });

  return {
    host: process.env.DATA_AGENT_HOST ?? "0.0.0.0",
    port: num("DATA_AGENT_PORT", 8787),
    apiToken,
    dataDir,
    sessionTtlMs: num("DATA_AGENT_SESSION_TTL_MS", 60 * 60 * 1000),
    maxSessions: num("DATA_AGENT_MAX_SESSIONS", 20),
    allowPrivateNetwork: bool("DATA_AGENT_ALLOW_PRIVATE_NETWORK", true),
    env,
    model: {
      // Deliberately NOT PI_*: those are inherited by the pi harness itself and would collide.
      provider: process.env.DATA_AGENT_MODEL_PROVIDER ?? "openai",
      modelId: process.env.DATA_AGENT_MODEL_ID ?? "gpt-5.2",
      apiKey: process.env.DATA_AGENT_MODEL_API_KEY,
      baseUrl: process.env.DATA_AGENT_MODEL_BASE_URL,
      authPath: process.env.DATA_AGENT_MODEL_AUTH_PATH,
      api: process.env.DATA_AGENT_MODEL_API,
      headers: process.env.DATA_AGENT_MODEL_HEADERS
        ? (JSON.parse(process.env.DATA_AGENT_MODEL_HEADERS) as Record<string, string>)
        : undefined,
      thinkingLevel: (process.env.DATA_AGENT_MODEL_THINKING as ModelConfig["thinkingLevel"]) ?? "medium",
      contextWindow: process.env.DATA_AGENT_MODEL_CONTEXT_WINDOW
        ? num("DATA_AGENT_MODEL_CONTEXT_WINDOW", 128000)
        : undefined,
      maxTokens: process.env.DATA_AGENT_MODEL_MAX_TOKENS ? num("DATA_AGENT_MODEL_MAX_TOKENS", 16384) : undefined,
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
