import { GuardrailManager } from "../guardrails/guardrail-manager";
import { loadPolicies } from "../admin/policies";
import type { AccessDomainRule } from "../../shared/access-profiles";

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
