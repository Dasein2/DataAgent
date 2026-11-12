import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { isModelEnabled, type PiConfigSnapshot } from "./pi-config.js";

/** Body of `POST /v1/model/select`; the channel must exist, so both fields are plain strings. */
export const ChannelSelection = z.object({
  provider: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200),
});
export type ChannelSelectionRequest = z.infer<typeof ChannelSelection>;

/** A single pickable model inside a channel. */
export interface ChannelModelInfo {
  id: string;
  name: string;
  api: string;
  context_window: number | null;
  max_tokens: number | null;
  reasoning: boolean;
  input: string[];
  /** Listed in pi's `enabledModels` globs. Empty globs mean everything is enabled. */
  enabled: boolean;
}

export interface ChannelInfo {
  id: string;
  name: string;
  /** `pi-models` channels come from the operator's own pi config; `builtin` from pi's catalogue. */
  source: "pi-models" | "builtin";
  /** A credential resolves for this channel, so switching to it can actually run a task. */
  ready: boolean;
  key_source: "channel" | "pi-auth" | "none";
  enabled_count: number;
  total_count: number;
  models: ChannelModelInfo[];
}

export interface ChannelCatalog {
  channels: ChannelInfo[];
  active: { provider: string; model_id: string };
  enabled_models: string[];
  sources: {
    models: PiConfigSnapshot["models"];
    settings: PiConfigSnapshot["settings"];
  };
  /** True when the channel list was narrowed by `enabledModels`, so the console can explain why. */
  filtered: boolean;
  note: string;
}

/** Long model lists (openai has 44) would drown the console; the rest are counted only. */
const MAX_MODELS_PER_CHANNEL = 40;

export interface ChannelCatalogInput {
  runtime: ModelRuntime;
  pi: PiConfigSnapshot;
  active: { provider: string; model_id: string };
}

/**
 * Groups every channel the operator can plausibly use, the way pi's own model picker does: built-in
 * providers narrowed by `enabledModels`, plus every custom provider from their models.json.
 */
export function buildChannelCatalog({ runtime, pi, active }: ChannelCatalogInput): ChannelCatalog {
  const ids: string[] = runtime.getProviders().map((provider) => provider.id);
  for (const id of Object.keys(pi.providers)) if (!ids.includes(id)) ids.push(id);

  const channels: ChannelInfo[] = [];
  for (const id of ids) {
    const source = id in pi.providers ? "pi-models" : "builtin";
    const isActive = id === active.provider;
    const models: ChannelModelInfo[] = runtime.getModels(id).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      api: model.api,
      context_window: model.contextWindow ?? null,
      max_tokens: model.maxTokens ?? null,
      reasoning: Boolean(model.reasoning),
      input: [...model.input],
      enabled: isModelEnabled(pi.enabledModels, id, model.id),
    }));
    const enabledModels = models.filter((model) => model.enabled);
    const status = runtime.getProviderAuthStatus(id);
    const keySource: ChannelInfo["key_source"] = pi.apiKeys[id]
      ? "channel"
      : status.configured
        ? // `runtime` means we injected the key ourselves before building this handle.
          "pi-auth"
        : "none";
    const ready = keySource !== "none";
    const include =
      source === "pi-models" ||
      isActive ||
      ready ||
      (pi.enabledModels.length > 0 ? enabledModels.length > 0 : false);
    if (!include) continue;
    if (models.length === 0 && !isActive) continue;

    // Enabled models first so the console can show the configured ones and hide the rest.
    const ordered = [...enabledModels, ...models.filter((model) => !model.enabled)];
    channels.push({
      id,
      name: runtime.getProvider(id)?.name ?? String(pi.providers[id]?.name ?? id),
      source,
      ready,
      key_source: keySource,
      enabled_count: enabledModels.length,
      total_count: models.length,
      models: ordered.slice(0, MAX_MODELS_PER_CHANNEL),
    });
  }

  // The active channel has to be reachable no matter what the filters decided.
  if (!channels.some((channel) => channel.id === active.provider)) {
    const status = runtime.getProviderAuthStatus(active.provider);
    channels.push({
      id: active.provider,
      name: runtime.getProvider(active.provider)?.name ?? active.provider,
      source: active.provider in pi.providers ? "pi-models" : "builtin",
      ready: status.configured,
      key_source: status.configured ? "pi-auth" : "none",
      enabled_count: 1,
      total_count: 1,
      models: [
        {
          id: active.model_id,
          name: active.model_id,
          api: runtime.getModel(active.provider, active.model_id)?.api ?? "unknown",
          context_window: runtime.getModel(active.provider, active.model_id)?.contextWindow ?? null,
          max_tokens: runtime.getModel(active.provider, active.model_id)?.maxTokens ?? null,
          reasoning: Boolean(runtime.getModel(active.provider, active.model_id)?.reasoning),
          input: ["text"],
          enabled: true,
        },
      ],
    });
  }

  // Active channel first, then the operator's own channels, then pi's built-ins.
  channels.sort((a, b) => {
    if (a.id === active.provider) return -1;
    if (b.id === active.provider) return 1;
    if (a.source !== b.source) return a.source === "pi-models" ? -1 : 1;
    return 0;
  });

  const filtered = pi.enabledModels.length > 0;
  return {
    channels,
    active,
    enabled_models: pi.enabledModels,
    sources: { models: pi.models, settings: pi.settings },
    filtered,
    note: filtered
      ? "只列出 pi settings.json 里 enabledModels 命中的渠道，以及你自己的 models.json 渠道。"
      : "没有 enabledModels 过滤，列出所有已配置凭证的渠道和你自己的 models.json 渠道。",
  };
}
