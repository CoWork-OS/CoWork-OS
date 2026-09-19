import { GuardrailManager } from "../guardrails/guardrail-manager";
import { loadPolicies } from "../admin/policies";
import type { AccessDomainRule } from "../../shared/access-profiles";
import { assertResolvedHostAllowed, isBlockedInternalHost } from "./address-classes";

export interface NetworkPolicyDecision {
  action: "allow" | "deny";
  url: string;
  domain: string;
  toolName: string;
  reason: string;
  ruleSource: "admin_policy" | "legacy_guardrails" | "access_profile" | "workspace_permissions";
  matchedRule?: string;
}

export interface NetworkPolicyRequest {
  url: string;
  toolName: string;
  networkEnabled?: boolean;
  accessNetworkMode?: "disabled" | "on-request" | "enabled";
  profileDomainRules?: AccessDomainRule[];
}

function normalizeDomainPattern(pattern: string): string {
  return String(pattern || "")
    .trim()
    .toLowerCase();
}

export function domainMatches(hostname: string, pattern: string): boolean {
  const normalizedHostname = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const normalizedPattern = normalizeDomainPattern(pattern);
  if (!normalizedHostname || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("**.")) {
    const suffix = normalizedPattern.slice(3);
    return (
      Boolean(suffix) &&
      (normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`))
    );
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return (
      Boolean(suffix) && normalizedHostname !== suffix && normalizedHostname.endsWith(`.${suffix}`)
    );
  }
  return normalizedHostname === normalizedPattern.replace(/\.$/, "");
}

export function toLogSafeNetworkPolicyUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

export function evaluateNetworkPolicy(request: NetworkPolicyRequest): NetworkPolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return {
      action: "deny",
      url: request.url,
      domain: "",
      toolName: request.toolName,
      reason: "invalid_url",
      ruleSource: "admin_policy",
    };
  }

  const domain = parsed.hostname.toLowerCase();
  const logSafeUrl = toLogSafeNetworkPolicyUrl(parsed);

  // Internal-address boundary, checked before the general allowlists so a
  // broad `allowedDomains` entry or a permissive default cannot open it.
  // Decisions here were previously made purely on hostname strings, which let
  // an agent-supplied URL reach cloud metadata (169.254.169.254) and private
  // ranges from the user's host and relay the response back into model context.
  //
  // Loopback stays reachable: the agent legitimately fetches dev servers it
  // starts, and the app's own loopback services all require bearer tokens.
  //
  // `runtime.network.allowedInternalHosts` is the deliberate escape hatch, and
  // the only one. Self-hosted deployments legitimately live on the LAN — a
  // SearXNG or Ollama box, an intranet webhook target — and without a way to
  // re-open a named host those configurations become unusable with no
  // available fix. It is admin-policy-only (never agent- or renderer-writable)
  // and rejects `*`/`**.` wildcards, so re-opening one host does not re-open
  // the metadata endpoint.
  if (isBlockedInternalHost(domain, true)) {
    // `?? []` keeps this fail-closed against a policy object written before
    // the field existed (or a partial one supplied by a caller/test).
    const internalAllowMatch = (loadPolicies().runtime.network.allowedInternalHosts ?? []).find(
      (pattern) => domainMatches(domain, pattern),
    );
    if (!internalAllowMatch) {
      return {
        action: "deny",
        url: logSafeUrl,
        domain,
        toolName: request.toolName,
        reason: "internal_address_blocked",
        ruleSource: "admin_policy",
      };
    }
  }

  if (request.accessNetworkMode === "disabled") {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "profile_network_disabled",
      ruleSource: "access_profile",
    };
  }
  if (request.networkEnabled === false) {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "workspace_network_disabled",
      ruleSource: "workspace_permissions",
    };
  }
  const policies = loadPolicies();
  const profileRules = request.profileDomainRules || [];
  const profileDeny = profileRules.find(
    (rule) => rule.access === "deny" && domainMatches(domain, rule.pattern),
  );
  if (profileDeny) {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "profile_domain_denied",
      ruleSource: "access_profile",
      matchedRule: profileDeny.pattern,
    };
  }
  const profileAllows = profileRules.filter((rule) => rule.access === "allow");
  if (
    profileAllows.length > 0 &&
    !profileAllows.some((rule) => domainMatches(domain, rule.pattern))
  ) {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "profile_domain_not_allowed",
      ruleSource: "access_profile",
    };
  }
  const blockedMatch = policies.runtime.network.blockedDomains.find((pattern) =>
    domainMatches(domain, pattern),
  );
  if (blockedMatch) {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "blocked_domain",
      ruleSource: "admin_policy",
      matchedRule: blockedMatch,
    };
  }

  const allowedDomains = policies.runtime.network.allowedDomains;
  if (allowedDomains.length > 0) {
    const allowedMatch = allowedDomains.find((pattern) => domainMatches(domain, pattern));
    if (!allowedMatch) {
      return {
        action: "deny",
        url: logSafeUrl,
        domain,
        toolName: request.toolName,
        reason: "domain_not_in_admin_allowlist",
        ruleSource: "admin_policy",
      };
    }
    return {
      action: "allow",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "admin_allowlist_match",
      ruleSource: "admin_policy",
      matchedRule: allowedMatch,
    };
  }

  if (policies.runtime.network.defaultAction === "deny") {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "admin_default_deny",
      ruleSource: "admin_policy",
    };
  }

  if (!GuardrailManager.isDomainAllowed(parsed.toString())) {
    return {
      action: "deny",
      url: logSafeUrl,
      domain,
      toolName: request.toolName,
      reason: "legacy_guardrail_domain_denied",
      ruleSource: "legacy_guardrails",
    };
  }

  return {
    action: "allow",
    url: logSafeUrl,
    domain,
    toolName: request.toolName,
    reason: "allowed",
    ruleSource: "admin_policy",
  };
}

export function assertNetworkPolicyAllowed(request: NetworkPolicyRequest): NetworkPolicyDecision {
  const decision = evaluateNetworkPolicy(request);
  if (decision.action === "allow") {
    return decision;
  }
  throw new Error(`Network access denied for "${request.url}": ${decision.reason}`);
}

/**
 * Policy check plus DNS resolution, for any caller about to actually connect.
 *
 * `evaluateNetworkPolicy` can only inspect the literal host, so it passes an
 * attacker-supplied `evil.test` whose A record is 169.254.169.254 — the agent
 * then fetches cloud metadata and the body comes back into model context.
 * Resolving here is what closes that, and doing it in the shared entry point is
 * what keeps every egress path covered instead of only the one tool that
 * remembered to call it.
 *
 * Prefer this over `evaluateNetworkPolicy`/`assertNetworkPolicyAllowed`
 * wherever a request is about to be issued, and call it again for each redirect
 * hop.
 */
export async function assertNetworkDestinationAllowed(
  request: NetworkPolicyRequest,
): Promise<NetworkPolicyDecision> {
  const decision = assertNetworkPolicyAllowed(request);
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    throw new Error(`Network access denied for "${request.url}": malformed_url`);
  }
  await assertResolvedHostAllowed(hostname);
  return decision;
}
