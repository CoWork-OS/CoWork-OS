/**
 * Provider readiness (plan §5 "Provider onboarding", §15 per-provider disable).
 *
 * The audience a personal-agent JWT carries is assigned by the provider out of band. CoWork takes
 * it only from verified configuration: Settings entries an owner or admin typed, or the signer's
 * own registration list. A card can never supply it. Admin `pact.blockedProviders` is enforced
 * here so every send, poll and refresh passes through the same check.
 */
import type { PactSettings } from "../../shared/pact";
import type { AdminPolicies } from "../admin/policies";
import { isPactProviderBlocked } from "../admin/policies";
import type { PactRepository } from "./pact-repository";
import type { PactSignerStatus } from "./signer-client";
import type { PactProviderRecord } from "./types";

export interface PactProviderContext {
  settings: PactSettings;
  policies: AdminPolicies;
  signerStatus: PactSignerStatus | null;
  issuer: string | null;
}

export class PactProviderBlockedError extends Error {
  constructor(readonly origin: string) {
    super(`PACT provider ${origin} is blocked by administrator policy`);
    this.name = "PactProviderBlockedError";
  }
}

export function normalizeProviderOrigin(url: string): string {
  return new URL(url).origin.toLowerCase();
}

export class PactProviderRegistry {
  constructor(private readonly repo: PactRepository) {}

  /** Recompute and persist a provider's readiness from current configuration. */
  async resolve(origin: string, context: PactProviderContext): Promise<PactProviderRecord> {
    const normalized = normalizeProviderOrigin(origin);
    const configured = context.settings.providers.find(
      (provider) => provider.origin.toLowerCase() === normalized,
    );
    const signerAudience = Object.entries(context.signerStatus?.audiences ?? {}).find(
      ([candidate]) => {
        try {
          return normalizeProviderOrigin(candidate) === normalized;
        } catch {
          return false;
        }
      },
    )?.[1];
    const audience = configured?.audience ?? signerAudience ?? null;
    let readiness: PactProviderRecord["readiness"] = "ready";
    let reason: string | null = null;
    if (isPactProviderBlocked(normalized, context.policies)) {
      readiness = "blocked";
      reason = "blocked_by_admin";
    } else if (!audience) {
      readiness = "not_ready";
      reason = "audience_not_configured";
    } else if (!context.issuer) {
      readiness = "not_ready";
      reason = "identity_not_configured";
    }
    return this.repo.upsertProvider({
      origin: normalized,
      audience,
      issuer: context.issuer,
      registrationStatus: configured ? "manual" : signerAudience ? "registered" : "unknown",
      readiness,
      readinessReason: reason,
    });
  }

  /** The per-request gate: throws when the provider is blocked, returns the audience if ready. */
  async requireReady(origin: string, context: PactProviderContext): Promise<PactProviderRecord> {
    const provider = await this.resolve(origin, context);
    if (provider.readiness === "blocked") throw new PactProviderBlockedError(provider.origin);
    return provider;
  }
}
