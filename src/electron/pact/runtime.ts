/**
 * The PACT runtime: the one place every effectful PACT operation runs (plan §4).
 *
 * Tool calls, Control Plane methods, IPC, CLI commands and startup reconciliation all enter here
 * with an explicit principal and call context. Descriptors, provider metadata and replies are
 * external data: they cannot change workspace policy, select another user, change the signer
 * audience or widen disclosure.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  PactAuthorizationSignIn,
  PactAuthorizationState,
  PactAuthorizationView,
  PactBusinessView,
  PactConversationView,
  PactEffectClass,
  PactEvidenceStatus,
  PactGrantView,
  PactReceiptView,
  PactSendOutcome,
  PactSettings,
  PactStatusView,
} from "../../shared/pact";
import type { AdminPolicies } from "../admin/policies";
import type { NetworkPolicyContext } from "../security/policy-checked-fetch";
import {
  admitPactOperation,
  authorityFingerprint,
  type PactLocalAuthority,
  type PactTaskOrigin,
} from "./admission-service";
import {
  bodyDigest,
  MAX_CONTEXT_ATTEMPTS,
  PACT_INTRODUCTION_TEXT,
  PactConversationService,
  type PactTurnResult,
} from "./conversation-service";
import {
  PactDeviceAuthorizationService,
  PactAuthorizationError,
  type PactAuthorizationOutcome,
} from "./device-authorization-service";
import { DevelopmentPactSigner, isPactDevelopmentEnabled } from "./development-signer";
import { PactDiscoveryError, PactDiscoveryService } from "./discovery-service";
import { PactGrantService, PactGrantUnavailableError, type GrantKey } from "./grant-service";
import { PactJwksCache } from "./jwks-cache";
import { generateEs256KeyPair, privateKeyFromJwk, type Es256KeyPair } from "./jws";
import { PactRepository } from "./pact-repository";
import { serviceStatements } from "../database/service-statements";
import { refreshDelegationToken, type PactClientCredentials } from "./protocol-client";
import {
  PactProviderBlockedError,
  PactProviderRegistry,
  type PactProviderContext,
} from "./provider-registry";
import { verifyPactReceipt } from "./receipt-verifier";
import { redactPact, redactPactError } from "./redaction";
import { evaluatePactAvailability, resolveBusinessRoute, type PactRouteDecision } from "./routing";
import type { PactSecretStore } from "./secret-store";
import { effectivePactPreference } from "./settings";
import {
  HttpPactSigner,
  PactSignerError,
  PactTokenCache,
  type PactSigner,
  type PactSignerAuth,
  type PactSignerStatus,
} from "./signer-client";
import type { PactTransport } from "./transport";
import type {
  PactAuthorizationRecord,
  PactBusinessRecord,
  PactConversationRecord,
  PactGrantRecord,
  PactPrincipal,
  PactProviderRecord,
  PactSubjectBindingRecord,
} from "./types";
import {
  verificationOriginMatches,
  toAuthorizationView,
  toBusinessView,
  toConversationView,
  toGrantView,
  toReceiptView,
  scopeViews,
} from "./views";

/** Context of a call: where it came from and what it may do. */
export interface PactCallContext {
  taskId?: string;
  workspaceId?: string;
  sessionId?: string;
  origin: PactTaskOrigin;
  localAuthority: PactLocalAuthority;
  /**
   * Whether a person can act on a sign-in link: `interactive` (desktop/web task card),
   * `out_of_band` (CLI prints it and exits) or `none` (automation; consent is impossible).
   */
  humanInput: "interactive" | "out_of_band" | "none";
  /** The owner already confirmed this exact operation on their own surface. */
  preApproved?: boolean;
  /** Tool path: stay in the call until the consent wait settles. */
  waitForConsent?: boolean;
  networkContext: NetworkPolicyContext;
  signal?: AbortSignal;
}

/** What the runtime needs from the daemon (or a test double). */
export interface PactHost {
  requestLocalApproval(
    taskId: string,
    summary: string,
    details: Record<string, unknown>,
    /** Explicit: never satisfied by remembered rules, recurring approvals or permission modes. */
    options: { requireExplicit: boolean },
  ): Promise<boolean>;
  openAuthorizationWait(taskId: string, view: PactAuthorizationView): Promise<string>;
  settleAuthorizationWait(
    inputRequestId: string,
    state: PactAuthorizationState,
    message: string,
  ): Promise<void>;
  logEvent(taskId: string, type: string, payload: Record<string, unknown>): void;
  logInteractiveApprovalUnavailable(taskId: string, message: string): void;
  /**
   * Network rules for a wait resumed after a restart: its task's own access profile when it has a
   * task, else its workspace's rules, else (`null`, `null`) the default access profile's rules.
   * A `null` result means the task or workspace no longer exists.
   */
  networkContextForWorkspace(
    workspaceId: string | null,
    taskId?: string | null,
  ): Promise<NetworkPolicyContext | null>;
  taskStillWaiting(taskId: string): Promise<boolean>;
}

export interface PactSendRequest {
  businessId: string;
  conversationId?: string;
  text: string;
  effect: PactEffectClass;
  requiredScopes: string[];
  purpose?: string;
  /** Resend an operation whose outcome is unknown, with its original messageId and body. */
  reconcileOperationId?: string;
}

export interface PactRuntimeDeps {
  db: Database.Database;
  secrets: PactSecretStore;
  host: PactHost;
  settings: () => PactSettings;
  policies: () => AdminPolicies;
  transportFor: (networkContext: NetworkPolicyContext, taskId?: string) => PactTransport;
  now?: () => number;
  leaseOwner?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests supply the owner principal instead of the session-membership unit. */
  ownerPrincipalId?: () => Promise<string> | string;
  /** Tests shorten consent polling and retry backoff. */
  authorizationPollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Tests (and future managed enrollment) can supply the signer directly. */
  signerFor?: (identity: PactSettings["identity"]) => PactSigner | null;
}

interface IdentityState {
  fingerprint: string;
  tokens: PactTokenCache;
  issuer: string;
  deployment: "managed" | "self_hosted" | "development";
  development?: DevelopmentPactSigner;
}

interface ResolvedIdentity {
  identity: IdentityState;
  binding: PactSubjectBindingRecord;
  status: PactSignerStatus;
}

class PactBlocked extends Error {
  constructor(
    readonly outcome: Extract<
      PactSendOutcome,
      { status: "blocked" | "denied" | "expired" | "cancelled" | "unsupported" | "outcome_unknown" }
    >,
  ) {
    super(outcome.message);
  }
}

const MAX_STEP_UPS = 2;
const SIGNER_STATUS_TTL_MS = 60_000;

function blocked(reason: string, message: string, conversationId?: string): PactBlocked {
  return new PactBlocked({
    status: "blocked",
    reason,
    message,
    ...(conversationId ? { conversationId } : {}),
  });
}

function union(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort();
}

export class PactRuntime {
  readonly repo: PactRepository;
  private readonly providers: PactProviderRegistry;
  private readonly discovery: PactDiscoveryService;
  private readonly grants: PactGrantService;
  private readonly authorizations: PactDeviceAuthorizationService;
  private readonly conversations: PactConversationService;
  private readonly jwks: PactJwksCache;
  private readonly leaseOwner: string;
  private readonly pollers = new Map<
    string,
    { promise: Promise<PactAuthorizationOutcome & { grantId?: string }>; abort: AbortController }
  >();
  private identityState: IdentityState | null = null;
  private ownerId: string | null = null;
  /** Keyed by identity and by the network rules the status was fetched under. */
  private signerStatusCache: {
    fingerprint: string;
    contextKey: string;
    at: number;
    status: PactSignerStatus;
  } | null = null;
  private stopped = false;

