/**
 * Shared policy-aware HTTP client: network policy and a pinned, internal-address-checked
 * connection on every hop, with redirects followed manually.
 *
 * Extracted from WebFetchTools so other outbound integrations (PACT) get identical per-hop rules
 * instead of re-implementing them. Behaviour per hop:
 * - only http/https;
 * - `evaluateNetworkPolicy` before the request (and before following a redirect);
 * - `pinnedFetch` resolves DNS, rejects internal answers and pins the socket;
 * - 303, and 301/302 after POST, become GET without a body (fetch semantics);
 * - a cross-origin hop resets caller headers to `publicHeaders` and refuses to carry a body;
 * - `hopHeaders` (for example an identity signature bound to the hop's authority) are
 *   recomputed for every hop and never carried over from the previous one;
 * - at most `maxRedirects` redirects.
 */
import {
  evaluateNetworkPolicy,
  type NetworkPolicyDecision,
  type NetworkPolicyRequest,
} from "./network-policy";
import { pinnedFetch } from "./pinned-fetch";

export type NetworkPolicyContext = Pick<
  NetworkPolicyRequest,
  "networkEnabled" | "accessNetworkMode" | "profileDomainRules"
>;

export type PolicyCheckedFetchErrorCode =
  | "unsupported_scheme"
  | "policy_denied"
  | "cross_origin_body"
  | "too_many_redirects";

export class PolicyCheckedFetchError extends Error {
  constructor(
    readonly code: PolicyCheckedFetchErrorCode,
    message: string,
    readonly decision?: NetworkPolicyDecision,
  ) {
    super(message);
    this.name = "PolicyCheckedFetchError";
  }
}

export interface PolicyCheckedFetchOptions {
  toolName: string;
  networkContext: NetworkPolicyContext;
  followRedirects?: boolean;
  maxRedirects?: number;
  /** Headers that replace the caller's headers when a redirect changes origin. */
  publicHeaders?: Record<string, string>;
  /** Observes every policy decision (WebFetchTools logs them as task events). */
  onDecision?: (decision: NetworkPolicyDecision) => void;
  /** Observes every URL about to be fetched, in order. */
  onHop?: (url: string) => void;
  /** Refuse loopback destinations (by literal and by DNS answer) as well as private ones. */
  allowLoopback?: boolean;
  /** Headers computed for each hop's URL, applied over the caller's headers for that hop only. */
  hopHeaders?: (url: URL) => Record<string, string> | undefined;
}

export interface PolicyCheckedFetchResult {
  response: Response;
  finalUrl: string;
  chain: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

export function assertPolicyAllowsUrl(url: string, options: PolicyCheckedFetchOptions): void {
  const decision = evaluateNetworkPolicy({
    url,
    toolName: options.toolName,
    ...options.networkContext,
  });
  options.onDecision?.(decision);
  if (decision.action === "allow") return;
  if (decision.reason === "legacy_guardrail_domain_denied") {
    throw new PolicyCheckedFetchError("policy_denied", `Domain not allowed: "${url}"`, decision);
  }
  throw new PolicyCheckedFetchError(
    "policy_denied",
    `Network access denied for "${url}": ${decision.reason}`,
    decision,
  );
}

function buildRedirectInit(init: RequestInit, status: number): RequestInit {
  const method = String(init.method || "GET").toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    const { body: _body, ...rest } = init;
    return { ...rest, method: "GET" };
  }
  return { ...init };
}

function withHeaders(
  base: RequestInit["headers"],
  extra: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  new Headers(base).forEach((value, name) => {
    merged[name] = value;
  });
  // Header names are case-insensitive: drop the caller's spelling before setting ours.
  for (const [name, value] of Object.entries(extra)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

export async function fetchWithPolicyCheckedRedirects(
  url: string,
  init: RequestInit,
  options: PolicyCheckedFetchOptions,
): Promise<PolicyCheckedFetchResult> {
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const chain: string[] = [];
  let currentUrl = url;
  let currentInit: RequestInit = { ...init };
  let checkedUrl: string | undefined;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const parsedUrl = new URL(currentUrl);
    if (!isHttpUrl(parsedUrl)) {
      throw new PolicyCheckedFetchError(
        "unsupported_scheme",
        "Only HTTP and HTTPS URLs are supported",
      );
    }
    // A redirect target was already evaluated when the redirect was accepted.
    if (checkedUrl !== parsedUrl.toString()) assertPolicyAllowsUrl(parsedUrl.toString(), options);
    chain.push(currentUrl);
    options.onHop?.(currentUrl);
    const extraHeaders = options.hopHeaders?.(parsedUrl);
    const hopInit: RequestInit = extraHeaders
      ? { ...currentInit, headers: withHeaders(currentInit.headers, extraHeaders) }
      : currentInit;
    const response =
      options.allowLoopback === false
        ? await pinnedFetch(currentUrl, { ...hopInit, redirect: "manual" }, false, {
            allowLoopback: false,
          })
        : await pinnedFetch(currentUrl, { ...hopInit, redirect: "manual" });

    if (!followRedirects || !isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl, chain };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl, chain };

    await response.body?.cancel();
    const nextUrl = new URL(location, parsedUrl);
    if (!isHttpUrl(nextUrl)) {
      throw new PolicyCheckedFetchError(
        "unsupported_scheme",
        "Only HTTP and HTTPS redirect URLs are supported",
      );
    }
    assertPolicyAllowsUrl(nextUrl.toString(), options);
    checkedUrl = nextUrl.toString();
    currentInit = buildRedirectInit(currentInit, response.status);

    // Any caller header can carry a credential. Restore public defaults when the destination
    // origin changes (including HTTPS downgrades).
    if (nextUrl.origin !== parsedUrl.origin) {
      // A preserved POST body may contain the same secret as its headers.
      if (currentInit.body != null) {
        throw new PolicyCheckedFetchError(
          "cross_origin_body",
          "Cross-origin redirects with a request body are not allowed",
        );
      }
      currentInit = { ...currentInit, headers: { ...options.publicHeaders } };
    }
    currentUrl = nextUrl.toString();
  }

  throw new PolicyCheckedFetchError("too_many_redirects", "Too many redirects");
}
