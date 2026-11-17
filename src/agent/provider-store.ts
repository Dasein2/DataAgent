import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { THINKING_LEVELS } from "../config.js";
import { AppError } from "../errors.js";
import { findModelApi } from "./model-apis.js";

// HTTP inputs are data, never pi's executable !command / $ENV credential expressions.
const literal = z.string().max(2000).refine((v) => !v.trim().startsWith("!") && !v.includes("$"), "Only literal values are accepted");
const endpoint = z.string().url().max(500).refine((v) => {
  const url = new URL(v);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "Use an HTTP(S) base URL without credentials, query or fragment");
const jsonOptions = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export const ManagedModel = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(["text", "image"])).min(1).default(["text"]),
  contextWindow: z.number().int().min(1024).max(4_000_000).default(128_000),
  maxTokens: z.number().int().min(64).max(1_048_576).default(16_384),
  thinkingLevelMap: z.record(z.enum(THINKING_LEVELS), z.string().max(40).nullable()).optional(),
  compat: jsonOptions.optional(),
}).strict().refine((m) => m.maxTokens <= m.contextWindow, "maxTokens cannot exceed contextWindow");
export const ProviderConfig = z.object({
  name: z.string().trim().min(1).max(120),
  api: z.string().refine((v) => findModelApi(v)?.selectable === true, "Unsupported API protocol"),
  baseUrl: endpoint,
  models: z.array(ManagedModel).min(1).max(200),
  // Sensitive headers live in the key store, not in this public configuration file.
  compat: jsonOptions.optional(),
  authMode: z.enum(["key", "none"]).default("key"),
}).strict().refine((p) => new Set(p.models.map((m) => m.id)).size === p.models.length, "Duplicate model IDs");
export const ProviderWrite = ProviderConfig.safeExtend({
  apiKey: literal.refine((v) => v.trim().length > 0 && !/[\r\n]/.test(v), "API key must be non-empty and single-line").nullable().optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), literal.refine((v) => !/[\r\n]/.test(v), "Header values must be single-line")).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;
export type ProviderWrite = z.infer<typeof ProviderWrite>;
export const ProviderId = z.string().trim().min(1).max(120).refine((id) => !Object.hasOwn(Object.prototype, id) && id !== "prototype" && !/[\x00-\x1f/\\]/.test(id), "Invalid provider ID");
const FileSchema = z.object({ version: z.literal(1), providers: z.record(ProviderId, ProviderConfig) });

/** Project-owned, credential-free catalogue. Unreadable files are never overwritten silently. */
export class ProviderStore {
  private providers: Record<string, ProviderConfig> = {};
  status: "missing" | "ok" | "invalid";
  constructor(readonly path: string) {
    if (!existsSync(path)) { this.status = "missing"; return; }
    try {
      this.providers = FileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).providers;
      this.status = "ok";
    } catch { this.status = "invalid"; }
  }
  all(): Record<string, ProviderConfig> { return structuredClone(this.providers); }
  get(id: string): ProviderConfig | undefined { return Object.hasOwn(this.providers, id) ? structuredClone(this.providers[id]) : undefined; }
  save(providers: Record<string, ProviderConfig>): void {
    if (this.status === "invalid") throw new AppError("INVALID_INPUT", "model-providers.json is unreadable; repair it before saving");
    const parsed = FileSchema.parse({ version: 1, providers });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    this.providers = parsed.providers;
    this.status = "ok";
  }
}

export function providerBlocks(providers: Record<string, ProviderConfig>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(providers).map(([id, { authMode, ...config }]) => [id, config]));
}
