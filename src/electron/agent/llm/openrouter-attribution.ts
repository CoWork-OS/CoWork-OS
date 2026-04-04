const DEFAULT_OPENROUTER_ATTRIBUTION_URL = "https://github.com/CoWork-OS/CoWork-OS";
const DEFAULT_OPENROUTER_ATTRIBUTION_TITLE = "CoWork OS";

export function getOpenRouterAttributionHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": DEFAULT_OPENROUTER_ATTRIBUTION_URL,
    "X-OpenRouter-Title": DEFAULT_OPENROUTER_ATTRIBUTION_TITLE,
    // Keep the legacy title header for compatibility with older OpenRouter examples.
    "X-Title": DEFAULT_OPENROUTER_ATTRIBUTION_TITLE,
  };
}
