import { existsSync, readFileSync } from "node:fs";

/**
 * Read-only view of the operator's own pi configuration.
 *
 * The service keeps its generated `models.json` inside its data directory, so without this the
 * console could only offer what `DATA_AGENT_MODEL_*` describes. Importing lets an operator switch to
 * a channel they already configured in pi (a gateway, a second vendor) without retyping it — and
 * without this service ever copying a credential to disk: key material stays in memory, and the
 * provider blocks we write back out are stripped.
 */

export type PiFileStatus = "missing" | "ok" | "invalid";

export interface PiConfigSnapshot {
  /** Provider blocks from pi's models.json, ready to be echoed into our generated file. */
  providers: Record<string, Record<string, unknown>>;
  /** Provider API keys from that file. Held in memory only; never written or returned. */
  apiKeys: Record<string, string>;
  /** `enabledModels` from pi's settings.json; empty means "everything is enabled". */
  enabledModels: string[];
  /**
   * The channel pi itself starts on (`defaultProvider` / `defaultModel` / `defaultThinkingLevel`).
   * The service uses these when `.env` leaves the model unset, so upgrading pi does not require
   * editing three more variables here.
   */
  defaults: { provider?: string; modelId?: string; thinkingLevel?: string };
  models: { path: string | null; status: PiFileStatus; providers: number };
  settings: { path: string | null; status: PiFileStatus };
}

const EMPTY: PiConfigSnapshot = {
  providers: {},
  apiKeys: {},
  enabledModels: [],
  defaults: {},
  models: { path: null, status: "missing", providers: 0 },
  settings: { path: null, status: "missing" },
};

/** `${ENV}` and `!command` values are resolved by pi; they are references, not secrets. */
function isReference(value: string): boolean {
  return value.startsWith("$") || value.startsWith("!");
}

function readJson(path: string): { status: PiFileStatus; value?: unknown } {
  if (!existsSync(path)) return { status: "missing" };
  try {
    return { status: "ok", value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Removes credentials from a provider block. `oauth` is dropped as well: this service never performs
 * an OAuth flow, and pi reads such credentials from its own auth store instead.
 */
export function stripSecrets(block: Record<string, unknown>): Record<string, unknown> {
  const { apiKey, oauth, ...rest } = block;
  const copy: Record<string, unknown> = { ...rest };
  // A non-secret reference is kept so pi can resolve it itself.
  if (typeof apiKey === "string" && isReference(apiKey)) copy.apiKey = apiKey;
  return copy;
}

export function readPiConfig(modelsPath?: string, settingsPath?: string): PiConfigSnapshot {
  if (!modelsPath && !settingsPath) return EMPTY;
  const snapshot: PiConfigSnapshot = {
    providers: {},
    apiKeys: {},
    enabledModels: [],
    defaults: {},
    models: { path: modelsPath ?? null, status: "missing", providers: 0 },
    settings: { path: settingsPath ?? null, status: "missing" },
  };

  if (modelsPath) {
    const models = readJson(modelsPath);
    snapshot.models.status = models.status;
    const providers = (models.value as { providers?: unknown } | undefined)?.providers;
    if (models.status === "ok" && providers && typeof providers === "object") {
      for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        snapshot.providers[id] = stripSecrets(block);
        if (typeof block.apiKey === "string" && !isReference(block.apiKey)) {
          snapshot.apiKeys[id] = block.apiKey;
        }
      }
      snapshot.models.providers = Object.keys(snapshot.providers).length;
    }
  }

  if (settingsPath) {
    const settings = readJson(settingsPath);
    snapshot.settings.status = settings.status;
    const value = settings.value as
      | { enabledModels?: unknown; defaultProvider?: unknown; defaultModel?: unknown; defaultThinkingLevel?: unknown }
      | undefined;
    const enabled = value?.enabledModels;
    if (Array.isArray(enabled)) {
      snapshot.enabledModels = enabled.filter((entry): entry is string => typeof entry === "string");
    }
    if (typeof value?.defaultProvider === "string" && value.defaultProvider.trim()) {
      snapshot.defaults.provider = value.defaultProvider.trim();
    }
    if (typeof value?.defaultModel === "string" && value.defaultModel.trim()) {
      snapshot.defaults.modelId = value.defaultModel.trim();
    }
    if (typeof value?.defaultThinkingLevel === "string" && value.defaultThinkingLevel.trim()) {
      snapshot.defaults.thinkingLevel = value.defaultThinkingLevel.trim();
    }
  }

  return snapshot;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** pi enables models through `enabledModels` globs such as `deepseek/*`; empty means all of them. */
export function isModelEnabled(globs: readonly string[], provider: string, modelId: string): boolean {
  if (globs.length === 0) return true;
  const full = `${provider}/${modelId}`;
  return globs.some((glob) => globMatches(glob, full));
}
