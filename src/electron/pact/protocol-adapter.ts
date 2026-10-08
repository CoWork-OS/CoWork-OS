/**
 * Versioned boundary between PACT 1.0 wire data and CoWork's runtime.
 *
 * Everything a business serves (cards, metadata, replies) is external data. This module parses it
 * with the vendored upstream schemas and decides whether CoWork supports it. Anything it does not
 * understand is `unsupported`; nothing is coerced into the legacy ACP adapter.
 */
import { z } from "zod";
import { AgentCardSchema, type AgentCard } from "./upstream/protocol";
import {
  AuthorizationServerMetadataSchema,
  type AuthorizationServerMetadata,
} from "./upstream/delegation";
import { delegationScheme, type DelegationScheme } from "./upstream/client-delegation";
import { isBlockedInternalHost } from "../security/address-classes";

export const PACT_PROTOCOL_VERSION = "1.0";
export const PACT_A2A_BINDING = "HTTP+JSON";
export const PACT_UPSTREAM_COMMIT = "838c6bd1da9be39da04264e8b156dbb4e848a208";

/** Strict top-level card: every A2A 1.0 AgentCard field is known, so extras mean a newer shape. */
const StrictAgentCardSchema = AgentCardSchema.strict();

export type PactProfile = "identity" | "delegated";

export type PactUnsupportedReason =
  | "invalid_card"
  | "no_http_json_1_0_interface"
  | "ambiguous_interface"
  | "interface_tenant_unsupported"
  | "insecure_url"
  | "identity_scheme_missing"
  | "identity_scheme_ambiguous"
  | "identity_requirement_missing"
  | "delegation_scheme_ambiguous"
  | "delegation_cross_origin"
  | "required_extension_unsupported";

export interface PactSupportedCard {
  status: "supported";
  card: AgentCard;
  profile: PactProfile;
  interfaceUrl: string;
  identitySchemeName: string;
  delegation?: DelegationScheme;
}

export interface PactUnsupportedCard {
  status: "unsupported";
  reason: PactUnsupportedReason;
  detail: string;
}

export type PactCardSupport = PactSupportedCard | PactUnsupportedCard;

export interface PactUrlRules {
  /** Development configuration only: allow http:// on loopback hosts. */
  allowLoopbackHttp: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/**
 * HTTPS only, no URL credentials, no fragments, and no loopback, private or metadata literal
 * hosts; loopback (http or https) only under development rules.
 */
export function checkPactUrl(raw: string, rules: PactUrlRules): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.hash) return undefined;
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !rules.allowLoopbackHttp) return undefined;
  if (!loopback && isBlockedInternalHost(url.hostname, false)) return undefined;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && rules.allowLoopbackHttp && isLoopbackHost(url.hostname)) {
    return url;
  }
  return undefined;
}

function unsupported(reason: PactUnsupportedReason, detail: string): PactUnsupportedCard {
  return { status: "unsupported", reason, detail };
}

function isBearerJwtScheme(scheme: unknown): boolean {
  if (!scheme || typeof scheme !== "object" || !("httpAuthSecurityScheme" in scheme)) return false;
  const http = (scheme as { httpAuthSecurityScheme: { scheme?: unknown; bearerFormat?: unknown } })
    .httpAuthSecurityScheme;
  return (
    typeof http.scheme === "string" &&
    http.scheme.toLowerCase() === "bearer" &&
    typeof http.bearerFormat === "string" &&
    http.bearerFormat.toUpperCase() === "JWT"
  );
}

function sameNames(names: string[], expected: string[]): boolean {
  if (names.length !== expected.length) return false;
  const set = new Set(names);
  return expected.every((name) => set.has(name));
}

/**
 * The §2 support check. Interfaces are selected by binding and version, schemes by type rather
 * than key name, and every URL the runtime will call must pass the URL rules.
 */
