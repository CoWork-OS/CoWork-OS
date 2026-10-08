/**
 * Discovery with connection provenance (plan §6).
 *
 * Input is a business domain or an explicit card URL. The card is fetched without credentials
 * through the policy-aware transport (every redirect hop is policy-checked and DNS-pinned), and
 * the full origin chain is recorded: a display name proves nothing, the chain does. Delegation
 * endpoints and receipt keys come from the card's RFC 8414 metadata, which must agree with it.
 */
import { createHash } from "node:crypto";
import type { PactBusinessDescriptor, PactBusinessRecord, PactProviderRecord } from "./types";
import {
  cardSecurityFingerprintInput,
  checkPactUrl,
  evaluateAuthorizationServerMetadata,
  evaluateCardSupport,
  type PactUrlRules,
} from "./protocol-adapter";
import { canonicalJson } from "./upstream/client-delegation";
import type { PactRepository } from "./pact-repository";
import type { PactProviderContext, PactProviderRegistry } from "./provider-registry";
import { normalizeProviderOrigin } from "./provider-registry";
import { PactTransportError, type PactTransport } from "./transport";

const DEFAULT_CARD_TTL_MS = 5 * 60_000;
const MIN_CARD_TTL_MS = 60_000;
const MAX_CARD_TTL_MS = 60 * 60_000;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export class PactDiscoveryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "not_found"
      | "fetch_failed"
      | "policy_denied"
      | "invalid_json"
      | "metadata_invalid",
    message: string,
  ) {
    super(message);
    this.name = "PactDiscoveryError";
  }
}

export interface PactDiscoveryResult {
  business: PactBusinessRecord;
  provider: PactProviderRecord;
  support: { status: "supported" } | { status: "unsupported"; reason: string; detail: string };
  /** True when the card's security-relevant fields changed since the last discovery. */
  securityChanged: boolean;
  fromCache: boolean;
}

/** `example.com` → its well-known card URL; an explicit https URL is used as given. */
export function resolveCardUrl(
  input: { domain?: string; cardUrl?: string },
  rules: PactUrlRules,
): string {
  if (input.cardUrl) {
    const url = checkPactUrl(input.cardUrl.trim(), rules);
    if (!url) throw new PactDiscoveryError("invalid_input", "The card URL must be an HTTPS URL");
    return url.toString();
  }
  const domain = (input.domain ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(domain)) {
    throw new PactDiscoveryError("invalid_input", "Provide a business domain like example.com");
  }
  return `https://${domain}/.well-known/agent-card.json`;
}

function cacheTtl(cacheControl: string | null): number {
  const maxAge = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  if (/(?:^|,)\s*no-store/i.test(cacheControl ?? "")) return MIN_CARD_TTL_MS;
  if (!maxAge) return DEFAULT_CARD_TTL_MS;
  return Math.min(MAX_CARD_TTL_MS, Math.max(MIN_CARD_TTL_MS, Number(maxAge) * 1000));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PactDiscoveryError("invalid_json", "The business served a card that is not JSON");
  }
}

