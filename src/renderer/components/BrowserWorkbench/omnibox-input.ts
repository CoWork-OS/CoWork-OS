/**
 * Address bar input handling: decide whether text is a URL or a search, and
 * build the suggestion list (open tabs, recently closed pages, search).
 */

export type SearchEngineId = "google" | "bing" | "duckduckgo" | "brave" | "kagi";

export const SEARCH_ENGINES: Record<SearchEngineId, { label: string; template: string }> = {
  google: { label: "Google", template: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", template: "https://www.bing.com/search?q=%s" },
  duckduckgo: { label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  brave: { label: "Brave", template: "https://search.brave.com/search?q=%s" },
  kagi: { label: "Kagi", template: "https://kagi.com/search?q=%s" },
};

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "google";
const SEARCH_ENGINE_STORAGE_KEY = "cowork.browserWorkbench.searchEngine";

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return typeof value === "string" && value in SEARCH_ENGINES;
}

export function readSearchEngine(): SearchEngineId {
  try {
    const stored = window.localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY);
    return isSearchEngineId(stored) ? stored : DEFAULT_SEARCH_ENGINE;
  } catch {
    return DEFAULT_SEARCH_ENGINE;
  }
}

export function writeSearchEngine(engine: SearchEngineId): void {
  try {
    window.localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, engine);
  } catch {
    // Preference only; the default engine is used when storage is unavailable.
  }
}

export function buildSearchUrl(
  query: string,
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
): string {
  const template = SEARCH_ENGINES[engine]?.template || SEARCH_ENGINES.google.template;
  return template.replace("%s", encodeURIComponent(query.trim()));
}

export type OmniboxIntent =
  | { kind: "url"; url: string }
  | { kind: "search"; query: string; url: string }
  | { kind: "unsupported"; scheme: string }
  | { kind: "empty" };

