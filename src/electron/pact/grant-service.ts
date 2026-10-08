/**
 * Business grants (plan §7 "Grants", "Refresh", "Disconnect").
 *
 * Many grants per (principal, subject, business interface, authorization server, account): the
 * reference provider issues a new grant with only the scopes requested at each consent and never
 * merges them. The covering grant is selected by required scopes at send time, narrowest first;
 * it is never selected by business name. Refresh is serialised per grant and the rotated refresh
 * token commits atomically with the new access token under a revision check.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decodeJwtPayloadUnverified } from "./jws";
import { PactStore } from "./pact-sql";
import type { PactRepository } from "./pact-repository";
import type { PactGrantSecret, PactSecretStore } from "./secret-store";
import type { PactGrantRecord } from "./types";
import { OAuthError, type DelegationToken } from "./upstream/client-delegation";

const ACCESS_TOKEN_MIN_REMAINING_MS = 60_000;
/** The reference provider's grant lifetime; used only when a token carries no hint. */
const DEFAULT_GRANT_LIFETIME_MS = 30 * 24 * 3600_000;

export class PactGrantUnavailableError extends Error {
  constructor(
    readonly code: "invalid" | "expired" | "disconnected" | "secret_missing" | "refresh_failed",
    message: string,
  ) {
    super(message);
    this.name = "PactGrantUnavailableError";
  }
}

export interface GrantKey {
  principalId: string;
  subjectBindingId: string;
  businessId: string;
  interfaceUrl: string;
  authorizationServer: string;
}

/** Account binding is stored as a digest; the raw business user id stays inside the token. */
export function accountBindingDigest(brandUserId: string): string {
  return createHash("sha256").update(`pact-account:${brandUserId}`).digest("hex");
}

export function tokenFacts(accessToken: string): {
  remoteGrantId: string | null;
  brandUserId: string | null;
  scope: string[] | null;
} {
  try {
    const claims = decodeJwtPayloadUnverified(accessToken);
    return {
      remoteGrantId: typeof claims.grant_id === "string" ? claims.grant_id : null,
      brandUserId: typeof claims.sub === "string" ? claims.sub : null,
      scope: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : null,
    };
  } catch {
    return { remoteGrantId: null, brandUserId: null, scope: null };
  }
}

function covers(grant: PactGrantRecord, required: readonly string[]): boolean {
  const scopes = new Set(grant.scopes);
  return required.every((scope) => scopes.has(scope));
}

