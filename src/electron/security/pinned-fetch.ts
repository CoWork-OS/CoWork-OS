import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { promises as dns } from "dns";
import { isIP } from "net";
import { Readable } from "stream";
import { loadPolicies } from "../admin/policies";
import { domainMatches } from "./network-policy";
import { fetch as nodeFetch } from "node-fetch/node";
import {
  assertResolvedHostAllowed,
  isBlockedInternalHost,
  normalizeHostname,
} from "./address-classes";

/** True when HTTP(S)_PROXY applies to this URL (respecting NO_PROXY). */
function usesEnvProxy(endpoint: URL): boolean {
  const env = process.env;
  const proxy =
    endpoint.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy
      : env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return false;
  const host = normalizeHostname(endpoint.hostname);
  const noProxy = (env.NO_PROXY || env.no_proxy || "").toLowerCase().split(/[\s,]+/);
  return !noProxy.some((raw) => {
    if (raw === "*") return true;
    const entry = raw.replace(/:\d+$/, "").replace(/^\*?\./, "");
    return Boolean(entry) && (host === entry || host.endsWith(`.${entry}`));
  });
}

type PinnedAddress = { address: string; family: number };

// Reuse connections to the same validated address set; DNS is still checked per request.
const MAX_CACHED_AGENTS = 64;
const agents = new Map<string, HttpAgent>();

function getPinnedAgent(endpoint: URL, hostname: string, addresses: PinnedAddress[]): HttpAgent {
  const key = `${endpoint.protocol}|${hostname}|${JSON.stringify(addresses)}`;
  const cached = agents.get(key);
  if (cached) return cached;
  const Agent = endpoint.protocol === "https:" ? HttpsAgent : HttpAgent;
  const agent = new Agent({
    keepAlive: true,
    // Return every validated address so Node can fall back between families.
    lookup: (_hostname, options, callback) => {
      const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
      const matching = family ? addresses.filter((entry) => entry.family === family) : [];
      const candidates = matching.length ? matching : addresses;
      if (options.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    },
  });
  agents.set(key, agent);
  if (agents.size > MAX_CACHED_AGENTS) {
    const [oldestKey, oldest] = agents.entries().next().value as [string, HttpAgent];
    agents.delete(oldestKey);
    oldest.destroy();
  }
  return agent;
}

async function resolveAddresses(hostname: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason || new DOMException("Request aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** Bind the DNS validation to the socket lookup, preserving Host and TLS SNI. */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  requirePinnedDestination = false,
): Promise<Response> {
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("Only HTTP and HTTPS URLs are supported");
  const hostname = normalizeHostname(endpoint.hostname);
  const explicitlyAllowedInternal = (
    loadPolicies().runtime.network.allowedInternalHosts ?? []
  ).some((pattern) => domainMatches(hostname, pattern));
  if (!explicitlyAllowedInternal && isBlockedInternalHost(hostname, true))
    throw new Error(`Refusing to connect to internal host ${hostname}`);
  if (usesEnvProxy(endpoint)) {
    if (requirePinnedDestination)
      throw new Error(
        "Browser requests require destination pinning; environment proxies are unsupported",
      );
    // The proxy resolves and connects, so pinning a local lookup cannot apply.
    // Keep the global (EnvHttpProxyAgent) transport and its lenient DNS check.
    await assertResolvedHostAllowed(hostname);
    init.signal?.throwIfAborted();
    return fetch(url, { ...init, redirect: "manual" });
  }
  const addresses = await resolvePinnedAddresses(url, init.signal || undefined);
  const agent = getPinnedAgent(endpoint, hostname, addresses);
  // The existing node-fetch alias's /node entry always uses the Node transport,
  // which supports a custom Agent. Native global fetch would ignore this option.
  const response = await nodeFetch(url, { ...init, redirect: "manual", agent } as RequestInit);
  const body = response.body as unknown as Readable | null;
  const noBody = init.method?.toUpperCase() === "HEAD" || [204, 205, 304].includes(response.status);
  if (noBody) body?.destroy();
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  for (const cookie of (response.headers as unknown as { raw(): Record<string, string[]> }).raw()[
    "set-cookie"
  ] ?? [])
    headers.append("set-cookie", cookie);
  return new Response(
    body && !noBody ? (Readable.toWeb(body) as ReadableStream<Uint8Array>) : null,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

/** Validate once and return only addresses the connection is allowed to use. */
export async function resolvePinnedAddresses(
  url: string,
  signal?: AbortSignal,
): Promise<PinnedAddress[]> {
  const endpoint = new URL(url);
  const hostname = normalizeHostname(endpoint.hostname);
  const explicitlyAllowedInternal = (
    loadPolicies().runtime.network.allowedInternalHosts ?? []
  ).some((pattern) => domainMatches(hostname, pattern));
  if (usesEnvProxy(endpoint))
    throw new Error("Destination pinning is unavailable with environment proxies");
  if (!explicitlyAllowedInternal && isBlockedInternalHost(hostname, true))
    throw new Error("Internal destination refused");
  const addresses: PinnedAddress[] = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveAddresses(hostname, signal);
  signal?.throwIfAborted();
  if (
    !addresses.length ||
    (!explicitlyAllowedInternal &&
      addresses.some(({ address }) => isBlockedInternalHost(address, true)))
  )
    throw new Error("Destination resolves to an internal or missing address");
  return addresses;
}