export function evaluateCardSupport(raw: unknown, rules: PactUrlRules): PactCardSupport {
  const parsed = StrictAgentCardSchema.safeParse(raw);
  if (!parsed.success) {
    return unsupported("invalid_card", parsed.error.issues[0]?.message ?? "Card is not valid");
  }
  const card = parsed.data as AgentCard;

  const interfaces = card.supportedInterfaces.filter(
    (candidate) =>
      candidate.protocolBinding === PACT_A2A_BINDING &&
      candidate.protocolVersion === PACT_PROTOCOL_VERSION,
  );
  if (interfaces.length === 0) {
    return unsupported("no_http_json_1_0_interface", "No HTTP+JSON 1.0 interface is advertised");
  }
  const distinctUrls = new Set(interfaces.map((candidate) => candidate.url));
  if (distinctUrls.size > 1) {
    return unsupported("ambiguous_interface", "Several HTTP+JSON 1.0 interfaces are advertised");
  }
  const selected = interfaces[0]!;
  if (selected.tenant !== undefined) {
    return unsupported("interface_tenant_unsupported", "Interface tenants are not supported");
  }
  if (!checkPactUrl(selected.url, rules)) {
    return unsupported("insecure_url", "The interface URL is not an allowed HTTPS URL");
  }

  const requiredExtension = card.capabilities.extensions?.find((extension) => extension.required);
  if (requiredExtension) {
    return unsupported(
      "required_extension_unsupported",
      `Required extension is not supported: ${requiredExtension.uri}`,
    );
  }

  const schemes = card.securitySchemes ?? {};
  const identityNames = Object.entries(schemes)
    .filter(([, scheme]) => isBearerJwtScheme(scheme))
    .map(([name]) => name);
  if (identityNames.length === 0) {
    return unsupported("identity_scheme_missing", "No Bearer JWT identity scheme is declared");
  }
  if (identityNames.length > 1) {
    return unsupported("identity_scheme_ambiguous", "More than one Bearer JWT scheme is declared");
  }
  const identitySchemeName = identityNames[0]!;
  const requirements = card.securityRequirements ?? [];
  const hasIdentityRequirement = requirements.some((requirement) =>
    sameNames(Object.keys(requirement.schemes), [identitySchemeName]),
  );
  if (!hasIdentityRequirement) {
    return unsupported(
      "identity_requirement_missing",
      "The identity scheme is not listed alone in a security requirement",
    );
  }

  const delegationCandidates = Object.entries(schemes).filter(
    ([, scheme]) => "oauth2SecurityScheme" in scheme,
  );
  const delegation = delegationScheme(card);
  if (!delegation) {
    return {
      status: "supported",
      card,
      profile: "identity",
      interfaceUrl: selected.url,
      identitySchemeName,
    };
  }
  if (delegation.identitySchemeName !== identitySchemeName) {
    return unsupported("identity_scheme_ambiguous", "Delegation pairs with an unexpected scheme");
  }
  const deviceCodeSchemes = delegationCandidates.filter(([name]) =>
    requirements.some((requirement) =>
      sameNames(Object.keys(requirement.schemes), [identitySchemeName, name]),
    ),
  );
  if (deviceCodeSchemes.length !== 1) {
    return unsupported("delegation_scheme_ambiguous", "Expected exactly one delegation scheme");
  }
  // The personal-agent JWT and the refresh token go to these endpoints: they must be on the
  // provider's own origin (the interface's), never a host the card merely names.
  const providerOrigin = new URL(selected.url).origin;
  for (const url of [
    delegation.deviceAuthorizationUrl,
    delegation.tokenUrl,
    delegation.refreshUrl,
    delegation.metadataUrl,
  ]) {
    const checked = checkPactUrl(url, rules);
    if (!checked) {
      return unsupported("insecure_url", "A delegation endpoint is not an allowed HTTPS URL");
    }
    if (checked.origin !== providerOrigin) {
      return unsupported(
        "delegation_cross_origin",
        "Delegation endpoints must be on the same origin as the business's agent",
      );
    }
  }
  return {
    status: "supported",
    card,
    profile: "delegated",
    interfaceUrl: selected.url,
    identitySchemeName,
    delegation,
  };
}

export type PactMetadataCheck =
  | { status: "valid"; metadata: AuthorizationServerMetadata }
  | { status: "invalid"; detail: string };

/**
 * RFC 8414 metadata must agree with the card on the endpoints CoWork calls, and its jwks_uri is the
 * only key source for receipts. A mismatch means the card and server disagree; refuse both.
 */
export function evaluateAuthorizationServerMetadata(
  raw: unknown,
  delegation: DelegationScheme,
  rules: PactUrlRules,
): PactMetadataCheck {
  const parsed = AuthorizationServerMetadataSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", detail: "Metadata is not valid RFC 8414" };
  const metadata = parsed.data;
  if (metadata.device_authorization_endpoint !== delegation.deviceAuthorizationUrl) {
    return { status: "invalid", detail: "Device authorization endpoint does not match the card" };
  }
  if (metadata.token_endpoint !== delegation.tokenUrl) {
    return { status: "invalid", detail: "Token endpoint does not match the card" };
  }
  const metadataOrigin = new URL(delegation.metadataUrl).origin;
  for (const url of [metadata.issuer, metadata.jwks_uri]) {
    const checked = checkPactUrl(url, rules);
    if (!checked) {
      return { status: "invalid", detail: "Metadata URL is not an allowed HTTPS URL" };
    }
    // The receipt keys and the issuer belong to the server that published the metadata.
    if (checked.origin !== metadataOrigin) {
      return {
        status: "invalid",
        detail: "Metadata issuer and keys must be on the metadata's origin",
      };
    }
  }
  return { status: "valid", metadata };
}

/** A stable digest of the fields that change what an admitted operation may do. */
export function cardSecurityFingerprintInput(support: PactSupportedCard): string {
  return JSON.stringify({
    interfaceUrl: support.interfaceUrl,
    profile: support.profile,
    identity: support.identitySchemeName,
    delegation: support.delegation
      ? {
          deviceAuthorizationUrl: support.delegation.deviceAuthorizationUrl,
          tokenUrl: support.delegation.tokenUrl,
          refreshUrl: support.delegation.refreshUrl,
          metadataUrl: support.delegation.metadataUrl,
          scopes: [...support.delegation.scopes].sort((a, b) => a.id.localeCompare(b.id)),
        }
      : null,
  });
}

export const PactScopeIdSchema = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
