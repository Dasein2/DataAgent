import { AppError } from "../errors.js";

/** Discovery reports what the server actually advertises; it never guesses limits or reasoning. */
export function parseModelList(value: unknown): { id: string; name?: string }[] {
  const root = value as any;
  const list = Array.isArray(root) ? root : root?.data ?? root?.models ?? root?.items;
  if (!Array.isArray(list)) throw new AppError("INVALID_INPUT", "Model endpoint did not return a model list");
  const found = new Map<string, { id: string; name?: string }>();
  for (const item of list.slice(0, 2000)) {
    const raw = typeof item === "string" ? item : item?.id ?? item?.name;
    if (typeof raw !== "string") continue;
    const id = raw.replace(/^models\//, "").trim();
    if (!id || id.length > 200) continue;
    const name = typeof item?.displayName === "string" ? item.displayName : item?.name;
    found.set(id, { id, ...(typeof name === "string" && name !== raw ? { name: name.slice(0, 200) } : {}) });
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverModels(api: string, baseUrl: string, key?: string, privateHeaders: Record<string, string> = {}) {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/$/, "");
  if (api === "anthropic-messages" && !/\/v\d+$/.test(path)) path += "/v1";
  if (api === "google-generative-ai" && !/\/v\d+(beta)?$/.test(path)) path += "/v1beta";
  url.pathname = path + "/models";
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) {
    if (api === "anthropic-messages") headers["x-api-key"] = key;
    else if (api === "google-generative-ai") headers["x-goog-api-key"] = key;
    else headers.authorization = "Bearer " + key;
  }
  if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  const response = await fetch(url, { headers: { ...headers, ...privateHeaders }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  // Don't echo upstream error bodies: some gateways include request headers in them.
  if (!response.ok) throw new AppError("INVALID_INPUT", `Model discovery returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("INVALID_INPUT", "Empty discovery response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new AppError("INVALID_INPUT", "Model list exceeds 2 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return parseModelList(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