const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?([/?#].*)?$/i;
// A bare IPv6 loopback has no room for a port; the URL needs it in brackets.
const BARE_IPV6_LOOPBACK_PATTERN = /^::1([/?#].*)?$/;
const IPV4_PATTERN = /^(\d{1,3})(\.\d{1,3}){3}(:\d{1,5})?([/?#].*)?$/;
// host.tld[:port][/...] with a letter-only TLD of 2+ chars (or an IDN in punycode).
const HOSTNAME_PATTERN =
  /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})\.?(:\d{1,5})?([/?#].*)?$/iu;
// File extensions that are not top-level domains: "package.json" is a search, not a site.
const FILE_EXTENSION_SUFFIXES = new Set([
  "cjs",
  "conf",
  "csv",
  "css",
  "dmg",
  "docx",
  "exe",
  "gif",
  "htm",
  "html",
  "ini",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "lock",
  "log",
  "mjs",
  "pdf",
  "png",
  "pptx",
  "scss",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "xlsx",
  "xml",
  "yaml",
  "yml",
]);

function hasFileExtensionSuffix(input: string): boolean {
  const host = input.split(/[:/?#]/)[0].replace(/\.$/, "");
  const suffix = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
  return FILE_EXTENSION_SUFFIXES.has(suffix);
}

/**
 * Parse address bar text. URL-looking input navigates (adding http:// for
 * local hosts and https:// otherwise); anything else is a search.
 */
export function parseOmniboxInput(
  rawInput: string,
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
): OmniboxIntent {
  const input = rawInput.trim();
  if (!input) return { kind: "empty" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)?.[1]?.toLowerCase();
  if (scheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    if (scheme === "http" || scheme === "https") {
      try {
        return { kind: "url", url: new URL(input).href };
      } catch {
        return { kind: "search", query: input, url: buildSearchUrl(input, engine) };
      }
    }
    return { kind: "unsupported", scheme };
  }
  if (scheme && ["javascript", "data", "file", "about", "chrome", "mailto"].includes(scheme)) {
    return { kind: "unsupported", scheme };
  }

  if (!/\s/.test(input)) {
    if (LOCAL_HOST_PATTERN.test(input)) return { kind: "url", url: safeHref(`http://${input}`) };
    const bareLoopback = BARE_IPV6_LOOPBACK_PATTERN.exec(input);
    if (bareLoopback) return { kind: "url", url: safeHref(`http://[::1]${bareLoopback[1] || ""}`) };
    const ipv4 = IPV4_PATTERN.exec(input);
    if (
      ipv4 &&
      input
        .split(/[:/?#]/)[0]
        .split(".")
        .every((part) => Number(part) <= 255)
    ) {
      return { kind: "url", url: safeHref(`http://${input}`) };
    }
    if (HOSTNAME_PATTERN.test(input) && !hasFileExtensionSuffix(input)) {
      return { kind: "url", url: safeHref(`https://${input}`) };
    }
  }
  return { kind: "search", query: input, url: buildSearchUrl(input, engine) };
}

function safeHref(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

export type OmniboxSuggestion =
  | { kind: "navigate"; id: string; url: string; label: string }
  | { kind: "switch-tab"; id: string; tabId: string; url: string; label: string }
  | { kind: "page"; id: string; url: string; label: string; detail: string }
  | { kind: "search"; id: string; url: string; label: string };

export type OmniboxSource = {
  /** Open tabs other than the current one. */
  tabs: Array<{ id: string; url: string; title: string }>;
  /** Recently visited or closed pages, most recent first. */
  pages: Array<{ url: string; title: string }>;
};

function matchScore(text: string, query: string): number {
  const value = text.toLowerCase();
  if (!value) return 0;
  const stripped = value.replace(/^https?:\/\/(www\.)?/, "");
  if (stripped.startsWith(query)) return 3;
  if (value.split(/[\s/.\-_?=&]+/).some((word) => word.startsWith(query))) return 2;
  return value.includes(query) ? 1 : 0;
}

/** Suggestions for typed text: navigate/search first, then open tabs, then pages. */
export function buildOmniboxSuggestions(
  rawInput: string,
  source: OmniboxSource,
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
  limit = 8,
): OmniboxSuggestion[] {
  const input = rawInput.trim();
  if (!input) return [];
  const query = input.toLowerCase();
  const intent = parseOmniboxInput(input, engine);
  const suggestions: OmniboxSuggestion[] = [];
  const seenUrls = new Set<string>();

  if (intent.kind === "url") {
    suggestions.push({
      kind: "navigate",
      id: `nav:${intent.url}`,
      url: intent.url,
      label: intent.url,
    });
    seenUrls.add(intent.url);
  }

  const tabMatches = source.tabs
    .map((tab) => ({
      tab,
      score: Math.max(matchScore(tab.title, query), matchScore(tab.url, query)),
    }))
    .filter((entry) => entry.score > 0 && entry.tab.url)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const { tab } of tabMatches) {
    seenUrls.add(tab.url);
    suggestions.push({
      kind: "switch-tab",
      id: `tab:${tab.id}`,
      tabId: tab.id,
      url: tab.url,
      label: tab.title || tab.url,
    });
  }

  const pageMatches = source.pages
    .map((page, index) => ({
      page,
      index,
      score: Math.max(matchScore(page.title, query), matchScore(page.url, query)),
    }))
    .filter((entry) => entry.score > 0 && !seenUrls.has(entry.page.url))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { page } of pageMatches) {
    if (seenUrls.has(page.url)) continue;
    seenUrls.add(page.url);
    suggestions.push({
      kind: "page",
      id: `page:${page.url}`,
      url: page.url,
      label: page.title || page.url,
      detail: page.url,
    });
    if (suggestions.length >= limit - 1) break;
  }

  const searchUrl = buildSearchUrl(input, engine);
  const search: OmniboxSuggestion = {
    kind: "search",
    id: `search:${input}`,
    url: searchUrl,
    label: `Search ${SEARCH_ENGINES[engine].label} for "${input}"`,
  };
  // A search intent leads with the search; a URL intent keeps it last.
  if (intent.kind === "search") suggestions.unshift(search);
  else suggestions.push(search);
  return suggestions.slice(0, limit);
}

/** Address bar chip: what kind of page is shown. */
export type SecurityState = "secure" | "insecure" | "local" | "none";

export function securityStateFor(url: string): SecurityState {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return "secure";
    if (parsed.protocol === "http:") {
      return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname) ? "local" : "insecure";
    }
    return "none";
  } catch {
    return "none";
  }
}

/** Host shown in the address bar while it is not being edited. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const host = parsed.host.replace(/^www\./, "");
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    return `${host}${rest}`;
  } catch {
    return url;
  }
}
