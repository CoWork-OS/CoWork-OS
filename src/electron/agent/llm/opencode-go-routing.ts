export function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    return url.hostname.toLowerCase() === "opencode.ai" && /\/zen\/go(?:\/|$)/i.test(url.pathname);
  } catch {
    return trimmed.toLowerCase().includes("opencode.ai/zen/go/");
  }
}

export function isOpenCodeZenBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    return (
      url.hostname.toLowerCase() === "opencode.ai" &&
      /\/zen\/v\d+(?:[a-z]+\d*)?(?:\/|$)/i.test(url.pathname) &&
      !/\/zen\/go(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return /opencode\.ai\/zen\/v\d+(?:[a-z]+\d*)?(?:\/|$)/i.test(trimmed);
  }
}

export function isOpenCodeBaseUrl(baseUrl: string): boolean {
  return isOpenCodeGoBaseUrl(baseUrl) || isOpenCodeZenBaseUrl(baseUrl);
}

export type OpenCodeModelTransport = "responses" | "chat_completions" | "messages";
export type OpenCodeProduct = "zen" | "go";

function withoutOpenCodePrefix(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("opencode-go/")) return trimmed.slice("opencode-go/".length);
  if (lower.startsWith("opencode/")) return trimmed.slice("opencode/".length);
  return trimmed;
}

export function normalizeOpenCodeGoModelId(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("opencode-go/")) {
    return trimmed.slice("opencode-go/".length);
  }
  if (lower.startsWith("opencode/")) {
    return trimmed.slice("opencode/".length);
  }
  return trimmed;
}

export function isOpenCodeAnthropicMessagesModel(model: string, product: OpenCodeProduct): boolean {
  const normalized = withoutOpenCodePrefix(model).toLowerCase();
  const withoutVariant = normalized.includes(":")
    ? normalized.slice(0, normalized.indexOf(":"))
    : normalized;
  return (
    withoutVariant.startsWith("claude-") ||
    /^qwen3\.(?:8-max|7-max|7-plus|6-plus|5-plus)$/.test(withoutVariant) ||
    (product === "go" && /^minimax-m(?:3|2\.7|2\.5)$/.test(withoutVariant))
  );
}

export function isOpenCodeGoAnthropicMessagesModel(model: string): boolean {
  return isOpenCodeAnthropicMessagesModel(model, "go");
}

export function isOpenCodeResponsesModel(model: string): boolean {
  const normalized = withoutOpenCodePrefix(model).toLowerCase();
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("grok-") ||
    normalized.startsWith("muse-spark-1.2")
  );
}

export function getOpenCodeModelTransport(
  model: string,
  product: OpenCodeProduct,
): OpenCodeModelTransport {
  if (isOpenCodeResponsesModel(model)) return "responses";
  if (isOpenCodeAnthropicMessagesModel(model, product)) return "messages";
  return "chat_completions";
}

export function normalizeOpenCodeGoAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  for (const suffix of ["/chat/completions", "/messages", "/responses", "/models"]) {
    if (lower.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
}
