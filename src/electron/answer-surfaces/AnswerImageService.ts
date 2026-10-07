import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnswerImageRequest, AnswerImageResult } from "../../shared/answer-surfaces/images";
import { readBoundedResponse } from "../security/bounded-response";
import {
  assertNetworkDestinationAllowed,
  type NetworkPolicyRequest,
} from "../security/network-policy";
import { pinnedFetch } from "../security/pinned-fetch";
import type { ConfiguredImageSearch, WebImageHit } from "./web-image-search";

/**
 * Finds and fetches the photos that answer surfaces ask for by description.
 *
 * The renderer never loads a model-chosen image URL itself: the main process searches
 * free, openly licensed sources (Openverse, then Wikimedia Commons), downloads a small
 * thumbnail through the network policy, checks it is really an image, and hands the
 * renderer a data URL with its attribution. Results are cached on disk.
 */

export type AnswerImageNetworkContext = Pick<
  NetworkPolicyRequest,
  "networkEnabled" | "accessNetworkMode" | "profileDomainRules"
>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type Candidate = {
  thumbnailUrl: string;
  width?: number;
  height?: number;
  title?: string;
  creator?: string;
  license?: string;
  sourceUrl?: string;
  provider: AnswerImageResult["provider"];
  /** Title, tags or description, used to rank results against the query. */
  searchText?: string;
};

const TOOL_NAME = "answer_images";
const USER_AGENT = "CoWorkOS (+https://github.com/CoWork-OS/CoWork-OS)";
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_JSON_BYTES = 2_000_000;
const DISCARD_BYTES = 64 * 1024;
// Openverse's thumbnail endpoint negotiates the format and answers 406 to "image/*".
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const MAX_CONCURRENCY = 4;
const DISK_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MISS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_DISK_ENTRIES = 400;
const MAX_MEMORY_ENTRIES = 120;
const PROVIDER_BACKOFF_MS = 10 * 60 * 1000;
/** The free photo libraries' API and image hosts (Openverse proxies its thumbnails). */
const CURATED_PHOTO_HOSTS = new Set([
  "api.openverse.org",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "over",
  "the",
  "to",
  "with",
  "photo",
  "image",
  "picture",
]);

function sniffImageMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(8, 4))) return "image/avif";
  return null;
}

function stripHtml(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 160) : undefined;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}

function stem(word: string): string {
  return word.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
}

