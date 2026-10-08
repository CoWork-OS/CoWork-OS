/**
 * Bounded, policy-aware JWKS cache keyed by `jwks_uri`.
 *
 * Unlike the upstream client's module-level `createRemoteJWKSet` map, entries are capped, expire,
 * are fetched through PACT's transport (so network policy, DNS pinning and size caps apply), and an
 * unknown `kid` triggers at most one refetch per cooldown window so a forged header cannot turn
 * verification into a request amplifier.
 */
import type { KeyObject } from "node:crypto";
import {
  publicKeyFromJwk,
  selectJwksCandidates,
  type JwsHeader,
  type JwsKeyResolver,
  type PublicJwk,
} from "./jws";
import type { PactTransport } from "./transport";

interface JwksEntry {
  keys: { key: KeyObject; jwk: PublicJwk }[];
  fetchedAt: number;
  lastRefetchAt: number;
}

export interface JwksCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  refetchCooldownMs?: number;
  now?: () => number;
}

export class JwksFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwksFetchError";
  }
}

const MAX_KEYS_PER_SET = 16;

export class PactJwksCache {
  private readonly entries = new Map<string, JwksEntry>();
  private readonly inflight = new Map<string, Promise<JwksEntry>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: JwksCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 64;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.cooldownMs = options.refetchCooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** A key resolver for one key set; fetches go through the caller's (task-scoped) transport. */
  resolver(jwksUri: string, transport: PactTransport): JwsKeyResolver {
    return (header) => this.resolveKey(jwksUri, header, transport);
  }

  async resolveKey(
    jwksUri: string,
    header: JwsHeader,
    transport: PactTransport,
  ): Promise<{ key: KeyObject; jwk: PublicJwk } | undefined> {
    let entry = this.fresh(jwksUri);
    if (!entry) entry = await this.load(jwksUri, transport);
    let candidates = selectJwksCandidates(entry.keys, header);
    if (candidates.length === 0 && this.now() - entry.lastRefetchAt >= this.cooldownMs) {
      entry = await this.load(jwksUri, transport);
      candidates = selectJwksCandidates(entry.keys, header);
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  invalidate(jwksUri: string): void {
    this.entries.delete(jwksUri);
  }

  size(): number {
    return this.entries.size;
  }

  private fresh(jwksUri: string): JwksEntry | undefined {
    const entry = this.entries.get(jwksUri);
    if (!entry) return undefined;
    if (this.now() - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(jwksUri);
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(jwksUri);
    this.entries.set(jwksUri, entry);
    return entry;
  }

  private load(jwksUri: string, transport: PactTransport): Promise<JwksEntry> {
    const pending = this.inflight.get(jwksUri);
    if (pending) return pending;
    const promise = this.fetchSet(jwksUri, transport).finally(() => this.inflight.delete(jwksUri));
    this.inflight.set(jwksUri, promise);
    return promise;
  }

  private async fetchSet(jwksUri: string, transport: PactTransport): Promise<JwksEntry> {
    const response = await transport.request({ purpose: "jwks", url: jwksUri, method: "GET" });
    if (response.status !== 200) {
      throw new JwksFetchError(`JWKS request returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      throw new JwksFetchError("JWKS is not JSON");
    }
    const rawKeys = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(rawKeys)) throw new JwksFetchError("JWKS has no keys array");
    const keys: { key: KeyObject; jwk: PublicJwk }[] = [];
    for (const raw of rawKeys.slice(0, MAX_KEYS_PER_SET)) {
      try {
        keys.push(publicKeyFromJwk(raw));
      } catch {
        // Unusable keys (wrong type, private members, encryption keys) are skipped, not fatal.
      }
    }
    const at = this.now();
    const entry: JwksEntry = { keys, fetchedAt: at, lastRefetchAt: at };
    this.entries.delete(jwksUri);
    this.entries.set(jwksUri, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }
}
