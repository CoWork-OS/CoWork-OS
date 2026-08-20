import { lookup } from "dns/promises";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import { assertNetworkPolicyAllowed } from "../../security/network-policy";
import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";

const REQUEST_TIMEOUT_MS = 20_000;
const DNS_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SearXngResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string | null;
  engine?: string;
  engines?: string[];
  img_src?: string;
  thumbnail_src?: string;
}

interface SearXngResponse {
  results?: SearXngResult[];
  number_of_results?: number;
}

interface SearXngHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) {
      const mappedAddress = normalized.slice("::ffff:".length);
      if (isIP(mappedAddress) === 4) return isPrivateHost(mappedAddress);

      // URL canonicalization renders mapped dotted IPv4 addresses as two
      // hexadecimal groups (for example 127.0.0.1 becomes 7f00:1).
      const groups = mappedAddress.split(":");
      if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        const high = Number.parseInt(groups[0], 16);
        const low = Number.parseInt(groups[1], 16);
        return isPrivateHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
      }
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89a-f]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

function domainMatches(hostname: string, pattern: string): boolean {
  const normalizedPattern = String(pattern || "")
    .trim()
    .toLowerCase();
  if (!hostname || !normalizedPattern) return false;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === normalizedPattern;
}

function languageFromRegion(region?: string): string | undefined {
  if (!region) return undefined;
  const normalized = region.trim().toLowerCase().replace("_", "-");
  const languages: Record<string, string> = {
    us: "en-US",
    uk: "en-GB",
    gb: "en-GB",
    tr: "tr-TR",
    de: "de-DE",
    fr: "fr-FR",
    es: "es-ES",
    it: "it-IT",
    jp: "ja-JP",
    br: "pt-BR",
  };
  return languages[normalized] || normalized;
}

function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SearXNG JSON API provider with a pinned, no-redirect transport.
 * Queries are sent only to the configured instance and never fall through here.
 */
export class SearXngProvider implements SearchProvider {
  readonly type = "searxng" as const;
  readonly supportedSearchTypes: SearchType[] = ["web", "news", "images"];

  private readonly searchUrl: URL;
  private readonly allowPrivate: boolean;

  constructor(config: SearchProviderConfig) {
    if (!config.searxngBaseUrl) {
      throw new Error("SearXNG instance URL is required. Configure it in Settings.");
    }

    let url: URL;
    try {
      url = new URL(config.searxngBaseUrl);
    } catch {
      throw new Error("SearXNG instance URL is invalid.");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("SearXNG instance URL must use HTTP or HTTPS.");
    }
    if (url.username || url.password) {
      throw new Error("SearXNG credentials must not be embedded in the instance URL.");
    }

    const privateTarget = isPrivateHost(url.hostname);
    if (privateTarget && !config.searxngAllowPrivate) {
      throw new Error(
        "SearXNG private/local instance access is disabled. Enable it explicitly in Settings.",
      );
    }
    if (
      url.protocol === "http:" &&
      !privateTarget &&
      (!config.searxngAllowPrivate || isIP(url.hostname) !== 0)
    ) {
      throw new Error("Public SearXNG instances must use HTTPS.");
    }

    this.allowPrivate = config.searxngAllowPrivate === true;
    url.hash = "";
    url.search = "";
    if (!url.pathname.replace(/\/+$/, "").endsWith("/search")) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
    }
    this.searchUrl = url;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    this.assertWorkspaceEndpointAllowed(query);
    assertNetworkPolicyAllowed({ url: this.searchUrl.toString(), toolName: "web_search" });

    const searchType = query.searchType || "web";
    const params = new URLSearchParams({
      q: query.query,
      format: "json",
      categories: searchType === "web" ? "general" : searchType,
    });
    if (query.dateRange) params.set("time_range", query.dateRange);
    const language = query.language || languageFromRegion(query.region);
    if (language) params.set("language", language);
    if (typeof query.safeSearch === "boolean") {
      params.set("safesearch", query.safeSearch ? "1" : "0");
    }