function contentTerms(query: string): string[] {
  return query
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

/** The full description, then shorter forms: free photo search matches every word. */
function queryVariants(query: string): string[] {
  const words = query.split(" ").filter((word) => word && !STOP_WORDS.has(word));
  return [
    ...new Set([query, words.join(" "), words.slice(0, 3).join(" "), words.slice(0, 2).join(" ")]),
  ].filter((variant) => variant.length >= 3);
}

/** Most query terms in the title/tags first; results matching none are dropped. */
function rankCandidates(candidates: Candidate[], terms: string[]): Candidate[] {
  const score = (candidate: Candidate) => {
    const words = new Set(
      (candidate.searchText ?? candidate.title ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map(stem),
    );
    return terms.filter((term) => words.has(term)).length;
  };
  // Library titles and tags are noisy: ask for two matching terms when there are two.
  const required = Math.min(2, terms.length);
  return candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .filter((entry) => entry.score >= required)
    .sort(
      (a, b) =>
        b.score - a.score ||
        aspectScore(b.candidate.width, b.candidate.height) -
          aspectScore(a.candidate.width, a.candidate.height) ||
        a.index - b.index,
    )
    .map((entry) => entry.candidate);
}

function aspectScore(width?: number, height?: number): number {
  if (!width || !height) return 1;
  const ratio = width / height;
  // Prefer gentle landscape photos; reject extreme panoramas and slivers.
  if (ratio < 0.5 || ratio > 2.4) return 0;
  return ratio >= 1 ? 2 : 1.5;
}

export class AnswerImageService {
  private readonly memory = new Map<
    string,
    { result: AnswerImageResult | null; expiresAt: number }
  >();
  private readonly inFlight = new Map<string, Promise<AnswerImageResult | null>>();
  private active = 0;
  private openverseBlockedUntil = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      cacheDir: string;
      fetchImpl?: FetchLike;
      now?: () => number;
      /** Skips the DNS-backed destination check; tests only. */
      skipDestinationCheck?: boolean;
      /** The user's configured image-capable web search, if any (read per lookup). */
      imageSearch?: () => ConfiguredImageSearch | null;
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => pinnedFetch(url, init));
    this.now = options.now ?? Date.now;
  }

  async resolve(
    requests: AnswerImageRequest[],
    context: AnswerImageNetworkContext,
  ): Promise<Array<AnswerImageResult | null>> {
    return Promise.all(
      requests.map((request) => this.resolveOne(request, context).catch(() => null)),
    );
  }

  private cacheKey(request: AnswerImageRequest): string | null {
    const basis = request.src
      ? `src:${request.src.trim()}`
      : request.query
        ? `query:${normalizeQuery(request.query)}`
        : null;
    return basis ? createHash("sha256").update(basis).digest("hex").slice(0, 40) : null;
  }

  private async resolveOne(
    request: AnswerImageRequest,
    context: AnswerImageNetworkContext,
  ): Promise<AnswerImageResult | null> {
    const key = this.cacheKey(request);
    if (!key) return null;
    const remembered = this.memory.get(key);
    if (remembered && remembered.expiresAt > this.now()) return remembered.result;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = (async () => {
      const cached = await this.readDiskCache(key);
      if (cached) return cached;
      const result = await this.withSlot(() => this.lookup(request, context));
      this.remember(key, result);
      if (result) await this.writeDiskCache(key, result);
      return result;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private remember(key: string, result: AnswerImageResult | null): void {
    if (this.memory.size >= MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(key, {
      result,
      expiresAt: this.now() + (result ? DISK_CACHE_TTL_MS : MISS_CACHE_TTL_MS),
    });
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await run();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async lookup(
    request: AnswerImageRequest,
    context: AnswerImageNetworkContext,
  ): Promise<AnswerImageResult | null> {
    // When the access profile asks before network use, only the fixed photo libraries are
    // reached (their hosts are not chosen by the model); model-supplied URLs and web
    // search results wait for a profile with network access enabled.
    const curatedOnly = context.accessNetworkMode === "on-request";
    if (request.src) {
      if (curatedOnly) return null;
      return this.download(
        { thumbnailUrl: request.src, sourceUrl: request.src, provider: "web" },
        context,
      );
    }
    const query = request.query ? normalizeQuery(request.query) : "";
    if (!query) return null;
    const terms = contentTerms(query);
    const variants = queryVariants(query);
    // Free sources first: a self-hosted search engine, then openly licensed photo
    // libraries; a paid search provider is only asked when those find nothing.
    const web = curatedOnly ? null : (this.options.imageSearch?.() ?? null);
    if (web?.free) {
      const result = await this.searchWeb(web, query, context);
      if (result) return result;
    }
    if (this.now() >= this.openverseBlockedUntil) {
      for (const variant of variants.slice(0, 3)) {
        let candidates: Candidate[];
        try {
          candidates = rankCandidates(await this.searchOpenverse(variant, context), terms);
        } catch (error) {
          // Anonymous Openverse use is rate limited; let Wikimedia answer for a while.
          if (/\b(?:429|403)\b/.test(String((error as Error)?.message))) {
            this.openverseBlockedUntil = this.now() + PROVIDER_BACKOFF_MS;
          }
          break;
        }
        const result = await this.firstDownload(candidates, context);
        if (result) return result;
      }
    }
    for (const variant of variants.slice(1, 3).concat(variants.length === 1 ? variants : [])) {
      let candidates: Candidate[];
      try {
        candidates = rankCandidates(await this.searchWikimedia(variant, context), terms);
      } catch {
        break;
      }
      const result = await this.firstDownload(candidates, context);
      if (result) return result;
    }
    if (web && !web.free) return this.searchWeb(web, query, context);
    return null;
  }

  private async searchWeb(
    web: ConfiguredImageSearch,
    query: string,
    context: AnswerImageNetworkContext,
  ): Promise<AnswerImageResult | null> {
    let hits: WebImageHit[];
    try {
      hits = await web.search(query, context);
    } catch {
      return null;
    }
    return this.firstDownload(
      hits
        .filter((hit) => aspectScore(hit.width, hit.height) > 0)
        .map((hit) => ({
          thumbnailUrl: hit.url,
          width: hit.width,
          height: hit.height,
          title: hit.title,
          sourceUrl: hit.sourceUrl,
          provider: "web" as const,
        })),
      context,
    );
  }

  private async firstDownload(
    candidates: Candidate[],
    context: AnswerImageNetworkContext,
  ): Promise<AnswerImageResult | null> {
    for (const candidate of candidates.slice(0, 3)) {
      const result = await this.download(candidate, context).catch(() => null);
      if (result) return result;
    }
    return null;
  }

  private async request(
    url: string,
    context: AnswerImageNetworkContext,
    accept: string,
  ): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!current.startsWith("https://")) throw new Error("Only https images are fetched");
      if (
        context.accessNetworkMode === "on-request" &&
        !CURATED_PHOTO_HOSTS.has(new URL(current).hostname)
      ) {
        throw new Error("Only the curated photo libraries are reached without network access");
      }
      if (!this.options.skipDestinationCheck) {
        await assertNetworkDestinationAllowed({ url: current, toolName: TOOL_NAME, ...context });
      }
      const response = await this.fetchImpl(current, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      // Drain the (small) body instead of cancelling it: cancelling a pinned-fetch body
      // before it is read raises an uncaught stream error in Node.
      await readBoundedResponse(response, DISCARD_BYTES, "Discarded response", undefined, {
        truncate: true,
      }).catch(() => {});
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect without location");
        current = new URL(location, current).toString();
        continue;
      }
      throw new Error(`Request failed with ${response.status}`);
    }
    throw new Error("Too many redirects");
  }

  private async getJson(url: string, context: AnswerImageNetworkContext): Promise<unknown> {
    const response = await this.request(url, context, "application/json");
    const bytes = await readBoundedResponse(response, MAX_JSON_BYTES, "Image search response");
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  private async searchOpenverse(
    query: string,
    context: AnswerImageNetworkContext,
  ): Promise<Candidate[]> {
    // Photo-first sources; museum collections mostly return scans of artworks.
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=20&mature=false&category=photograph&source=flickr,wikimedia,stocksnap,rawpixel,nappy`;
    const body = (await this.getJson(url, context)) as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(body?.results) ? body.results : [];
    return results
      .map((item) => ({
        thumbnailUrl: typeof item.thumbnail === "string" ? item.thumbnail : "",
        width: typeof item.width === "number" ? item.width : undefined,
        height: typeof item.height === "number" ? item.height : undefined,
        title: stripHtml(item.title),
        creator: stripHtml(item.creator),
        license:
          typeof item.license === "string"
            ? `CC ${item.license.toUpperCase()}${typeof item.license_version === "string" ? ` ${item.license_version}` : ""}`.replace(
                "CC PDM",
                "Public domain",
              )
            : undefined,
        sourceUrl:
          typeof item.foreign_landing_url === "string" ? item.foreign_landing_url : undefined,
        searchText: [
          stripHtml(item.title) ?? "",
          ...(Array.isArray(item.tags)
            ? item.tags.map((tag) => (typeof tag?.name === "string" ? tag.name : ""))
            : []),
        ].join(" "),
        provider: "openverse" as const,
      }))
      .filter(
        (item) =>
          item.thumbnailUrl.startsWith("https://") && aspectScore(item.width, item.height) > 0,
      );
  }

  private async searchWikimedia(
    query: string,
    context: AnswerImageNetworkContext,
  ): Promise<Candidate[]> {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrnamespace: "6",
      gsrlimit: "10",
      gsrsearch: `${query} filetype:bitmap`,
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "640",
    });
    const body = (await this.getJson(
      `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
      context,
    )) as { query?: { pages?: Record<string, Record<string, unknown>> } };
    const pages = Object.values(body?.query?.pages ?? {});
    return pages
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .map((page) => {
        const info = Array.isArray(page.imageinfo)
          ? (page.imageinfo[0] as Record<string, unknown>)
          : {};
        const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
        return {
          thumbnailUrl: typeof info.thumburl === "string" ? info.thumburl : "",
          width: typeof info.width === "number" ? info.width : undefined,
          height: typeof info.height === "number" ? info.height : undefined,
          title: stripHtml(meta.ObjectName?.value) ?? stripHtml(page.title),
          creator: stripHtml(meta.Artist?.value),
          license: stripHtml(meta.LicenseShortName?.value),
          sourceUrl: typeof info.descriptionurl === "string" ? info.descriptionurl : undefined,
          searchText: `${String(page.title ?? "")} ${stripHtml(meta.ImageDescription?.value) ?? ""}`,
          mime: info.mime,
          provider: "wikimedia" as const,
        };
      })
      .filter(
        (item) =>
          item.thumbnailUrl.startsWith("https://") &&
          (item.mime === "image/jpeg" || item.mime === "image/png" || item.mime === "image/webp") &&
          aspectScore(item.width, item.height) > 0,
      )
      .map(({ mime: _mime, ...candidate }) => candidate);
  }

  private async download(
    candidate: Candidate,
    context: AnswerImageNetworkContext,
  ): Promise<AnswerImageResult | null> {
    const response = await this.request(candidate.thumbnailUrl, context, IMAGE_ACCEPT);
    const bytes = await readBoundedResponse(response, MAX_IMAGE_BYTES, "Answer image");
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return {
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
      width: candidate.width,
      height: candidate.height,
      title: candidate.title,
      creator: candidate.creator,
      license: candidate.license,
      sourceUrl: candidate.sourceUrl,
      provider: candidate.provider,
    };
  }

  private cachePath(key: string): string {
    return path.join(this.options.cacheDir, `${key}.json`);
  }

  private async readDiskCache(key: string): Promise<AnswerImageResult | null> {
    try {
      const file = this.cachePath(key);
      const stat = await fs.stat(file);
      if (this.now() - stat.mtimeMs > DISK_CACHE_TTL_MS) return null;
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as AnswerImageResult;
      if (typeof parsed?.dataUrl !== "string" || !parsed.dataUrl.startsWith("data:image/")) {
        return null;
      }
      this.remember(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeDiskCache(key: string, result: AnswerImageResult): Promise<void> {
    try {
      await fs.mkdir(this.options.cacheDir, { recursive: true });
      await fs.writeFile(this.cachePath(key), JSON.stringify(result));
      await this.pruneDiskCache();
    } catch {
      // A cache write failure only costs a refetch later.
    }
  }

  private async pruneDiskCache(): Promise<void> {
    const names = (await fs.readdir(this.options.cacheDir)).filter((name) =>
      name.endsWith(".json"),
    );
    if (names.length <= MAX_DISK_ENTRIES) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.options.cacheDir, name);
        const stat = await fs.stat(file).catch(() => null);
        return { file, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    await Promise.all(
      entries
        .slice(0, entries.length - MAX_DISK_ENTRIES)
        .map((entry) => fs.rm(entry.file, { force: true })),
    );
  }
}
