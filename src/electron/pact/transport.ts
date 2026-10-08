/**
 * PACT's view of the network: one request shape for every hop of discovery, metadata, JWKS,
 * device flow, token, signer and messaging traffic.
 *
 * The implementation underneath is the shared policy-aware client (DNS pinning, internal-address
 * rejection and network-policy evaluation on every hop). This layer adds PACT's own rules: size
 * caps and deadlines per purpose, redirects only for credential-free GETs, `A2A-Version: 1.0`,
 * `Retry-After` on 429, and typed errors whose messages never carry secrets.
 */
import { redactPactString } from "./redaction";

export type PactRequestPurpose =
  | "card"
  | "metadata"
  | "jwks"
  | "device_authorization"
  | "token"
  | "message"
  | "signer";

export interface PactHttpRequest {
  purpose: PactRequestPurpose;
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface PactHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  bodyText: string;
  /** Final URL after redirects. */
  url: string;
  /** Every URL fetched, in order, starting with the request URL. */
  chain: string[];
}

/** The lower layer: one policy-checked exchange with optional GET redirect following. */
export interface PolicyCheckedHttp {
  fetch(input: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    signal?: AbortSignal;
  }): Promise<PactHttpResponse>;
}

export type PactTransportErrorCode =
  | "policy_denied"
  /** Refused before any connection (DNS, internal address, proxy pinning): nothing was sent. */
  | "destination_refused"
  | "timeout"
  | "network"
  | "too_large"
  | "too_many_redirects"
  | "redirect_not_allowed"
  | "invalid_url"
  | "aborted"
  | "rate_limited";

export class PactTransportError extends Error {
  constructor(
    readonly code: PactTransportErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(redactPactString(message));
    this.name = "PactTransportError";
  }
}

interface PurposeLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

/** Credential-bearing requests never follow redirects; only the anonymous GETs may. */
const LIMITS: Record<PactRequestPurpose, PurposeLimits> = {
  card: { maxBytes: 256 * 1024, timeoutMs: 10_000, maxRedirects: 10 },
  metadata: { maxBytes: 64 * 1024, timeoutMs: 10_000, maxRedirects: 10 },
  jwks: { maxBytes: 64 * 1024, timeoutMs: 10_000, maxRedirects: 10 },
  device_authorization: { maxBytes: 32 * 1024, timeoutMs: 15_000, maxRedirects: 0 },
  token: { maxBytes: 64 * 1024, timeoutMs: 15_000, maxRedirects: 0 },
  message: { maxBytes: 512 * 1024, timeoutMs: 120_000, maxRedirects: 0 },
  signer: { maxBytes: 32 * 1024, timeoutMs: 10_000, maxRedirects: 0 },
};

export const PACT_A2A_VERSION_HEADER = "A2A-Version";
export const MAX_RETRY_AFTER_MS = 120_000;

export function limitsFor(purpose: PactRequestPurpose): PurposeLimits {
  return LIMITS[purpose];
}

/** RFC 9110 Retry-After: delta-seconds or an HTTP date. Capped so a provider cannot park a task. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

export class PactTransport {
  constructor(private readonly http: PolicyCheckedHttp) {}

  async request(request: PactHttpRequest): Promise<PactHttpResponse> {
    const limits = LIMITS[request.purpose];
    if (request.method !== "GET" && limits.maxRedirects !== 0) {
      throw new PactTransportError("redirect_not_allowed", "Only GET requests may follow redirects");
    }
    const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
    if (request.purpose === "message") {
      headers[PACT_A2A_VERSION_HEADER] = "1.0";
      headers["Content-Type"] = "application/json";
    }
    const response = await this.http.fetch({
      url: request.url,
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (response.status === 429) {
      throw new PactTransportError(
        "rate_limited",
        "The business agent asked CoWork to slow down",
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return response;
  }
}
