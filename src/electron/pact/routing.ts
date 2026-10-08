/**
 * Availability gates and preference routing (plan §12, §15).
 *
 * Preference is never permission: routing a business interaction to PACT does not authorize
 * any operation; admission, consent and evidence still apply. Hard limits (admin policy, env,
 * settings) are checked first and cannot be relaxed by a preference.
 */
import type {
  BusinessAgentProtocolPreference,
  PactSettings,
  PactUnavailableReason,
} from "../../shared/pact";
import type { AdminPolicies } from "../admin/policies";
import { effectivePactPreference } from "./settings";

export const PACT_DISABLED_ENV = "COWORK_PACT_DISABLED";

export interface PactAvailability {
  available: boolean;
  reason?: PactUnavailableReason;
}

export function evaluatePactAvailability(input: {
  settings: PactSettings;
  policy: AdminPolicies["pact"];
  env?: NodeJS.ProcessEnv;
}): PactAvailability {
  const env = input.env ?? process.env;
  if (env[PACT_DISABLED_ENV] === "1") return { available: false, reason: "disabled_by_env" };
  if (!input.policy.enabled) return { available: false, reason: "disabled_by_admin" };
  if (!input.settings.enabled) return { available: false, reason: "disabled_in_settings" };
  if (input.settings.identity.deployment === "none") {
    return { available: false, reason: "identity_not_configured" };
  }
  return { available: true };
}

/** Whether the model should be offered PACT tools for a business interaction. */
export function pactToolsExposed(input: {
  settings: PactSettings;
  policy: AdminPolicies["pact"];
  env?: NodeJS.ProcessEnv;
}): boolean {
  const availability = evaluatePactAvailability(input);
  if (!availability.available && availability.reason !== "identity_not_configured") return false;
  return effectivePactPreference(input.settings) !== "disabled";
}

export type PactRouteDecision =
  | { route: "pact"; reason: "supported" }
  | {
      route: "other";
      reason: "not_supported" | "identity_not_ready" | "provider_not_ready" | "card_rejected";
      message: string;
    }
  | {
      route: "blocked";
      reason:
        | "pact_disabled"
        | "not_supported"
        | "identity_not_ready"
        | "provider_not_ready"
        | "card_rejected";
      message: string;
    };

export function resolveBusinessRoute(input: {
  preference: BusinessAgentProtocolPreference;
  availability: PactAvailability;
  support: "supported" | "unsupported" | "rejected";
  identityReady: boolean;
  providerReady: boolean;
}): PactRouteDecision {
  const require = input.preference === "require-pact";
  const fallback = (
    reason: "not_supported" | "identity_not_ready" | "provider_not_ready" | "card_rejected",
    message: string,
  ): PactRouteDecision =>
    require
      ? { route: "blocked", reason, message }
      : {
          route: "other",
          reason,
          message: `${message} Another route may be used only within the task's existing authority.`,
        };

  if (input.preference === "disabled" || !input.availability.available) {
    if (input.availability.reason === "identity_not_configured") {
      return fallback("identity_not_ready", "PACT identity is not set up in Settings.");
    }
    return {
      route: "blocked",
      reason: "pact_disabled",
      message: "PACT is turned off for this profile.",
    };
  }
  if (input.support === "rejected") {
    return fallback("card_rejected", "The business's agent card could not be trusted.");
  }
  if (input.support === "unsupported") {
    return fallback("not_supported", "The business does not advertise a supported PACT agent.");
  }
  if (!input.identityReady) {
    return fallback("identity_not_ready", "PACT identity is not ready.");
  }
  if (!input.providerReady) {
    return fallback(
      "provider_not_ready",
      "CoWork is not yet registered with this business's PACT provider.",
    );
  }
  return { route: "pact", reason: "supported" };
}