export class PactDiscoveryService {
  constructor(
    private readonly deps: {
      repo: PactRepository;
      providers: PactProviderRegistry;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async discover(input: {
    domain?: string;
    cardUrl?: string;
    transport: PactTransport;
    rules: PactUrlRules;
    providerContext: PactProviderContext;
    forceRefresh?: boolean;
  }): Promise<PactDiscoveryResult> {
    const cardUrl = resolveCardUrl(input, input.rules);
    const cached = await this.deps.repo.getBusinessByCardUrl(cardUrl);
    if (
      cached &&
      !input.forceRefresh &&
      cached.supportStatus === "supported" &&
      cached.expiresAt > this.now()
    ) {
      const provider = await this.deps.providers.resolve(
        normalizeProviderOrigin(cached.interfaceUrl),
        input.providerContext,
      );
      return {
        business: cached,
        provider,
        support: { status: "supported" },
        securityChanged: false,
        fromCache: true,
      };
    }
    return this.fetchAndStore(cardUrl, input);
  }

  /** Revalidate a known business before reusing it for an admitted operation. */
  async revalidate(
    business: PactBusinessRecord,
    input: { transport: PactTransport; rules: PactUrlRules; providerContext: PactProviderContext },
  ): Promise<PactDiscoveryResult> {
    if (business.expiresAt > this.now()) {
      const provider = await this.deps.providers.resolve(
        normalizeProviderOrigin(business.interfaceUrl),
        input.providerContext,
      );
      return {
        business,
        provider,
        support: { status: "supported" },
        securityChanged: false,
        fromCache: true,
      };
    }
    return this.fetchAndStore(business.cardUrl, input);
  }

  private async fetchAndStore(
    cardUrl: string,
    input: { transport: PactTransport; rules: PactUrlRules; providerContext: PactProviderContext },
  ): Promise<PactDiscoveryResult> {
    let response;
    try {
      response = await input.transport.request({ purpose: "card", method: "GET", url: cardUrl });
    } catch (error) {
      if (error instanceof PactTransportError && error.code === "policy_denied") {
        throw new PactDiscoveryError("policy_denied", error.message);
      }
      throw new PactDiscoveryError(
        "fetch_failed",
        `The business's agent card could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) {
      throw new PactDiscoveryError("not_found", "The business does not publish an agent card");
    }
    if (response.status !== 200) {
      throw new PactDiscoveryError(
        "fetch_failed",
        `The agent card request returned ${response.status}`,
      );
    }
    const raw = parseJson(response.bodyText);
    const support = evaluateCardSupport(raw, input.rules);
    const originChain = response.chain.map((url) => new URL(url).toString());
    const fetchedAt = this.now();
    const expiresAt = fetchedAt + cacheTtl(response.headers.get("cache-control"));
    const cardFingerprint = sha256(canonicalJson(raw));

    if (support.status === "unsupported") {
      // Unsupported cards are recorded so the UI can explain why; nothing about them is trusted.
      const placeholderOrigin = normalizeProviderOrigin(response.url);
      const provider = await this.deps.providers.resolve(placeholderOrigin, input.providerContext);
      const { business, securityChanged } = await this.deps.repo.upsertBusiness({
        cardUrl,
        displayName:
          typeof (raw as { name?: unknown })?.name === "string"
            ? String((raw as { name: string }).name).slice(0, 200)
            : new URL(cardUrl).hostname,
        originChain,
        providerId: provider.id,
        interfaceUrl: response.url,
        profile: "identity",
        supportStatus: "unsupported",
        unsupportedReason: support.reason,
        cardFingerprint,
        securityFingerprint: sha256(`unsupported:${support.reason}`),
        descriptor: { description: "", identitySchemeName: "", skills: [] },
        expiresAt,
      });
      return {
        business,
        provider,
        support: { status: "unsupported", reason: support.reason, detail: support.detail },
        securityChanged,
        fromCache: false,
      };
    }

    const providerOrigin = normalizeProviderOrigin(support.interfaceUrl);
    const provider = await this.deps.providers.resolve(providerOrigin, input.providerContext);
    const descriptor: PactBusinessDescriptor = {
      description: support.card.description.slice(0, 2000),
      ...(support.card.provider?.organization
        ? { providerOrganization: support.card.provider.organization.slice(0, 200) }
        : {}),
      identitySchemeName: support.identitySchemeName,
      skills: support.card.skills.slice(0, 50).map((skill) => ({
        id: skill.id.slice(0, 120),
        name: skill.name.slice(0, 200),
        description: skill.description.slice(0, 1000),
      })),
    };
    let securityInput = cardSecurityFingerprintInput(support);
    if (support.delegation) {
      const metadata = await this.fetchMetadata(support.delegation.metadataUrl, input);
      const check = evaluateAuthorizationServerMetadata(metadata, support.delegation, input.rules);
      if (check.status === "invalid") {
        throw new PactDiscoveryError("metadata_invalid", check.detail);
      }
      descriptor.delegation = {
        deviceAuthorizationUrl: support.delegation.deviceAuthorizationUrl,
        tokenUrl: support.delegation.tokenUrl,
        refreshUrl: support.delegation.refreshUrl,
        metadataUrl: support.delegation.metadataUrl,
        scopes: support.delegation.scopes.slice(0, 200).map((scope) => ({
          id: scope.id,
          description: scope.description.slice(0, 500),
        })),
        authorizationServer: check.metadata.issuer,
        jwksUri: check.metadata.jwks_uri,
      };
      securityInput += `|${check.metadata.issuer}|${check.metadata.jwks_uri}`;
    }
    const { business, securityChanged } = await this.deps.repo.upsertBusiness({
      cardUrl,
      displayName: support.card.name.slice(0, 200) || new URL(cardUrl).hostname,
      originChain,
      providerId: provider.id,
      interfaceUrl: support.interfaceUrl,
      profile: support.profile,
      supportStatus: "supported",
      unsupportedReason: null,
      cardFingerprint,
      securityFingerprint: sha256(securityInput),
      descriptor,
      expiresAt,
    });
    return {
      business,
      provider,
      support: { status: "supported" },
      securityChanged,
      fromCache: false,
    };
  }

  private async fetchMetadata(
    metadataUrl: string,
    input: { transport: PactTransport },
  ): Promise<unknown> {
    let response;
    try {
      response = await input.transport.request({
        purpose: "metadata",
        method: "GET",
        url: metadataUrl,
      });
    } catch (error) {
      throw new PactDiscoveryError(
        error instanceof PactTransportError && error.code === "policy_denied"
          ? "policy_denied"
          : "fetch_failed",
        "The business's authorization server metadata could not be fetched",
      );
    }
    if (response.status !== 200) {
      throw new PactDiscoveryError(
        "metadata_invalid",
        `Authorization server metadata returned ${response.status}`,
      );
    }
    return parseJson(response.bodyText);
  }
}
