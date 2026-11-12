/**
 * The pi-ai wire protocols this service can talk.
 *
 * pi itself accepts any string here: a wrong value is not rejected when the runtime is built, it
 * fails much later as an opaque request error in the middle of an analysis task. This catalogue is
 * therefore the source of truth for both the `.env` parser and the console dropdown, so a typo is a
 * startup error instead of a broken task.
 */
export interface ModelApiInfo {
  id: string;
  label: string;
  /** Offer it in the console. Only protocols that work with just a base URL and an API key. */
  selectable: boolean;
  /** Why it is not selectable: the extra credential or setting it needs. */
  requires?: string;
  /** When to pick it, shown as a hint in the console. */
  note: string;
}

export const MODEL_APIS: readonly ModelApiInfo[] = [
  {
    id: "openai-completions",
    label: "openai-completions",
    selectable: true,
    note: "Chat Completions. The widest gateway compatibility: DeepSeek, Moonshot, Qwen, Ollama, vLLM, one-api, …",
  },
  {
    id: "openai-responses",
    label: "openai-responses",
    selectable: true,
    note: "OpenAI Responses API. Native reasoning items and better tool-call fidelity on OpenAI and Azure-style gateways.",
  },
  {
    id: "anthropic-messages",
    label: "anthropic-messages",
    selectable: true,
    note: "Anthropic Messages API. Claude, plus gateways that expose an Anthropic-compatible endpoint.",
  },
  {
    id: "google-generative-ai",
    label: "google-generative-ai",
    selectable: true,
    note: "Gemini generateContent API, including Google-AI-compatible proxies.",
  },
  {
    id: "mistral-conversations",
    label: "mistral-conversations",
    selectable: false,
    requires: "a Mistral-compatible endpoint",
    note: "Mistral Conversations API. Rarely served by database-adjacent gateways.",
  },
  {
    id: "azure-openai-responses",
    label: "azure-openai-responses",
    selectable: false,
    requires: "an Azure deployment name and api-version query string",
    note: "Azure OpenAI Responses. Use openai-responses with a full base URL instead.",
  },
  {
    id: "openai-codex-responses",
    label: "openai-codex-responses",
    selectable: false,
    requires: "a ChatGPT Codex OAuth login",
    note: "Codex subscription endpoint; not reachable with a plain API key.",
  },
  {
    id: "bedrock-converse-stream",
    label: "bedrock-converse-stream",
    selectable: false,
    requires: "AWS credentials and a region",
    note: "Amazon Bedrock. Credentials come from the AWS chain, not from DATA_AGENT_MODEL_API_KEY.",
  },
  {
    id: "google-vertex",
    label: "google-vertex",
    selectable: false,
    requires: "a Google Cloud project, location and service-account credentials",
    note: "Vertex AI. Use google-generative-ai with an API key instead.",
  },
  {
    id: "pi-messages",
    label: "pi-messages",
    selectable: false,
    requires: "a pi-hosted endpoint",
    note: "Internal pi protocol.",
  },
] as const;

/** Default wire protocol: the one nearly every OpenAI-compatible gateway speaks. */
export const DEFAULT_MODEL_API = "openai-completions";

export const SELECTABLE_MODEL_APIS: readonly ModelApiInfo[] = MODEL_APIS.filter((api) => api.selectable);

const BY_ID = new Map(MODEL_APIS.map((api) => [api.id, api]));

export function findModelApi(id: string | null | undefined): ModelApiInfo | undefined {
  if (!id) return undefined;
  return BY_ID.get(id.trim());
}

export function isKnownModelApi(id: string): boolean {
  return BY_ID.has(id.trim());
}

/** Error text listing valid values; used by both config parsing and the settings API. */
export function unknownApiMessage(id: string, envName: string): string {
  const selectable = SELECTABLE_MODEL_APIS.map((api) => api.id).join(", ");
  const advanced = MODEL_APIS.filter((api) => !api.selectable).map((api) => api.id);
  return (
    `${envName} must be one of the protocols pi-ai can speak. ` +
    `Supported here: ${selectable}. Known but unsupported in this service: ${advanced.join(", ")}. Got "${id}".`
  );
}
