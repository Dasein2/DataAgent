import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelConfig } from "../config.js";
import { findModelApi, unknownApiMessage } from "./model-apis.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Wire protocol name. Validated against the catalogue rather than free text: pi accepts any string
 * and only fails mid-task, so an unknown protocol has to be rejected while it is being saved.
 */
const apiName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => Boolean(findModelApi(value)), {
    message: unknownApiMessage("$value", "api"),
  });

/**
 * Fields a console may override on top of the environment configuration.
 *
 * `undefined` (field absent) means "leave the current override alone"; `null` means "drop the
 * override and fall back to the environment value". A patch therefore cannot express "clear the
 * environment value itself" — the service environment stays the floor, which keeps `.env` and the
 * console from disagreeing in ways an operator cannot see.
 */
export const ModelPatch = z.object({
  provider: z.string().trim().min(1).max(60).nullable().optional(),
  modelId: z.string().trim().min(1).max(120).nullable().optional(),
  /** pi-ai wire protocol; one of the ids in model-apis.ts. */
  api: apiName.nullable().optional(),
  baseUrl: z.string().trim().url().max(500).nullable().optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).nullable().optional(),
  /** Thinking capability; `null` falls back to "thinkingLevel !== off". */
  reasoning: z.boolean().nullable().optional(),
  contextWindow: z.number().int().min(1_024).max(4_000_000).nullable().optional(),
  maxTokens: z.number().int().min(64).max(1_000_000).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  /** Write-only, held in memory: accepted by the API, never persisted and never echoed back. */
  apiKey: z.string().trim().max(500).nullable().optional(),
});
export type ModelPatch = z.infer<typeof ModelPatch>;

/** Everything the store persists. The API key is deliberately absent. */
export type ModelOverrides = Omit<ModelPatch, "apiKey">;

const OVERRIDE_FIELDS = [
  "provider",
  "modelId",
  "api",
  "baseUrl",
  "thinkingLevel",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "headers",
] as const;

const StoredSettings = z.object({
  version: z.literal(1),
  updated_at: z.string().optional(),
  overrides: z.object({
    provider: z.string().optional(),
    modelId: z.string().optional(),
    api: z.string().optional(),
    baseUrl: z.string().optional(),
    thinkingLevel: z.enum(THINKING_LEVELS).optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().int().optional(),
    maxTokens: z.number().int().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});

export interface ModelOverridesStoreState {
  overrides: ModelOverrides;
  /** `missing` until the console saves something; `invalid` when the file cannot be trusted. */
  status: "missing" | "ok" | "invalid";
  path: string;
}

/** Applies console overrides on top of the environment baseline. */
export function effectiveModel(env: ModelConfig, overrides: ModelOverrides, consoleApiKey?: string): ModelConfig {
  return {
    ...env,
    provider: overrides.provider ?? env.provider,
    modelId: overrides.modelId ?? env.modelId,
    api: overrides.api ?? env.api,
    baseUrl: overrides.baseUrl ?? env.baseUrl,
    thinkingLevel: overrides.thinkingLevel ?? env.thinkingLevel,
    reasoning: overrides.reasoning ?? env.reasoning,
    contextWindow: overrides.contextWindow ?? env.contextWindow,
    maxTokens: overrides.maxTokens ?? env.maxTokens,
    headers: overrides.headers ?? env.headers,
    // A console key wins over the environment for this process only; it is never written to disk.
    apiKey: consoleApiKey ?? env.apiKey,
  };
}

/** Merges a patch into the stored overrides; `null` clears a field back to the environment value. */
export function mergeOverrides(current: ModelOverrides, patch: ModelPatch): ModelOverrides {
  const next: Record<string, unknown> = { ...current };
  for (const field of OVERRIDE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return next as ModelOverrides;
}

/**
 * Console-editable model settings persisted next to the other service data.
 *
 * Only non-secret fields are stored; the API key stays in process memory so an operator who edits
 * it in the console has to set `DATA_AGENT_MODEL_API_KEY` to make it survive a restart.
 */
export class ModelSettingsStore {
  private overrides: ModelOverrides = {};
  private status: "missing" | "ok" | "invalid" = "missing";

  constructor(readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = StoredSettings.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) {
        this.status = "invalid";
        return;
      }
      this.overrides = parsed.data.overrides as ModelOverrides;
      this.status = "ok";
    } catch {
      this.status = "invalid";
    }
  }

  get(): ModelOverrides {
    return { ...this.overrides };
  }

  state(): ModelOverridesStoreState {
    return { overrides: this.get(), status: this.status, path: this.path };
  }

  save(overrides: ModelOverrides): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const body = JSON.stringify({ version: 1, updated_at: new Date().toISOString(), overrides }, null, 2);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, this.path);
    this.overrides = { ...overrides };
    this.status = "ok";
  }

  clear(): void {
    if (existsSync(this.path)) rmSync(this.path, { force: true });
    this.overrides = {};
    this.status = "missing";
  }
}
