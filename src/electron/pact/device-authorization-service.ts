/**
 * Business consent over RFC 8628 (plan §7 "Consent flow", "Durable wait").
 *
 * CoWork shows the business's own sign-in link and never proxies, frames or observes the login.
 * The runtime, not the user, decides the outcome: a bounded poll under a per-request lease (so
 * two runtimes on one profile never poll the same device code) reads the token endpoint until
 * the user approves, denies, or the code expires. The approved `scope` is read; it may be
 * narrower than requested.
 */
import { randomUUID } from "node:crypto";
import type { PactRepository } from "./pact-repository";
import type { PactSecretStore } from "./secret-store";
import type { PactAuthorizationRecord, PactBusinessRecord } from "./types";
import { runBoundedPoll } from "./bounded-poller";
import { checkPactUrl, type PactUrlRules } from "./protocol-adapter";
import {
  requestDeviceAuthorization,
  requestDeviceToken,
  type PactClientCredentials,
} from "./protocol-client";
import { PactTransportError, type PactTransport } from "./transport";
import {
  assertRequestableScopes,
  interpretPollError,
  OAuthError,
  type DelegationToken,
} from "./upstream/client-delegation";

export const AUTHORIZATION_LEASE_MS = 45_000;
/** Never poll faster than the spec's default interval, whatever the server says. */
const MIN_INTERVAL_SECONDS = 2;
const MAX_WAIT_MS = 30 * 60_000;

export class PactAuthorizationError extends Error {
  constructor(
    readonly code:
      | "not_delegated"
      | "invalid_scope"
      | "unsafe_verification_uri"
      | "provider_rejected"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PactAuthorizationError";
  }
}

export type PactAuthorizationOutcome =
  | { kind: "granted"; token: DelegationToken }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "cancelled" }
  | { kind: "lease_lost" }
  | { kind: "failed"; reason: string };