  constructor(private readonly deps: PactRuntimeDeps) {
    const now = () => this.now();
    this.repo = new PactRepository(deps.db, now);
    this.leaseOwner = deps.leaseOwner ?? `pact-runtime:${randomUUID()}`;
    this.providers = new PactProviderRegistry(this.repo);
    this.discovery = new PactDiscoveryService({ repo: this.repo, providers: this.providers, now });
    this.grants = new PactGrantService({ repo: this.repo, secrets: deps.secrets, now });
    this.authorizations = new PactDeviceAuthorizationService({
      repo: this.repo,
      secrets: deps.secrets,
      leaseOwner: this.leaseOwner,
      now,
      ...(deps.authorizationPollIntervalMs
        ? { pollIntervalMs: deps.authorizationPollIntervalMs }
        : {}),
    });
    this.conversations = new PactConversationService({
      repo: this.repo,
      leaseOwner: this.leaseOwner,
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    this.jwks = new PactJwksCache({ now });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The profile owner, the principal every desktop, CLI and Control Plane call acts as. Read
   * through the services unit (never a client-principal fallback) and cached; `actor` records
   * which surface made the call.
   */
  async ownerPrincipal(actor?: string): Promise<PactPrincipal> {
    if (!this.ownerId) {
      this.ownerId = this.deps.ownerPrincipalId
        ? await this.deps.ownerPrincipalId()
        : (await serviceStatements(this.deps.db).unit("sessionMembership_getLocalPrincipal", []))
            .principalId;
    }
    return { id: this.ownerId, kind: "local_owner", ...(actor ? { actor } : {}) };
  }

  private settings(): PactSettings {
    return this.deps.settings();
  }

  private rules() {
    return { allowLoopbackHttp: this.settings().identity.deployment === "development" };
  }

  private availability() {
    return evaluatePactAvailability({
      settings: this.settings(),
      policy: this.deps.policies().pact,
      ...(this.deps.env ? { env: this.deps.env } : {}),
    });
  }

  private emit(
    ctx: { taskId?: string } | undefined,
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (!ctx?.taskId) return;
    try {
      this.deps.host.logEvent(ctx.taskId, type, redactPact(payload));
    } catch {
      // Timeline logging never decides an outcome.
    }
  }

  // ------------------------------------------------------------------ identity

  private identity(): IdentityState | null {
    const settings = this.settings();
    const identity = settings.identity;
    if (identity.deployment === "none") return null;
    const fingerprint = JSON.stringify(identity);
    if (this.identityState?.fingerprint === fingerprint) return this.identityState;
    let state: IdentityState | null = null;
    const injected = this.deps.signerFor?.(identity);
    if (injected) {
      state = {
        fingerprint,
        tokens: new PactTokenCache(injected, () => this.now()),
        issuer: injected.issuer,
        deployment: injected.deployment,
      };
    } else if (identity.deployment === "development") {
      if (!isPactDevelopmentEnabled(this.deps.env)) return null;
      const signer = new DevelopmentPactSigner({
        // Opaque and stable per local principal; never the principal id itself.
        subject: `cowork-dev-${createHash("sha256")
          .update(this.ownerId ?? "owner")
          .digest("hex")
          .slice(0, 32)}`,
        ...(identity.issuer ? { issuer: identity.issuer } : {}),
        audiences: Object.fromEntries(settings.providers.map((p) => [p.origin, p.audience])),
      });
      state = {
        fingerprint,
        tokens: new PactTokenCache(signer, () => this.now()),
        issuer: identity.issuer ?? "",
        deployment: "development",
        development: signer,
      };
    } else {
      if (!identity.issuer || !identity.signerUrl) return null;
      const auth = this.signerAuth(identity.authMode ?? "credential");
      if (!auth) return null;
      const signer = new HttpPactSigner({
        deployment: identity.deployment,
        issuer: identity.issuer,
        signerUrl: identity.signerUrl,
        auth,
        transport: (networkContext) => this.deps.transportFor(networkContext),
        now: () => this.now(),
      });
      state = {
        fingerprint,
        tokens: new PactTokenCache(signer, () => this.now()),
        issuer: identity.issuer,
        deployment: identity.deployment,
      };
    }
    void this.identityState?.development?.stop();
    this.identityState = state;
    return state;
  }

  private signerAuth(mode: "credential" | "device_key"): PactSignerAuth | null {
    let secret;
    try {
      secret = this.deps.secrets.getSigner();
    } catch {
      return null;
    }
    if (mode === "credential") {
      const identity = this.settings().identity;
      // The credential is only ever sent to the signer it was entered for.
      if (
        !secret?.credential ||
        secret.credentialSignerUrl !== identity.signerUrl ||
        secret.credentialIssuer !== identity.issuer
      ) {
        return null;
      }
      return { mode: "credential", credential: secret.credential };
    }
    if (!secret?.deviceKey) return null;
    const keyPair: Es256KeyPair = {
      privateKey: privateKeyFromJwk(secret.deviceKey.privateJwk),
      publicJwk: secret.deviceKey.publicJwk as unknown as Es256KeyPair["publicJwk"],
    };
    return { mode: "device_key", keyPair };
  }

  /** Generate (once) the install's device key for account-free enrollment; returns the public JWK. */
  ensureDeviceKey(): Es256KeyPair["publicJwk"] {
    const existing = this.deps.secrets.getSigner();
    if (existing?.deviceKey)
      return existing.deviceKey.publicJwk as unknown as Es256KeyPair["publicJwk"];
    const pair = generateEs256KeyPair();
    const privateJwk = pair.privateKey.export({ format: "jwk" }) as Record<string, string>;
    this.deps.secrets.putSigner({
      ...existing,
      deviceKey: {
        privateJwk: { ...privateJwk, kid: pair.publicJwk.kid },
        publicJwk: { ...pair.publicJwk } as unknown as Record<string, string>,
      },
    });
    this.identityState = null;
    return pair.publicJwk;
  }

  setSignerCredential(credential: string | null): void {
    const existing = this.deps.secrets.getSigner();
    const next = { ...existing };
    const identity = this.settings().identity;
    if (credential) {
      next.credential = credential;
      next.credentialSignerUrl = identity.signerUrl;
      next.credentialIssuer = identity.issuer;
    } else {
      delete next.credential;
      delete next.credentialSignerUrl;
      delete next.credentialIssuer;
    }
    this.deps.secrets.putSigner(next.credential || next.deviceKey ? next : undefined);
    this.identityState = null;
  }

  private async resolveIdentity(
    principal: PactPrincipal,
    networkContext: NetworkPolicyContext,
  ): Promise<ResolvedIdentity> {
    await this.ownerPrincipal();
    const identity = this.identity();
    if (!identity)
      throw blocked("identity_not_ready", "PACT identity is not configured in Settings.");
    if (identity.development && !identity.issuer) {
      identity.issuer = await identity.development.start();
    }
    const status = await this.signerStatus(identity, networkContext);
    if (!status.ok) {
      throw blocked(
        status.disabled ? "identity_disabled" : "identity_not_ready",
        status.disabled ? "The PACT signer is disabled." : "The PACT signer is not reachable.",
      );
    }
    const subject = status.subject;
    if (!subject) throw blocked("identity_not_ready", "The PACT signer did not report a subject.");
    const { binding, subjectChanged } = await this.repo.ensureSubjectBinding({
      principalId: principal.id,
      deployment: identity.deployment,
      issuer: identity.issuer,
      subject,
    });
    if (subjectChanged) identity.tokens.invalidate();
    return { identity, binding, status };
  }

  /** Signer status is cached briefly: every send needs it, and it is a network call. */
  private async signerStatus(
    identity: IdentityState,
    networkContext: NetworkPolicyContext,
    refresh = false,
  ): Promise<PactSignerStatus> {
    const cached = this.signerStatusCache;
    if (
      !refresh &&
      cached &&
      cached.fingerprint === identity.fingerprint &&
      cached.contextKey === JSON.stringify(networkContext) &&
      this.now() - cached.at < SIGNER_STATUS_TTL_MS &&
      cached.status.ok
    ) {
      return cached.status;
    }
    const status = await identity.tokens.status(networkContext);
    this.signerStatusCache = {
      fingerprint: identity.fingerprint,
      contextKey: JSON.stringify(networkContext),
      at: this.now(),
      status,
    };
    return status;
  }

  private async currentSignerStatus(
    networkContext: NetworkPolicyContext,
  ): Promise<PactSignerStatus | null> {
    await this.ownerPrincipal();
    const identity = this.identity();
    if (!identity) return null;
    try {
      if (identity.development && !identity.issuer)
        identity.issuer = await identity.development.start();
      return await this.signerStatus(identity, networkContext);
    } catch {
      return null;
    }
  }

  /** Rules for signer calls made outside any task or workspace (status in Settings, CLI). */
  private async defaultNetworkContext(): Promise<NetworkPolicyContext> {
    return (await this.deps.host.networkContextForWorkspace(null)) ?? { networkEnabled: false };
  }

  private async providerContext(
    signerStatus: PactSignerStatus | null,
  ): Promise<PactProviderContext> {
    return {
      settings: this.settings(),
      policies: this.deps.policies(),
      signerStatus,
      issuer: this.identity()?.issuer || null,
    };
  }

  private async credentialsFor(
    identity: IdentityState,
    provider: PactProviderRecord,
    binding: PactSubjectBindingRecord,
    networkContext: NetworkPolicyContext,
  ): Promise<PactClientCredentials> {
    if (!provider.audience)
      throw blocked("provider_not_ready", "The provider has no audience configured.");
    let token;
    try {
      token = await identity.tokens.token(provider.audience, networkContext);
    } catch (error) {
      if (error instanceof PactSignerError) {
        throw blocked(
          error.code === "disabled" ? "identity_disabled" : "identity_not_ready",
          error.message,
        );
      }
      throw error;
    }
    if (token.subject !== binding.subject) {
      identity.tokens.invalidate();
      throw blocked("identity_changed", "The PACT signer returned a different subject.");
    }
    return { paJwt: token.token, clientId: identity.issuer };
  }

  // --------------------------------------------------------------------- status

  async status(principal: PactPrincipal): Promise<PactStatusView> {
    await this.ownerPrincipal();
    const settings = this.settings();
    const availability = this.availability();
    let identityReady = false;
    let identityReason: string | undefined;
    let signerStatus: PactSignerStatus | null = null;
    const identity = this.identity();
    if (identity) {
      try {
        if (identity.development && !identity.issuer)
          identity.issuer = await identity.development.start();
        signerStatus = await this.signerStatus(identity, await this.defaultNetworkContext(), true);
        identityReady = signerStatus.ok;
        identityReason = signerStatus.reason;
      } catch (error) {
        identityReason = redactPactError(error);
      }
    } else {
      identityReason =
        settings.identity.deployment === "none"
          ? "Identity is not configured"
          : "Identity configuration is incomplete";
    }
    const context = await this.providerContext(signerStatus);
    const origins = new Set<string>([
      ...settings.providers.map((provider) => provider.origin),
      ...Object.keys(signerStatus?.audiences ?? {}),
    ]);
    const providers = [];
    for (const origin of origins) {
      try {
        const record = await this.providers.resolve(origin, context);
        providers.push({
          origin: record.origin,
          ...(record.audience ? { audience: record.audience } : {}),
          ready: record.readiness === "ready",
          ...(record.readinessReason ? { reason: record.readinessReason } : {}),
        });
      } catch {
        providers.push({ origin, ready: false, reason: "invalid_origin" });
      }
    }
    const [counts, metrics] = await Promise.all([
      this.repo.counts(principal.id),
      this.repo.metrics(principal.id),
    ]);
    return {
      available: availability.available,
      ...(availability.reason ? { unavailableReason: availability.reason } : {}),
      preference: effectivePactPreference(settings),
      autoRoute: this.deps.policies().pact.autoRoute,
      identity: {
        deployment: settings.identity.deployment,
        ...(identity?.issuer ? { issuer: identity.issuer } : {}),
        ready: identityReady,
        ...(identityReason ? { reason: identityReason } : {}),
      },
      providers,
      ...counts,
      metrics,
    };
  }

  // ------------------------------------------------------------------ discovery

  async discover(
    principal: PactPrincipal,
    input: { domain?: string; cardUrl?: string; refresh?: boolean },
    ctx: PactCallContext,
  ): Promise<{ business: PactBusinessView; route: PactRouteDecision }> {
    void principal;
    const availability = this.availability();
    if (!availability.available && availability.reason !== "identity_not_configured") {
      throw blocked("pact_disabled", "PACT is turned off for this profile.");
    }
    const signerStatus = await this.currentSignerStatus(ctx.networkContext);
    const result = await this.discovery.discover({
      ...input,
      ...(input.refresh ? { forceRefresh: true } : {}),
      transport: this.deps.transportFor(ctx.networkContext, ctx.taskId),
      rules: this.rules(),
      providerContext: await this.providerContext(signerStatus),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.securityChanged) await this.onBusinessSecurityChanged(result.business);
    const route = resolveBusinessRoute({
      preference: effectivePactPreference(this.settings()),
      availability,
      support: result.support.status === "supported" ? "supported" : "unsupported",
      identityReady: Boolean(signerStatus?.ok),
      providerReady: result.provider.readiness === "ready",
    });
    this.emit(ctx, "pact_business_discovered", {
      businessId: result.business.id,
      displayName: result.business.displayName,
      originChain: result.business.originChain,
      providerOrigin: result.provider.origin,
      supported: result.support.status === "supported",
      route: route.route,
    });
    return { business: toBusinessView(result.business, result.provider), route };
  }

  /**
   * Any change to what the card says about where credentials go (interface, endpoints, metadata,
   * keys, scopes) ends every stored permission for that business: no credential transfer.
   */
  private async onBusinessSecurityChanged(business: PactBusinessRecord): Promise<void> {
    const grants = await this.repo.listGrants({ businessId: business.id, states: ["active"] });
    for (const grant of grants) await this.grants.invalidate(grant.id, "business_card_changed");
  }

  private async loadBusiness(
    businessId: string,
    ctx: PactCallContext,
    signerStatus: PactSignerStatus | null,
  ) {
    const business = await this.repo.getBusiness(businessId);
    if (!business) throw blocked("unknown_business", "Unknown business handle; discover it first.");
    if (business.supportStatus !== "supported") {
      throw new PactBlocked({
        status: "unsupported",
        reason: business.unsupportedReason ?? "unsupported",
        message: "This business is not a supported PACT agent.",
      });
    }
    const revalidated = await this.discovery.revalidate(business, {
      transport: this.deps.transportFor(ctx.networkContext, ctx.taskId),
      rules: this.rules(),
      providerContext: await this.providerContext(signerStatus),
    });
    if (revalidated.securityChanged) await this.onBusinessSecurityChanged(revalidated.business);
    if (revalidated.support.status !== "supported") {
      throw new PactBlocked({
        status: "unsupported",
        reason: "card_changed",
        message: "The business's card no longer advertises a supported PACT agent.",
      });
    }
    return revalidated;
  }

  // ----------------------------------------------------------------------- send

  async send(
    principal: PactPrincipal,
    request: PactSendRequest,
    ctx: PactCallContext,
  ): Promise<PactSendOutcome> {
    try {
      return await this.sendInner(principal, request, ctx, { stepUps: 0, contextRestarts: 0 });
    } catch (error) {
      if (error instanceof PactBlocked) {
        this.emit(ctx, "pact_operation_blocked", {
          reason: error.outcome.reason,
          message: error.outcome.message,
        });
        return error.outcome;
      }
      if (error instanceof PactProviderBlockedError) {
        return { status: "blocked", reason: "provider_blocked", message: error.message };
      }
      if (error instanceof PactDiscoveryError) {
        return {
          status: "blocked",
          reason: `discovery_${error.code}`,
          message: redactPactError(error),
        };
      }
      throw error;
    }
  }

  private async sendInner(
    principal: PactPrincipal,
    request: PactSendRequest,
    ctx: PactCallContext,
    loop: {
      stepUps: number;
      contextRestarts: number;
      lastMissing?: string;
      grantJustObtained?: boolean;
    },
  ): Promise<PactSendOutcome> {
    const availability = this.availability();
    if (!availability.available) {
      throw blocked(
        availability.reason ?? "pact_disabled",
        "PACT is not available for this profile.",
      );
    }
    if (effectivePactPreference(this.settings()) === "disabled") {
      throw blocked("pact_disabled", "PACT is turned off for business interactions.");
    }
    const { identity, binding, status } = await this.resolveIdentity(principal, ctx.networkContext);
    const { business, provider: resolvedProvider } = await this.loadBusiness(
      request.businessId,
      ctx,
      status,
    );
    const provider = await this.providers.requireReady(
      new URL(business.interfaceUrl).origin,
      await this.providerContext(status),
    );
    if (provider.readiness !== "ready") {
      throw blocked(
        "provider_not_ready",
        "CoWork is not registered with this business's PACT provider yet.",
      );
    }
    void resolvedProvider;

    // A reconcile targets the conversation that holds the operation.
    if (request.reconcileOperationId && !request.conversationId) {
      const operation = await this.repo.findOperation(request.reconcileOperationId);
      if (operation) request = { ...request, conversationId: operation.conversationId };
    }
    // Conversation for this principal, subject and business only.
    let conversation: PactConversationRecord | null = null;
    if (request.conversationId) {
      conversation = await this.repo.getConversation(request.conversationId);
      if (
        !conversation ||
        conversation.principalId !== principal.id ||
        conversation.businessId !== business.id
      ) {
        throw blocked("unknown_conversation", "Unknown conversation handle.");
      }
      if (conversation.subjectBindingId !== binding.id) {
        throw blocked(
          "conversation_other_identity",
          "That conversation belongs to a different PACT identity.",
        );
      }
      if (["closed", "unsupported", "cancelled"].includes(conversation.state)) {
        conversation = null;
      }
    }
    conversation ??= await this.repo.findUsableConversation({
      principalId: principal.id,
      subjectBindingId: binding.id,
      businessId: business.id,
    });
    conversation ??= await this.repo.createConversation({
      principalId: principal.id,
      subjectBindingId: binding.id,
      businessId: business.id,
      taskId: ctx.taskId ?? null,
      sessionId: ctx.sessionId ?? null,
      workspaceId: ctx.workspaceId ?? null,
      state: "ready",
    });

    if (request.reconcileOperationId) {
      return this.reconcile(principal, request, ctx, {
        identity,
        binding,
        business,
        provider,
        conversation,
      });
    }

    const delegation = business.descriptor.delegation;
    const requiredScopes = union(request.requiredScopes);
    if (requiredScopes.length > 0 && (!delegation || business.profile !== "delegated")) {
      throw blocked("unknown_scope", "This business does not offer account permissions.");
    }
    const grantKey: GrantKey | null = delegation
      ? {
          principalId: principal.id,
          subjectBindingId: binding.id,
          businessId: business.id,
          interfaceUrl: business.interfaceUrl,
          authorizationServer: delegation.authorizationServer ?? "",
        }
      : null;
    let grant: PactGrantRecord | null =
      grantKey && requiredScopes.length > 0
        ? await this.grants.findCoveringGrant(grantKey, requiredScopes)
        : null;

    if (conversation.state === "evidence_invalid" && request.effect !== "inspect") {
      throw blocked(
        "evidence_review_required",
        "The last reply from this business carried evidence that needs review before more changes are sent.",
        conversation.id,
      );
    }

    // Decision 1 and 3: local authority over this exact operation.
    const admission = admitPactOperation({
      principal,
      origin: ctx.origin,
      localAuthority: ctx.localAuthority,
      business,
      text: request.text,
      declaredEffect: request.effect,
      requiredScopes,
      tokenScopes: grant?.scopes ?? [],
    });
    if (admission.decision === "deny")
      throw blocked(admission.reason, admission.message, conversation.id);
    this.emit(ctx, "pact_operation_admitted", {
      businessId: business.id,
      conversationId: conversation.id,
      effectClass: admission.effectClass,
      requiredScopes,
      approvalRequired: admission.approvalRequired,
    });
    if (admission.approvalRequired && !ctx.preApproved) {
      const approved = await this.requireLocalApproval(ctx, {
        business,
        provider,
        conversationId: conversation.id,
        effectClass: admission.effectClass,
        scopes: requiredScopes,
        text: request.text,
        reasons: admission.approvalReasons,
      });
      if (!approved) {
        return {
          status: "denied",
          conversationId: conversation.id,
          reason: "local_approval_denied",
          message: "The request was not approved.",
        };
      }
    }

    // Decision 2: business consent for the scopes this operation needs.
    if (grantKey && requiredScopes.length > 0 && !grant) {
      const consent = await this.obtainConsent(principal, ctx, {
        identity,
        binding,
        business,
        provider,
        conversation,
        grantKey,
        scopes: union(await this.grants.effectiveScopes(grantKey), requiredScopes),
        mustInclude: requiredScopes,
        purpose: request.purpose ?? request.text,
        operationId: request.reconcileOperationId ?? null,
      });
      if (consent.status !== "granted") return consent.outcome;
      grant = consent.grant;
      loop.grantJustObtained = true;
    }

    // Effectful operations go only into a known context: open it with an introduction.
    if (!conversation.contextId && admission.effectClass !== "inspect") {
      conversation = await this.openContext(principal, ctx, {
        identity,
        binding,
        business,
        provider,
        conversation,
      });
    }

    const operationId = randomUUID();
    const fingerprint = authorityFingerprint({
      principalId: principal.id,
      subjectBindingId: binding.id,
      subjectRevision: binding.revision,
      businessId: business.id,
      businessRevision: business.revision,
      providerRevision: provider.configRevision,
      effectClass: admission.effectClass,
      requiredScopes,
      grantId: grant?.id ?? null,
    });
    const transport = this.deps.transportFor(ctx.networkContext, ctx.taskId);
    const credentials = () => this.credentialsFor(identity, provider, binding, ctx.networkContext);
    const usedGrant = grant;
    const turn = await this.conversations
      .sendTurn({
        conversation,
        operationId,
        kind: "operation",
        text: request.text.trim(),
        effectClass: admission.effectClass,
        requiredScopes,
        authorityFingerprint: fingerprint,
        cardRevision: business.revision,
        providerRevision: provider.configRevision,
        grantId: usedGrant?.id ?? null,
        interfaceUrl: business.interfaceUrl,
        transport,
        paJwt: async () => (await credentials()).paJwt,
        delegationToken: async () =>
          usedGrant
            ? this.grants.accessToken(usedGrant, async (refreshToken) =>
                refreshDelegationToken(transport, {
                  url: delegation!.refreshUrl,
                  refreshToken,
                  credentials: await credentials(),
                  now: () => this.now(),
                }),
              )
            : undefined,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof PactGrantUnavailableError) {
          throw blocked("reconnect_required", error.message, conversation!.id);
        }
        throw error;
      });
    this.emit(ctx, "pact_message_sent", {
      conversationId: conversation.id,
      operationId,
      effectClass: admission.effectClass,
      outcome: turn.kind,
    });
    return this.handleTurn(principal, request, ctx, loop, {
      turn,
      identity,
      binding,
      business,
      provider,
      conversation,
      grant: usedGrant,
      grantKey,
      requiredScopes,
    });
  }

  /**
   * The local gate for one operation. On a task it is an explicit approval card for exactly this
   * business, effect and full message text: never satisfied by a remembered rule, a recurring
   * approval or a permission mode. Elsewhere the surface must have confirmed it (preApproved).
   */
  private async requireLocalApproval(
    ctx: PactCallContext,
    input: {
      business: PactBusinessRecord;
      provider: PactProviderRecord;
      conversationId: string;
      effectClass: PactEffectClass;
      scopes: string[];
      text: string;
      reasons: string[];
    },
  ): Promise<boolean> {
    if (!ctx.taskId) {
      throw blocked(
        "local_approval_required",
        "Confirm this request before it is sent to the business.",
        input.conversationId,
      );
    }
    if (ctx.humanInput === "none") {
      this.deps.host.logInteractiveApprovalUnavailable(
        ctx.taskId,
        `Sending a ${input.effectClass} request to a business needs approval, but this task cannot ask.`,
      );
      throw blocked(
        "interactive_approval_unavailable",
        "This task cannot ask for the approval this request needs.",
        input.conversationId,
      );
    }
    const scopeDescriptions = new Map(
      (input.business.descriptor.delegation?.scopes ?? []).map((scope) => [
        scope.id,
        scope.description,
      ]),
    );
    const permissions = input.scopes.map((id) => {
      const description = scopeDescriptions.get(id);
      return description ? `${description} (${id})` : id;
    });
    return this.deps.host.requestLocalApproval(
      ctx.taskId,
      `Send a ${input.effectClass === "change" ? "change" : "request"} to ${input.business.displayName}.`,
      {
        // Shown in full with the approval question: the user approves this exact text.
        approvalReviewText: `Message: “${input.text.trim()}”${
          permissions.length > 0 ? ` Permissions: ${permissions.join("; ")}.` : ""
        }`,
        tool: "pact_send_message",
        params: {
          business: input.business.displayName,
          effect: input.effectClass,
          scopes: input.scopes,
          // The full text: what is approved is exactly what is sent.
          message: input.text,
        },
        // Runtime-supplied destination for PermissionEngine domain rules (plan §7).
        permissionInput: {
          url: input.business.interfaceUrl,
          effect: input.effectClass,
          bodyDigest: bodyDigest(input.text.trim()),
        },
        pactDestination: {
          interfaceUrl: input.business.interfaceUrl,
          originChain: input.business.originChain,
          providerOrigin: input.provider.origin,
        },
        effectClass: input.effectClass,
        approvalReasons: input.reasons,
      },
      { requireExplicit: true },
    );
  }

  private async handleTurn(
    principal: PactPrincipal,
    request: PactSendRequest,
    ctx: PactCallContext,
    loop: {
      stepUps: number;
      contextRestarts: number;
      lastMissing?: string;
      grantJustObtained?: boolean;
    },
    state: {
      turn: PactTurnResult;
      identity: IdentityState;
      binding: PactSubjectBindingRecord;
      business: PactBusinessRecord;
      provider: PactProviderRecord;
      conversation: PactConversationRecord;
      grant: PactGrantRecord | null;
      grantKey: GrantKey | null;
      requiredScopes: string[];
    },
  ): Promise<PactSendOutcome> {
    const { turn, business, conversation } = state;
    switch (turn.kind) {
      case "replied": {
        if (state.grant) await this.grants.touch(state.grant.id);
        const evidence = await this.recordEvidence(ctx, state, turn);
        return {
          status: "replied",
          conversationId: conversation.id,
          turnId: turn.message.id,
          replyText: turn.replyText,
          evidence: evidence.status,
          ...(evidence.receiptId ? { receiptId: evidence.receiptId } : {}),
          ...(state.grant ? { grantedScopes: state.grant.scopes } : {}),
        };
      }
      case "auth_required": {
        const advertised = new Set(
          (business.descriptor.delegation?.scopes ?? []).map((scope) => scope.id),
        );
        const missing = union(turn.missingScopes);
        if (!state.grantKey || missing.some((scope) => !advertised.has(scope))) {
          throw blocked(
            "step_up_unsupported",
            "The business asked for permissions it does not advertise.",
            conversation.id,
          );
        }
        const missingKey = missing.join(" ");
        if (
          loop.stepUps >= MAX_STEP_UPS ||
          (loop.grantJustObtained && loop.lastMissing === missingKey)
        ) {
          return {
            status: "denied",
            conversationId: conversation.id,
            reason: "insufficient_permission",
            message:
              "The business still needs permissions after sign-in; the operation was stopped.",
          };
        }
        this.emit(ctx, "pact_step_up_required", {
          conversationId: conversation.id,
          missingScopes: missing,
        });
        // Resend the same logical operation after consent; re-admission runs with the wider scopes.
        return this.sendInner(
          principal,
          {
            ...request,
            conversationId: conversation.id,
            requiredScopes: union(state.requiredScopes, missing),
          },
          ctx,
          { ...loop, stepUps: loop.stepUps + 1, lastMissing: missingKey, grantJustObtained: false },
        );
      }
      case "outcome_unknown":
        this.emit(ctx, "pact_outcome_unknown", {
          conversationId: conversation.id,
          operationId: turn.message.operationId,
          reason: turn.reason,
        });
        return {
          status: "outcome_unknown",
          conversationId: conversation.id,
          reason: turn.reason,
          message: `The request reached ${business.displayName} but CoWork did not get a reply, so the outcome is unknown. Do not resend it another way. Reconcile operation ${turn.message.operationId} when possible.`,
        };
      case "failed":
        switch (turn.reason) {
          case "delegation_rejected":
            if (state.grant) await this.grants.invalidate(state.grant.id, "delegation_rejected");
            throw blocked(
              "reconnect_required",
              `${business.displayName} no longer accepts the stored permission. Reconnect to continue.`,
              conversation.id,
            );
          case "identity_rejected":
            state.identity.tokens.invalidate();
            throw blocked(
              "identity_rejected",
              `${business.displayName} did not accept CoWork's identity.`,
              conversation.id,
            );
          case "context_closed":
            if (loop.contextRestarts >= 1) {
              throw blocked(
                "context_closed",
                "The business keeps closing the conversation.",
                conversation.id,
              );
            }
            // A closed context with no unresolved operation may start over; authority is rechecked.
            return this.sendInner(principal, { ...request, conversationId: undefined }, ctx, {
              ...loop,
              contextRestarts: loop.contextRestarts + 1,
            });
          default:
            throw blocked(turn.reason, turn.detail, conversation.id);
        }
    }
  }

  private async recordEvidence(
    ctx: PactCallContext,
    state: {
      identity: IdentityState;
      business: PactBusinessRecord;
      conversation: PactConversationRecord;
      grant: PactGrantRecord | null;
    },
    turn: Extract<PactTurnResult, { kind: "replied" }>,
  ): Promise<{ status: PactEvidenceStatus; receiptId?: string }> {
    const { business, conversation, grant } = state;
    if (!grant) {
      // Identity-profile replies carry no receipt, and that is expected.
      if (turn.receipt) {
        this.emit(ctx, "pact_evidence_issue", {
          conversationId: conversation.id,
          issue: "unexpected_receipt",
        });
      }
      await this.repo.updateConversation(conversation.id, { state: "replied" });
      return { status: "not_applicable" };
    }
    if (!turn.receipt) {
      await this.repo.updateMessage(turn.message.id, { evidence: "missing" });
      await this.repo.updateConversation(conversation.id, {
        state: "evidence_invalid",
        stateReason: "missing_receipt",
      });
      this.emit(ctx, "pact_evidence_issue", {
        conversationId: conversation.id,
        issue: "missing_receipt",
      });
      return { status: "missing" };
    }
    const claims = this.grants.grantClaims(grant);
    const jwksUri = business.descriptor.delegation?.jwksUri;
    const verification = jwksUri
      ? await verifyPactReceipt(
          turn.receipt,
          {
            jwksUri,
            grantId: claims.remoteGrantId,
            user: claims.brandUserId,
            pa: state.identity.issuer,
            brand: business.interfaceUrl,
            grantScopes: grant.scopes,
            sentAt: turn.sentAt,
            receivedAt: turn.receivedAt,
          },
          this.jwks,
          this.deps.transportFor(ctx.networkContext, ctx.taskId),
        )
      : { status: "unverifiable" as const, reason: "no_jwks_uri", digest: "" };
    const receiptRef = randomUUID();
    this.deps.secrets.putReceipt(receiptRef, {
      jws: turn.receipt.jws,
      claims: turn.receipt.claims,
    });
    const { receipt } = await this.repo.insertReceipt({
      messageId: turn.message.id,
      conversationId: conversation.id,
      contextId: conversation.contextId,
      jwsDigest: verification.digest || receiptRef,
      secretRef: receiptRef,
      verificationState: verification.status,
      verificationReason:
        "issues" in verification ? verification.issues.join(";") || null : verification.reason,
      grantIdClaim: turn.receipt.claims.grantId,
      paClaim: turn.receipt.claims.pa,
      brandClaim: turn.receipt.claims.brand,
      scopesUsed: turn.receipt.claims.scopesUsed,
      actions: turn.receipt.claims.actions.map((action) => ({
        tool: action.tool.slice(0, 120),
        ...(action.argsHash ? { argsHash: action.argsHash.slice(0, 200) } : {}),
      })),
      receiptTs: turn.receipt.claims.ts,
    });
    const status = receipt.verificationState;
    await this.repo.updateMessage(turn.message.id, { evidence: status, receiptId: receipt.id });
    if (status === "verified") {
      await this.repo.updateConversation(conversation.id, {
        state: "evidence_verified",
        stateReason: null,
        ...(grant.accountBinding ? { accountBinding: grant.accountBinding } : {}),
      });
    } else {
      await this.repo.updateConversation(conversation.id, {
        state: "evidence_invalid",
        stateReason: receipt.verificationReason ?? status,
      });
    }
    this.emit(ctx, status === "verified" ? "pact_receipt_verified" : "pact_evidence_issue", {
      conversationId: conversation.id,
      receiptId: receipt.id,
      verification: status,
      reason: receipt.verificationReason,
      scopesUsed: receipt.scopesUsed,
      actions: receipt.actions.map((action) => action.tool),
    });
    return { status, receiptId: receipt.id };
  }

  private async openContext(
    principal: PactPrincipal,
    ctx: PactCallContext,
    state: {
      identity: IdentityState;
      binding: PactSubjectBindingRecord;
      business: PactBusinessRecord;
      provider: PactProviderRecord;
      conversation: PactConversationRecord;
    },
  ): Promise<PactConversationRecord> {
    let conversation = state.conversation;
    const transport = this.deps.transportFor(ctx.networkContext, ctx.taskId);
    for (let attempt = conversation.contextAttempts; attempt < MAX_CONTEXT_ATTEMPTS; attempt += 1) {
      const turn = await this.conversations.sendTurn({
        conversation,
        operationId: randomUUID(),
        kind: "introduction",
        text: PACT_INTRODUCTION_TEXT,
        effectClass: "inspect",
        requiredScopes: [],
        authorityFingerprint: "introduction",
        cardRevision: state.business.revision,
        providerRevision: state.provider.configRevision,
        grantId: null,
        interfaceUrl: state.business.interfaceUrl,
        transport,
        paJwt: async () =>
          (
            await this.credentialsFor(
              state.identity,
              state.provider,
              state.binding,
              ctx.networkContext,
            )
          ).paJwt,
        delegationToken: async () => undefined,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (turn.kind === "replied" && conversation.contextId) return conversation;
      const refreshed = await this.repo.getConversation(conversation.id);
      if (turn.kind === "replied" && refreshed?.contextId) return refreshed;
      if (
        turn.kind === "failed" &&
        !["conversation_busy"].includes(turn.reason) &&
        turn.reason !== "context_closed"
      ) {
        throw blocked(turn.reason, turn.detail, conversation.id);
      }
      // A lost introduction leaves an unknown context behind; start a fresh one, rate-limited.
      await this.repo.updateConversation(conversation.id, {
        state: "closed",
        stateReason: "introduction_lost",
        contextAttempts: attempt + 1,
      });
      conversation = await this.repo.createConversation({
        principalId: principal.id,
        subjectBindingId: state.binding.id,
        businessId: state.business.id,
        taskId: ctx.taskId ?? null,
        sessionId: ctx.sessionId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        state: "ready",
      });
      await this.repo.updateConversation(conversation.id, { contextAttempts: attempt + 1 });
      conversation.contextAttempts = attempt + 1;
    }
    throw blocked(
      "context_limit",
      "CoWork could not open a conversation with this business.",
      conversation.id,
    );
  }

  private async reconcile(
    principal: PactPrincipal,
    request: PactSendRequest,
    ctx: PactCallContext,
    state: {
      identity: IdentityState;
      binding: PactSubjectBindingRecord;
      business: PactBusinessRecord;
      provider: PactProviderRecord;
      conversation: PactConversationRecord;
    },
  ): Promise<PactSendOutcome> {
    const messages = await this.repo.listMessages(state.conversation.id);
    const target = messages
      .filter((message) => message.operationId === request.reconcileOperationId)
      .sort((left, right) => right.seq - left.seq)[0];
    if (!target || target.state !== "outcome_unknown") {
      throw blocked(
        "nothing_to_reconcile",
        "No unresolved operation with that id.",
        state.conversation.id,
      );
    }
    if (!state.conversation.contextId) {
      throw blocked(
        "reconcile_impossible",
        "The request was sent before a conversation existed, so the business cannot match a retry to it.",
        state.conversation.id,
      );
    }
    // A resend is the same operation under the same facts, re-admitted like a new one.
    if (ctx.origin !== "owner" && ctx.origin !== "owner_cli") {
      throw blocked(
        "delegation_required",
        "Only the profile owner's own tasks can talk to businesses through PACT.",
        state.conversation.id,
      );
    }
    if (
      target.cardRevision !== state.business.revision ||
      target.providerRevision !== state.provider.configRevision
    ) {
      throw blocked(
        "authority_changed",
        "The business or its provider changed since this request was sent, so it will not be resent.",
        state.conversation.id,
      );
    }
    const grant = target.grantId ? await this.repo.getGrant(target.grantId) : null;
    if (target.grantId && (!grant || grant.state !== "active")) {
      throw blocked(
        "reconnect_required",
        "The permission used for that request is no longer active.",
        state.conversation.id,
      );
    }
    if (target.effectClass !== "inspect" && !ctx.preApproved) {
      const approved = await this.requireLocalApproval(ctx, {
        business: state.business,
        provider: state.provider,
        conversationId: state.conversation.id,
        effectClass: target.effectClass,
        scopes: target.requiredScopes,
        text: target.bodyText,
        reasons: ["reconcile"],
      });
      if (!approved) {
        return {
          status: "denied",
          conversationId: state.conversation.id,
          reason: "local_approval_denied",
          message: "The resend was not approved.",
        };
      }
    }
    const delegation = state.business.descriptor.delegation;
    const transport = this.deps.transportFor(ctx.networkContext, ctx.taskId);
    const credentials = () =>
      this.credentialsFor(state.identity, state.provider, state.binding, ctx.networkContext);
    const turn = await this.conversations.sendTurn({
      conversation: state.conversation,
      operationId: target.operationId,
      kind: "operation",
      text: target.bodyText,
      effectClass: target.effectClass,
      requiredScopes: target.requiredScopes,
      authorityFingerprint: target.authorityFingerprint,
      cardRevision: target.cardRevision,
      providerRevision: target.providerRevision,
      grantId: target.grantId,
      interfaceUrl: state.business.interfaceUrl,
      transport,
      paJwt: async () => (await credentials()).paJwt,
      delegationToken: async () =>
        grant && delegation
          ? this.grants.accessToken(grant, async (refreshToken) =>
              refreshDelegationToken(transport, {
                url: delegation.refreshUrl,
                refreshToken,
                credentials: await credentials(),
                now: () => this.now(),
              }),
            )
          : undefined,
      reuse: target,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    this.emit(ctx, "pact_operation_reconciled", {
      conversationId: state.conversation.id,
      operationId: target.operationId,
      outcome: turn.kind,
    });
    return this.handleTurn(
      principal,
      request,
      ctx,
      { stepUps: MAX_STEP_UPS, contextRestarts: 1 },
      {
        turn,
        ...state,
        grant,
        grantKey: null,
        requiredScopes: target.requiredScopes,
      },
    );
  }

  // ------------------------------------------------------------------- consent

  private async obtainConsent(
    principal: PactPrincipal,
    ctx: PactCallContext,
    state: {
      identity: IdentityState;
      binding: PactSubjectBindingRecord;
      business: PactBusinessRecord;
      provider: PactProviderRecord;
      conversation: PactConversationRecord | null;
      grantKey: GrantKey;
      scopes: string[];
      mustInclude: string[];
      purpose: string;
      operationId: string | null;
    },
  ): Promise<
    { status: "granted"; grant: PactGrantRecord } | { status: "other"; outcome: PactSendOutcome }
  > {
    const { business } = state;
    if (ctx.humanInput === "none") {
      if (ctx.taskId) {
        this.deps.host.logInteractiveApprovalUnavailable(
          ctx.taskId,
          `${business.displayName} needs the user to sign in and approve access, but this task cannot ask.`,
        );
      }
      throw blocked(
        "interactive_approval_unavailable",
        `${business.displayName} needs the user to sign in and approve access, and this task cannot ask.`,
        state.conversation?.id,
      );
    }
    const credentials = await this.credentialsFor(
      state.identity,
      state.provider,
      state.binding,
      ctx.networkContext,
    );
    let started;
    try {
      started = await this.authorizations.start({
        business,
        scopes: state.scopes,
        principalId: principal.id,
        subjectBindingId: state.binding.id,
        taskId: ctx.taskId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        conversationId: state.conversation?.id ?? null,
        operationId: state.operationId,
        purpose: state.purpose,
        transport: this.deps.transportFor(ctx.networkContext, ctx.taskId),
        credentials,
        rules: this.rules(),
      });
    } catch (error) {
      if (error instanceof PactAuthorizationError) {
        throw blocked(`consent_${error.code}`, error.message, state.conversation?.id);
      }
      throw error;
    }
    let record = started.record;
    if (state.conversation) {
      await this.repo.updateConversation(state.conversation.id, {
        state: "awaiting_business_consent",
      });
    }
    if (ctx.taskId) {
      const inputRequestId = await this.deps.host.openAuthorizationWait(
        ctx.taskId,
        toAuthorizationView(record, business),
      );
      record = (await this.repo.linkAuthorizationInput(record.id, inputRequestId)) ?? record;
    }
    this.emit(ctx, "pact_authorization_requested", {
      authorizationId: record.id,
      inputRequestId: record.inputRequestId,
      businessId: business.id,
      businessName: business.displayName,
      scopes: scopeViews(business, record.requestedScopes),
      verificationOrigin: started.verificationOrigin,
      expiresAt: record.expiresAt,
    });
    const poller = this.startPoller(
      record,
      business,
      state.provider,
      state.binding,
      state.identity,
      ctx.networkContext,
    );
    if (!ctx.waitForConsent) {
      return {
        status: "other",
        outcome: {
          status: "needs_user_action",
          conversationId: state.conversation?.id ?? "",
          authorizationId: record.id,
          ...(record.inputRequestId ? { inputRequestId: record.inputRequestId } : {}),
          scopes: scopeViews(business, record.requestedScopes),
          message: `Sign in with ${business.displayName} and approve access to continue.`,
        },
      };
    }
    const onAbort = () => poller.abort.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const outcome = await poller.promise.finally(() =>
      ctx.signal?.removeEventListener("abort", onAbort),
    );
    if (outcome.kind === "granted" && outcome.grantId) {
      const grant = await this.repo.getGrant(outcome.grantId);
      const covered = grant && state.mustInclude.every((scope) => grant.scopes.includes(scope));
      if (grant && covered) return { status: "granted", grant };
      return {
        status: "other",
        outcome: {
          status: "denied",
          ...(state.conversation ? { conversationId: state.conversation.id } : {}),
          reason: "insufficient_permission",
          message: `Access to ${business.displayName} was approved without every permission this request needs.`,
        },
      };
    }
    return {
      status: "other",
      outcome: this.consentOutcome(outcome, business, state.conversation?.id),
    };
  }

  private consentOutcome(
    outcome: PactAuthorizationOutcome,
    business: PactBusinessRecord,
    conversationId?: string,
  ): PactSendOutcome {
    const base = conversationId ? { conversationId } : {};
    switch (outcome.kind) {
      case "denied":
        return {
          status: "denied",
          ...base,
          reason: "consent_denied",
          message: `The user declined access at ${business.displayName}.`,
        };
      case "expired":
        return {
          status: "expired",
          ...base,
          reason: "consent_expired",
          message: `The sign-in with ${business.displayName} expired.`,
        };
      case "cancelled":
        return {
          status: "cancelled",
          ...base,
          reason: "consent_cancelled",
          message: "The sign-in was cancelled.",
        };
      case "lease_lost":
        return {
          status: "blocked",
          ...base,
          reason: "consent_elsewhere",
          message: "Another CoWork window is handling this sign-in.",
        };
      case "failed":
        return {
          status: "blocked",
          ...base,
          reason: outcome.reason,
          message: `The sign-in with ${business.displayName} failed.`,
        };
      default:
        return {
          status: "blocked",
          ...base,
          reason: "consent_unknown",
          message: "The sign-in did not complete.",
        };
    }
  }

  private startPoller(
    record: PactAuthorizationRecord,
    business: PactBusinessRecord,
    provider: PactProviderRecord,
    binding: PactSubjectBindingRecord,
    identity: IdentityState,
    networkContext: NetworkPolicyContext,
  ) {
    const existing = this.pollers.get(record.id);
    if (existing) return existing;
    const abort = new AbortController();
    const delegation = business.descriptor.delegation!;
    const promise = this.authorizations
      .waitForDecision({
        record,
        tokenUrl: delegation.tokenUrl,
        transport: () => this.deps.transportFor(networkContext, record.taskId ?? undefined),
        credentials: async () => {
          // A wait whose task was cancelled, finished or dismissed by any path stops polling.
          if (record.taskId && !(await this.deps.host.taskStillWaiting(record.taskId))) {
            throw new Error("task_not_waiting");
          }
          // Policy and provider readiness are rechecked on every poll.
          const current = await this.providers.requireReady(
            provider.origin,
            await this.providerContext(await this.currentSignerStatus(networkContext)),
          );
          return this.credentialsFor(identity, current, binding, networkContext);
        },
        signal: abort.signal,
      })
      .catch((error: unknown): PactAuthorizationOutcome => ({
        kind: "failed",
        reason: redactPactError(error),
      }))
      .then(async (polled): Promise<PactAuthorizationOutcome & { grantId?: string }> => {
        let outcome: PactAuthorizationOutcome = polled;
        if (outcome.kind === "lease_lost") return outcome;
        // Shutting down is not a user cancel: leave the wait pending so it resumes on restart.
        if (outcome.kind === "cancelled" && this.stopped) return outcome;
        let grantId: string | undefined;
        let grantedScopes: string[] | undefined;
        if (outcome.kind === "granted") {
          try {
            const grant = await this.grants.storeGrant(
              {
                principalId: record.principalId,
                subjectBindingId: binding.id,
                businessId: business.id,
                interfaceUrl: business.interfaceUrl,
                authorizationServer: delegation.authorizationServer ?? "",
              },
              outcome.token,
              { clientId: identity.issuer },
            );
            grantId = grant.id;
            grantedScopes = grant.scopes;
          } catch (error) {
            // A token for another business, client or scope set is refused, not stored.
            outcome = { kind: "failed", reason: `grant_refused: ${redactPactError(error)}` };
          }
        }
        const settled = await this.authorizations.settle(record, outcome, {
          ...(grantId ? { grantId } : {}),
          ...(grantedScopes ? { grantedScopes } : {}),
        });
        const latest = settled ?? (await this.repo.getAuthorization(record.id));
        const state: PactAuthorizationState =
          outcome.kind === "granted"
            ? "granted"
            : outcome.kind === "failed"
              ? "failed"
              : outcome.kind;
        if (latest?.inputRequestId && settled) {
          await this.deps.host
            .settleAuthorizationWait(latest.inputRequestId, state, this.authorizationMessage(state))
            .catch(() => undefined);
        }
        if (record.taskId) {
          this.emit({ taskId: record.taskId }, "pact_authorization_resolved", {
            authorizationId: record.id,
            inputRequestId: latest?.inputRequestId,
            businessId: business.id,
            state,
            grantedScopes: grantedScopes ? scopeViews(business, grantedScopes) : undefined,
          });
        }
        return { ...outcome, ...(grantId ? { grantId } : {}) };
      })
      .finally(() => this.pollers.delete(record.id));
    const entry = { promise, abort };
    this.pollers.set(record.id, entry);
    return entry;
  }

  /**
   * Fixed wording: this text can reach the task as a follow-up after a restart, so it carries no
   * business-controlled strings (names, scope ids).
   */
  private authorizationMessage(state: PactAuthorizationState): string {
    switch (state) {
      case "granted":
        return "The user approved access at the business. Retry the pending PACT request to continue.";
      case "denied":
        return "The user declined access at the business. Stop this operation.";
      case "expired":
        return "The business sign-in expired before it was approved.";
      case "cancelled":
        return "The business sign-in was cancelled.";
      default:
        return "The business sign-in failed.";
    }
  }

  /** Explicit connect from Settings or the CLI, outside a task. */
  async startAuthorization(
    principal: PactPrincipal,
    input: { businessId: string; scopes: string[]; purpose?: string },
    ctx: PactCallContext,
  ): Promise<PactAuthorizationView> {
    try {
      const availability = this.availability();
      if (!availability.available)
        throw blocked(availability.reason ?? "pact_disabled", "PACT is not available.");
      const { identity, binding, status } = await this.resolveIdentity(
        principal,
        ctx.networkContext,
      );
      const { business } = await this.loadBusiness(input.businessId, ctx, status);
      const provider = await this.providers.requireReady(
        new URL(business.interfaceUrl).origin,
        await this.providerContext(status),
      );
      if (provider.readiness !== "ready")
        throw blocked("provider_not_ready", "The provider is not ready.");
      const delegation = business.descriptor.delegation;
      if (!delegation)
        throw blocked("not_delegated", "This business does not offer account access.");
      const scopes = union(input.scopes);
      const credentials = await this.credentialsFor(
        identity,
        provider,
        binding,
        ctx.networkContext,
      );
      const started = await this.authorizations.start({
        business,
        scopes,
        principalId: principal.id,
        subjectBindingId: binding.id,
        taskId: ctx.taskId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        conversationId: null,
        operationId: null,
        purpose: input.purpose ?? `Connect ${business.displayName}`,
        transport: this.deps.transportFor(ctx.networkContext, ctx.taskId),
        credentials,
        rules: this.rules(),
      });
      this.startPoller(started.record, business, provider, binding, identity, ctx.networkContext);
      return toAuthorizationView(started.record, business);
    } catch (error) {
      if (error instanceof PactBlocked) throw new Error(error.outcome.message);
      if (error instanceof PactAuthorizationError) throw new Error(error.message);
      throw error;
    }
  }

  private async authorizationView(record: PactAuthorizationRecord): Promise<PactAuthorizationView> {
    const view = toAuthorizationView(record, await this.repo.getBusiness(record.businessId));
    if (record.state !== "pending") return view;
    try {
      const secret = this.authorizations.signIn(record);
      if (secret) {
        view.verificationOrigin = new URL(secret.verificationUriComplete).origin;
        view.verificationOriginMatchesBusiness = verificationOriginMatches(
          view.verificationOrigin,
          await this.repo.getBusiness(record.businessId),
        );
      }
    } catch {
      // Unreadable secret storage: the card still shows the business and scopes.
    }
    return view;
  }

  async getAuthorization(
    principal: PactPrincipal,
    authorizationId: string,
  ): Promise<PactAuthorizationView | null> {
    const record = await this.repo.getAuthorization(authorizationId);
    if (!record || record.principalId !== principal.id) return null;
    return this.authorizationView(record);
  }

  async getAuthorizationByInputRequest(principal: PactPrincipal, inputRequestId: string) {
    const record = await this.repo.getAuthorizationByInputRequest(inputRequestId);
    if (!record || record.principalId !== principal.id) return null;
    return this.authorizationView(record);
  }

  /** The sign-in link, for the owner's own surfaces only. */
  async getAuthorizationSignIn(
    principal: PactPrincipal,
    authorizationId: string,
  ): Promise<PactAuthorizationSignIn | null> {
    const record = await this.repo.getAuthorization(authorizationId);
    if (!record || record.principalId !== principal.id || record.state !== "pending") return null;
    if (record.expiresAt <= this.now()) return null;
    const secret = this.authorizations.signIn(record);
    if (!secret) return null;
    const verificationOrigin = new URL(secret.verificationUriComplete).origin;
    return {
      id: record.id,
      verificationUri: secret.verificationUri,
      verificationUriComplete: secret.verificationUriComplete,
      userCode: secret.userCode,
      verificationOrigin,
      verificationOriginMatchesBusiness: verificationOriginMatches(
        verificationOrigin,
        await this.repo.getBusiness(record.businessId),
      ),
      expiresAt: record.expiresAt,
    };
  }

  async listAuthorizations(
    principal: PactPrincipal,
    filter: { pendingOnly?: boolean; taskId?: string } = {},
  ) {
    const records = await this.repo.listAuthorizations({
      principalId: principal.id,
      ...(filter.pendingOnly ? { states: ["pending"] } : {}),
      ...(filter.taskId ? { taskId: filter.taskId } : {}),
    });
    const views: PactAuthorizationView[] = [];
    for (const record of records)
      views.push(toAuthorizationView(record, await this.repo.getBusiness(record.businessId)));
    return views;
  }

  /**
   * Resume polling a pending authorization in this process (CLI `authorization wait`), with the
   * same validation as startup: unexpired, same owner, task still waiting, provider ready.
   */
  async resumeAuthorization(
    principal: PactPrincipal,
    authorizationId: string,
  ): Promise<PactAuthorizationView | null> {
    const record = await this.repo.getAuthorization(authorizationId);
    if (!record || record.principalId !== principal.id) return null;
    if (record.state === "pending" && !this.pollers.has(record.id)) {
      const blocker = await this.resumeBlocker(record);
      if (blocker) {
        const settled = await this.authorizations.settle(
          record,
          blocker === "expired" ? { kind: "expired" } : { kind: "failed", reason: blocker },
        );
        if (settled?.inputRequestId) {
          await this.deps.host
            .settleAuthorizationWait(
              settled.inputRequestId,
              settled.state,
              `The sign-in could not continue (${blocker}).`,
            )
            .catch(() => undefined);
        }
        return this.getAuthorization(principal, authorizationId);
      }
      try {
        // The wait's own task and workspace rules; a removed task or workspace ends the wait.
        const networkContext = await this.deps.host.networkContextForWorkspace(
          record.workspaceId,
          record.taskId,
        );
        if (!networkContext) {
          throw blocked("workspace_unavailable", "The task or workspace for this sign-in is gone.");
        }
        const { identity, binding } = await this.resolveIdentity(principal, networkContext);
        const business = await this.repo.getBusiness(record.businessId);
        if (!business || binding.id !== record.subjectBindingId)
          return this.getAuthorization(principal, authorizationId);
        const provider = await this.providers.requireReady(
          new URL(business.interfaceUrl).origin,
          await this.providerContext(await this.currentSignerStatus(networkContext)),
        );
        this.startPoller(record, business, provider, binding, identity, networkContext);
      } catch (error) {
        await this.failResumedAuthorization(record, redactPactError(error));
        return this.getAuthorization(principal, authorizationId);
      }
    }
    return this.awaitAuthorization(principal, authorizationId);
  }

  /** Wait for an authorization this runtime is polling (CLI `--wait`). */
  async awaitAuthorization(
    principal: PactPrincipal,
    authorizationId: string,
  ): Promise<PactAuthorizationView | null> {
    const poller = this.pollers.get(authorizationId);
    if (poller) await poller.promise;
    return this.getAuthorization(principal, authorizationId);
  }

  async cancelAuthorization(
    principal: PactPrincipal,
    authorizationId: string,
  ): Promise<PactAuthorizationView | null> {
    const record = await this.repo.getAuthorization(authorizationId);
    if (!record || record.principalId !== principal.id) return null;
    const poller = this.pollers.get(authorizationId);
    if (poller) {
      poller.abort.abort();
      await poller.promise.catch(() => undefined);
    } else if (record.state === "pending") {
      const settled = await this.authorizations.settle(record, { kind: "cancelled" });
      if (settled?.inputRequestId) {
        await this.deps.host
          .settleAuthorizationWait(
            settled.inputRequestId,
            "cancelled",
            this.authorizationMessage("cancelled"),
          )
          .catch(() => undefined);
      }
    }
    return this.getAuthorization(principal, authorizationId);
  }

  /** The user dismissed the task card: cancel the matching wait. */
  async onAuthorizationInputDismissed(inputRequestId: string): Promise<void> {
    const record = await this.repo.getAuthorizationByInputRequest(inputRequestId);
    if (!record || record.state !== "pending") return;
    const poller = this.pollers.get(record.id);
    if (poller) {
      poller.abort.abort();
      return;
    }
    await this.authorizations.settle(record, { kind: "cancelled" });
  }

  // ---------------------------------------------------------- views and grants

  async getConversation(
    principal: PactPrincipal,
    conversationId: string,
  ): Promise<PactConversationView | null> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation || conversation.principalId !== principal.id) return null;
    const [business, messages] = await Promise.all([
      this.repo.getBusiness(conversation.businessId),
      this.repo.listMessages(conversation.id),
    ]);
    return toConversationView(conversation, business, messages);
  }

  async listConversations(
    principal: PactPrincipal,
    filter: { businessId?: string; taskId?: string; limit?: number } = {},
  ) {
    const conversations = await this.repo.listConversations({
      principalId: principal.id,
      ...filter,
    });
    const views: PactConversationView[] = [];
    for (const conversation of conversations) {
      views.push(
        toConversationView(
          conversation,
          await this.repo.getBusiness(conversation.businessId),
          await this.repo.listMessages(conversation.id),
        ),
      );
    }
    return views;
  }

  /** Clear an evidence issue after the user reviewed it; further changes are allowed again. */
  async acknowledgeEvidence(
    principal: PactPrincipal,
    conversationId: string,
  ): Promise<PactConversationView | null> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation || conversation.principalId !== principal.id) return null;
    if (conversation.state === "evidence_invalid") {
      await this.repo.updateConversation(conversationId, {
        state: "replied",
        stateReason: "evidence_reviewed",
      });
    }
    return this.getConversation(principal, conversationId);
  }

  async listBusinesses(): Promise<PactBusinessView[]> {
    const businesses = await this.repo.listBusinesses();
    const views: PactBusinessView[] = [];
    for (const business of businesses) {
      views.push(toBusinessView(business, await this.repo.getProvider(business.providerId)));
    }
    return views;
  }

  async listGrants(principal: PactPrincipal): Promise<PactGrantView[]> {
    const grants = await this.repo.listGrants({ principalId: principal.id });
    const views: PactGrantView[] = [];
    for (const grant of grants)
      views.push(toGrantView(grant, await this.repo.getBusiness(grant.businessId)));
    return views;
  }

  async disconnectGrant(principal: PactPrincipal, grantId: string): Promise<PactGrantView | null> {
    const grant = await this.grants.disconnect(grantId, principal.id);
    if (!grant) return null;
    return toGrantView(grant, await this.repo.getBusiness(grant.businessId));
  }

  async getReceipt(principal: PactPrincipal, receiptId: string): Promise<PactReceiptView | null> {
    const receipt = await this.repo.getReceipt(receiptId);
    if (!receipt) return null;
    const conversation = await this.repo.getConversation(receipt.conversationId);
    if (!conversation || conversation.principalId !== principal.id) return null;
    return toReceiptView(receipt);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Startup reconciliation: attempts interrupted mid-send become `outcome_unknown` (never
   * retried automatically), and pending consent waits resume only if still valid.
   */
  async reconcileOnStartup(): Promise<{ abandoned: number; resumed: number; expired: number }> {
    const abandoned = await this.repo.markAbandonedAttempts();
    for (const message of abandoned) {
      const conversation = await this.repo.getConversation(message.conversationId);
      if (conversation?.taskId) {
        this.emit({ taskId: conversation.taskId }, "pact_outcome_unknown", {
          conversationId: conversation.id,
          operationId: message.operationId,
          reason: "interrupted_during_send",
        });
      }
    }
    let resumed = 0;
    let expired = 0;
    const pending = await this.repo.listAuthorizations({ states: ["pending"] });
    for (const record of pending) {
      const reason = await this.resumeBlocker(record);
      if (reason) {
        expired += 1;
        const outcome: PactAuthorizationOutcome =
          reason === "expired" ? { kind: "expired" } : { kind: "failed", reason };
        const settled = await this.authorizations.settle(record, outcome as never);
        if (settled?.inputRequestId) {
          await this.deps.host
            .settleAuthorizationWait(
              settled.inputRequestId,
              settled.state,
              reason === "expired"
                ? this.authorizationMessage("expired")
                : `The business sign-in could not resume after a restart (${reason}).`,
            )
            .catch(() => undefined);
        }
        continue;
      }
      try {
        const principal = await this.ownerPrincipal();
        const networkContext = await this.deps.host.networkContextForWorkspace(
          record.workspaceId,
          record.taskId,
        );
        if (!networkContext) throw new Error("validation_changed");
        const { identity, binding } = await this.resolveIdentity(principal, networkContext);
        const business = (await this.repo.getBusiness(record.businessId))!;
        const provider = await this.providers.requireReady(
          new URL(business.interfaceUrl).origin,
          await this.providerContext(await this.currentSignerStatus(networkContext)),
        );
        if (binding.id !== record.subjectBindingId || provider.readiness !== "ready") {
          throw new Error("validation_changed");
        }
        this.startPoller(record, business, provider, binding, identity, networkContext);
        resumed += 1;
      } catch (error) {
        expired += 1;
        await this.failResumedAuthorization(record, redactPactError(error));
      }
    }
    return { abandoned: abandoned.length, resumed, expired };
  }

  /** A wait that cannot resume fails, and its task card stops waiting with the reason. */
  private async failResumedAuthorization(
    record: PactAuthorizationRecord,
    reason: string,
  ): Promise<void> {
    const settled = await this.authorizations.settle(record, { kind: "failed", reason });
    if (settled?.inputRequestId) {
      await this.deps.host
        .settleAuthorizationWait(
          settled.inputRequestId,
          settled.state,
          `The business sign-in could not resume (${reason}).`,
        )
        .catch(() => undefined);
    }
  }

  private async resumeBlocker(record: PactAuthorizationRecord): Promise<string | null> {
    if (record.expiresAt <= this.now()) return "expired";
    if (!this.availability().available) return "pact_unavailable";
    if (record.principalId !== (await this.ownerPrincipal()).id) return "owner_changed";
    if (record.taskId && !(await this.deps.host.taskStillWaiting(record.taskId)))
      return "task_not_waiting";
    const business = await this.repo.getBusiness(record.businessId);
    if (!business || business.supportStatus !== "supported") return "business_changed";
    return null;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const poller of this.pollers.values()) poller.abort.abort();
    await Promise.allSettled([...this.pollers.values()].map((poller) => poller.promise));
    await this.identityState?.development?.stop();
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