    const response = await this.request(params.toString());
    if (response.status >= 300 && response.status < 400) {
      throw new Error("SearXNG redirects are not allowed; configure the final instance URL.");
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.body.slice(0, 500);
      throw new Error(`SearXNG API error: ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
    if (!response.contentType.toLowerCase().includes("json")) {
      throw new Error(
        "SearXNG did not return JSON. Enable the json format in the instance search.formats setting.",
      );
    }

    let data: SearXngResponse;
    try {
      data = JSON.parse(response.body) as SearXngResponse;
    } catch {
      throw new Error("SearXNG returned invalid JSON.");
    }

    const maxResults = Math.min(Math.max(query.maxResults || 10, 1), 20);
    const results = (Array.isArray(data.results) ? data.results : [])
      .map((result) => this.mapResult(result))
      .filter((result): result is SearchResult => result !== null)
      .slice(0, maxResults);
    return {
      results,
      query: query.query,
      searchType,
      totalResults: data.number_of_results,
      provider: "searxng",
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.search({ query: "test", maxResults: 1 });
      if (!response.results.length) {
        return { success: false, error: "No results returned from SearXNG" };
      }
      return { success: true };
    } catch (error: Any) {
      return { success: false, error: error?.message || "Failed to connect to SearXNG" };
    }
  }

  private assertWorkspaceEndpointAllowed(query: SearchQuery): void {
    const policy = query.endpointDomainPolicy;
    if (!policy) return;
    const hostname = this.searchUrl.hostname.toLowerCase();
    const blocked = policy.blockedDomains.some((pattern) => domainMatches(hostname, pattern));
    if (blocked) {
      throw new Error(`SearXNG endpoint denied by workspace network policy: ${hostname}`);
    }
    if (
      policy.allowedDomains.length > 0 &&
      !policy.allowedDomains.some((pattern) => domainMatches(hostname, pattern))
    ) {
      throw new Error(`SearXNG endpoint is not in the workspace network allowlist: ${hostname}`);
    }
  }

  private mapResult(result: SearXngResult): SearchResult | null {
    if (typeof result.title !== "string" || typeof result.url !== "string") return null;
    let resultUrl: URL;
    try {
      resultUrl = new URL(result.url);
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(resultUrl.protocol)) return null;
    return {
      title: result.title,
      url: resultUrl.toString(),
      snippet: typeof result.content === "string" ? result.content : "",
      publishedDate: result.publishedDate || undefined,
      source: result.engine || result.engines?.join(", "),
      imageUrl: safeHttpUrl(result.img_src),
      thumbnailUrl: safeHttpUrl(result.thumbnail_src),
    };
  }

  private async resolvePinnedAddress(): Promise<{ address: string; family: 4 | 6 }> {
    const hostname = this.searchUrl.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      return { address: hostname, family: literalFamily };
    }

    let addresses: Array<{ address: string; family: number }>;
    let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsTimeout = setTimeout(
            () => reject(new Error("SearXNG DNS lookup timed out.")),
            DNS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error: Any) {
      throw new Error(error?.message || "SearXNG instance hostname did not resolve.");
    } finally {
      if (dnsTimeout) clearTimeout(dnsTimeout);
    }
    if (!addresses.length) throw new Error("SearXNG instance hostname did not resolve.");

    const privateAddresses = addresses.filter((entry) => isPrivateHost(entry.address));
    if (privateAddresses.length && !this.allowPrivate) {
      throw new Error(
        "SearXNG instance resolves to a private/local address. Enable private instance access explicitly in Settings.",
      );
    }
    if (this.searchUrl.protocol === "http:" && privateAddresses.length !== addresses.length) {
      throw new Error("Public SearXNG instances must use HTTPS.");
    }
    const selected = addresses[0];
    return { address: selected.address, family: selected.family as 4 | 6 };
  }

  private async request(body: string): Promise<SearXngHttpResponse> {
    const pinned = await this.resolvePinnedAddress();
    const transport = this.searchUrl.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = transport(
        this.searchUrl,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "CoWorkOS/1.0",
          },
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
          ...(this.searchUrl.protocol === "https:" && !isIP(this.searchUrl.hostname)
            ? { servername: this.searchUrl.hostname }
            : {}),
        },
        (response) => {
          const declaredLength = Number(response.headers["content-length"] || 0);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(new Error("SearXNG response exceeded the 2 MiB size limit."));
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buffer.length;
            if (received > MAX_RESPONSE_BYTES) {
              response.destroy();
              fail(new Error("SearXNG response exceeded the 2 MiB size limit."));
              return;
            }
            chunks.push(buffer);
          });
          response.on("error", (error) => fail(error));
          response.on("end", () => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode || 0,
              contentType: String(response.headers["content-type"] || ""),
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error("SearXNG request timed out."));
      });
      request.on("error", (error) => fail(error));
      request.end(body);
    });
  }
}
