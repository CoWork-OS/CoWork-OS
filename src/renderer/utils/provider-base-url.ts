/**
 * Why a provider base URL can't be saved, or null when it can. Empty means "use the
 * provider default". Anything else must be an http(s) address: "not a url" used to save
 * and then every task failed against it.
 */
export function providerBaseUrlProblem(label: string, value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return null;
  } catch {
    // Not a URL at all.
  }
  return `${label} base URL must be a web address starting with http:// or https://, for example http://localhost:1234/v1.`;
}