export class PactDeviceAuthorizationService {
  constructor(
    private readonly deps: {
      repo: PactRepository;
      secrets: PactSecretStore;
      leaseOwner: string;
      now?: () => number;
      /** Tests shorten the wait between polls. */
      pollIntervalMs?: number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(input: {
    business: PactBusinessRecord;
    scopes: string[];
    principalId: string;
    subjectBindingId: string;
    taskId: string | null;
    workspaceId: string | null;
    conversationId: string | null;
    operationId: string | null;
    purpose: string;
    transport: PactTransport;
    credentials: PactClientCredentials;
    rules: PactUrlRules;
  }): Promise<{ record: PactAuthorizationRecord; verificationOrigin: string }> {
    const delegation = input.business.descriptor.delegation;
    if (!delegation) {
      throw new PactAuthorizationError(
        "not_delegated",
        "This business does not offer account access",
      );
    }
    try {
      assertRequestableScopes(input.scopes, delegation.scopes);
    } catch (error) {
      throw new PactAuthorizationError(
        "invalid_scope",
        error instanceof Error ? error.message : "Unknown scope",
      );
    }
    let authorization;
    try {
      authorization = await requestDeviceAuthorization(input.transport, {
        url: delegation.deviceAuthorizationUrl,
        scopes: input.scopes,
        credentials: input.credentials,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof OAuthError && error.error === "invalid_scope") {
        throw new PactAuthorizationError(
          "invalid_scope",
          "The business rejected the requested permissions",
        );
      }
      if (error instanceof OAuthError) {
        throw new PactAuthorizationError(
          "provider_rejected",
          `The business refused the sign-in request (${error.error})`,
        );
      }
      throw new PactAuthorizationError(
        "unavailable",
        error instanceof PactTransportError
          ? error.message
          : "The sign-in request could not be started",
      );
    }
    // The link goes to the user's own browser: only an HTTPS URL without credentials is shown.
    const complete = checkPactUrl(authorization.verificationUriComplete, input.rules);
    const plain = checkPactUrl(authorization.verificationUri, input.rules);
    if (!complete || !plain) {
      throw new PactAuthorizationError(
        "unsafe_verification_uri",
        "The business returned a sign-in link CoWork will not open",
      );
    }
    const secretRef = randomUUID();
    this.deps.secrets.putAuthorization(secretRef, {
      deviceCode: authorization.deviceCode,
      userCode: authorization.userCode,
      verificationUri: plain.toString(),
      verificationUriComplete: complete.toString(),
    });
    const record = await this.deps.repo.insertAuthorization({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      subjectBindingId: input.subjectBindingId,
      businessId: input.business.id,
      conversationId: input.conversationId,
      operationId: input.operationId,
      purpose: input.purpose.slice(0, 500),
      requestedScopes: [...new Set(input.scopes)].sort(),
      expiresAt: Math.min(authorization.expiresAt, this.now() + MAX_WAIT_MS),
      intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, authorization.intervalSeconds),
      secretRef,
      leaseOwner: this.deps.leaseOwner,
      leaseMs: AUTHORIZATION_LEASE_MS,
    });
    return { record, verificationOrigin: complete.origin };
  }

  /**
   * Poll until a decision. Each attempt first renews the lease; losing it means another runtime
   * took over and owns the outcome.
   */
  async waitForDecision(input: {
    record: PactAuthorizationRecord;
    tokenUrl: string;
    transport: () => PactTransport;
    credentials: () => Promise<PactClientCredentials>;
    signal?: AbortSignal;
  }): Promise<PactAuthorizationOutcome> {
    const secret = this.deps.secrets.getAuthorization(input.record.secretRef);
    if (!secret) return { kind: "failed", reason: "device_code_missing" };
    let decided: PactAuthorizationOutcome | undefined;
    const outcome = await runBoundedPoll<DelegationToken>({
      intervalMs: this.deps.pollIntervalMs ?? input.record.intervalSeconds * 1000,
      // RFC 8628 §3.5: +5 s per slow_down (tests scale it with their poll interval).
      slowDownIncrementMs: this.deps.pollIntervalMs ?? 5_000,
      deadline: input.record.expiresAt,
      now: () => this.now(),
      ...(input.signal ? { signal: input.signal } : {}),
      holdsLease: () =>
        this.deps.repo.acquireAuthorizationLease(
          input.record.id,
          this.deps.leaseOwner,
          AUTHORIZATION_LEASE_MS,
        ),
      isTransientError: (error) =>
        error instanceof PactTransportError &&
        (error.code === "timeout" || error.code === "network" || error.code === "rate_limited"),
      attempt: async () => {
        try {
          const token = await requestDeviceToken(input.transport(), {
            url: input.tokenUrl,
            deviceCode: secret.deviceCode,
            credentials: await input.credentials(),
            now: () => this.now(),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          return { kind: "done", value: token };
        } catch (error) {
          const step = interpretPollError(error);
          if (step?.status === "pending") return { kind: "continue" };
          if (step?.status === "slow_down") return { kind: "slow_down" };
          if (error instanceof PactTransportError && error.code === "rate_limited") {
            return { kind: "retry_after", delayMs: error.retryAfterMs ?? 10_000 };
          }
          if (error instanceof OAuthError && error.error === "access_denied") {
            decided = { kind: "denied" };
            throw error;
          }
          if (error instanceof OAuthError && error.error === "expired_token") {
            decided = { kind: "expired" };
            throw error;
          }
          throw error;
        }
      },
    });
    if (outcome.kind === "done") return { kind: "granted", token: outcome.value };
    if (outcome.kind === "expired") return { kind: "expired" };
    if (outcome.kind === "aborted") return { kind: "cancelled" };
    if (outcome.kind === "lease_lost") return { kind: "lease_lost" };
    if (decided) return decided;
    const error = outcome.error;
    return {
      kind: "failed",
      reason:
        error instanceof OAuthError
          ? `oauth_${error.error}`
          : error instanceof PactTransportError
            ? `transport_${error.code}`
            : "poll_failed",
    };
  }

  /** Record the outcome once and drop the device code; returns null if already settled. */
  async settle(
    record: PactAuthorizationRecord,
    outcome: Exclude<PactAuthorizationOutcome, { kind: "lease_lost" }>,
    extra: { grantId?: string; grantedScopes?: string[]; inputRequestId?: string } = {},
  ): Promise<PactAuthorizationRecord | null> {
    const state =
      outcome.kind === "granted" ? "granted" : outcome.kind === "failed" ? "failed" : outcome.kind;
    const settled = await this.deps.repo.settleAuthorization(record.id, {
      state,
      stateReason: outcome.kind === "failed" ? outcome.reason : null,
      ...(extra.grantId ? { grantId: extra.grantId } : {}),
      ...(extra.grantedScopes ? { grantedScopes: extra.grantedScopes } : {}),
    });
    try {
      this.deps.secrets.deleteAuthorization(record.secretRef);
    } catch {
      // The request is settled; an unreadable leftover code cannot be polled again.
    }
    return settled;
  }

  signIn(record: PactAuthorizationRecord) {
    return this.deps.secrets.getAuthorization(record.secretRef);
  }
}