export class PactGrantService {
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly deps: {
      repo: PactRepository;
      secrets: PactSecretStore;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private matchesKey(grant: PactGrantRecord, key: GrantKey): boolean {
    return (
      grant.principalId === key.principalId &&
      grant.subjectBindingId === key.subjectBindingId &&
      grant.businessId === key.businessId &&
      grant.interfaceUrl === key.interfaceUrl &&
      grant.authorizationServer === key.authorizationServer
    );
  }

  /** Active grants for this exact key; expired ones are marked so on the way. */
  async activeGrants(key: GrantKey): Promise<PactGrantRecord[]> {
    const grants = await this.deps.repo.listGrants({
      principalId: key.principalId,
      businessId: key.businessId,
      subjectBindingId: key.subjectBindingId,
      states: ["active"],
    });
    const at = this.now();
    const active: PactGrantRecord[] = [];
    for (const grant of grants) {
      if (!this.matchesKey(grant, key)) continue;
      if (grant.grantExpiresAt !== null && grant.grantExpiresAt <= at) {
        await this.deps.repo.updateGrant(grant.id, {
          state: "expired",
          stateReason: "grant_expired",
        });
        continue;
      }
      active.push(grant);
    }
    return active;
  }

  /** The narrowest active grant covering every required scope, newest on ties. */
  async findCoveringGrant(
    key: GrantKey,
    requiredScopes: readonly string[],
  ): Promise<PactGrantRecord | null> {
    const candidates = (await this.activeGrants(key)).filter((grant) =>
      covers(grant, requiredScopes),
    );
    candidates.sort(
      (left, right) => left.scopes.length - right.scopes.length || right.createdAt - left.createdAt,
    );
    return candidates[0] ?? null;
  }

  /** Union of scopes across active grants, for the step-up request. */
  async effectiveScopes(key: GrantKey): Promise<string[]> {
    const scopes = new Set<string>();
    for (const grant of await this.activeGrants(key)) {
      for (const scope of grant.scopes) scopes.add(scope);
    }
    return [...scopes].sort();
  }

  async storeGrant(key: GrantKey, token: DelegationToken): Promise<PactGrantRecord> {
    const facts = tokenFacts(token.accessToken);
    const secretRef = randomUUID();
    const secret: PactGrantSecret = {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      accessExpiresAt: token.expiresAt,
    };
    // Secret first: a crash after this leaves an unreferenced secret, never a grant row whose
    // token is missing.
    this.deps.secrets.putGrant(secretRef, secret);
    return this.deps.repo.insertGrant({
      ...key,
      accountBinding: facts.brandUserId ? accountBindingDigest(facts.brandUserId) : null,
      remoteGrantId: facts.remoteGrantId,
      // The approved scope from the token response is authoritative, not what was requested.
      scopes: token.scopes,
      secretRef,
      accessExpiresAt: token.expiresAt,
      grantExpiresAt: this.now() + DEFAULT_GRANT_LIFETIME_MS,
    });
  }

  /** The raw business user id and grant id, for receipt binding checks. */
  grantClaims(grant: PactGrantRecord): {
    brandUserId: string | null;
    remoteGrantId: string | null;
  } {
    const secret = this.deps.secrets.getGrant(grant.secretRef);
    if (!secret) return { brandUserId: null, remoteGrantId: grant.remoteGrantId };
    const facts = tokenFacts(secret.accessToken);
    return {
      brandUserId: facts.brandUserId,
      remoteGrantId: facts.remoteGrantId ?? grant.remoteGrantId,
    };
  }

  /**
   * A usable access token. Expiring tokens are refreshed once per grant at a time; a rejected
   * refresh (single-use rotation means reuse returns invalid_grant) invalidates the grant.
   */
  async accessToken(
    grant: PactGrantRecord,
    refresh: (refreshToken: string) => Promise<DelegationToken>,
  ): Promise<string> {
    const current = await this.deps.repo.getGrant(grant.id);
    if (!current || current.state !== "active") {
      throw new PactGrantUnavailableError(
        current?.state === "disconnected" ? "disconnected" : "invalid",
        "The business permission is no longer active",
      );
    }
    const secret = this.deps.secrets.getGrant(current.secretRef);
    if (!secret) {
      await this.invalidate(current.id, "secret_missing");
      throw new PactGrantUnavailableError(
        "secret_missing",
        "The stored business permission is missing",
      );
    }
    if (secret.accessExpiresAt - this.now() > ACCESS_TOKEN_MIN_REMAINING_MS) {
      return secret.accessToken;
    }
    const inflight = this.refreshes.get(current.id);
    if (inflight) return inflight;
    const promise = this.refreshGrant(current, secret, refresh).finally(() =>
      this.refreshes.delete(current.id),
    );
    this.refreshes.set(current.id, promise);
    return promise;
  }

  private async refreshGrant(
    grant: PactGrantRecord,
    secret: PactGrantSecret,
    refresh: (refreshToken: string) => Promise<DelegationToken>,
  ): Promise<string> {
    if (!secret.refreshToken) {
      await this.deps.repo.updateGrant(grant.id, {
        state: "expired",
        stateReason: "access_expired",
      });
      throw new PactGrantUnavailableError("expired", "The business permission expired");
    }
    let token: DelegationToken;
    try {
      token = await refresh(secret.refreshToken);
    } catch (error) {
      if (error instanceof OAuthError && error.error === "invalid_grant") {
        await this.invalidate(grant.id, "refresh_rejected");
        throw new PactGrantUnavailableError(
          "invalid",
          "The business no longer accepts this permission; reconnect to continue",
        );
      }
      throw new PactGrantUnavailableError(
        "refresh_failed",
        "The business permission could not be refreshed",
      );
    }
    const next: PactGrantSecret = {
      accessToken: token.accessToken,
      // Rotation: the old refresh token is spent, keep only the new one.
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      accessExpiresAt: token.expiresAt,
    };
    const facts = tokenFacts(token.accessToken);
    const now = this.now();
    const expectedRevision = grant.secretRevision;
    const committed = this.deps.secrets.rotateGrant(
      grant.secretRef,
      next,
      (db: Database.Database) =>
        new PactStore(db, () => now).updateGrant(
          grant.id,
          {
            secretRevision: expectedRevision + 1,
            accessExpiresAt: token.expiresAt,
            // Narrower returned scopes replace what CoWork assumed.
            scopes: token.scopes,
            ...(facts.remoteGrantId ? { remoteGrantId: facts.remoteGrantId } : {}),
          },
          expectedRevision,
        ) !== null,
    );
    if (!committed) {
      // Another writer rotated first; its tokens are current. Our rotated refresh token is
      // unrecoverable, which only matters if theirs is lost too.
      const latest = await this.deps.repo.getGrant(grant.id);
      const latestSecret = latest ? this.deps.secrets.getGrant(latest.secretRef) : undefined;
      if (latest?.state === "active" && latestSecret) return latestSecret.accessToken;
      throw new PactGrantUnavailableError(
        "refresh_failed",
        "The business permission changed during refresh",
      );
    }
    return token.accessToken;
  }

  async invalidate(grantId: string, reason: string): Promise<void> {
    const grant = await this.deps.repo.getGrant(grantId);
    if (!grant || grant.state !== "active") return;
    await this.deps.repo.updateGrant(grantId, { state: "invalid", stateReason: reason });
    try {
      this.deps.secrets.deleteGrant(grant.secretRef);
    } catch {
      // The row is already unusable; a leftover secret is unreachable.
    }
  }

  async touch(grantId: string): Promise<void> {
    await this.deps.repo.updateGrant(grantId, { lastUsedAt: this.now() });
  }

  /**
   * Local disconnect: block use and remove token material now. PACT 1.0 has no revocation
   * endpoint, so this never claims the business revoked anything.
   */
  async disconnect(grantId: string, principalId: string): Promise<PactGrantRecord | null> {
    const grant = await this.deps.repo.getGrant(grantId);
    if (!grant || grant.principalId !== principalId) return null;
    const updated = await this.deps.repo.updateGrant(grantId, {
      state: "disconnected",
      stateReason: "disconnected_locally",
    });
    this.deps.secrets.deleteGrant(grant.secretRef);
    return updated;
  }
}
