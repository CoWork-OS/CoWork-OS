/**
 * The one adapter every user surface (desktop IPC, Control Plane, browser host, CLI) uses to reach
 * the PACT runtime. Each call carries an explicit principal from the calling surface; nothing
 * falls back to a default client principal. Results never contain secrets: the sign-in link is
 * returned only from `authorizationSignIn`, which surfaces gate to the owner.
 */
import type Database from "better-sqlite3";
import type {
  PactAuthorizationSignIn,
  PactAuthorizationView,
  PactSettings,
  PactStatusView,
} from "../../shared/pact";
import type { Workspace } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import { resolveEffectiveAccessProfile } from "../security/access-profile-resolver";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import type { NetworkPolicyContext } from "../security/policy-checked-fetch";
import { effectiveWorkspace, networkContextOf } from "./daemon-host";
import { redactPactError } from "./redaction";
import type { PactCallContext, PactRuntime } from "./runtime";
import { PactSettingsManager } from "./settings";
import type { PactPrincipal } from "./types";
import type {
  PactAuthorizationStartInput,
  PactDiscoverInput,
  PactSendInput,
  PactSettingsUpdateInput,
} from "./pact-validation";

export class PactSurfaceError extends Error {
  constructor(
    readonly code: "not_found" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "PactSurfaceError";
  }
}

export interface PactSurfaceDeps {
  runtime: () => PactRuntime;
  db: Database.Database;
  findWorkspace: (workspaceId: string) => Promise<Workspace | undefined> | Workspace | undefined;
}

export class PactSurfaceService {
  constructor(private readonly deps: PactSurfaceDeps) {}

  /** Network rules for a call outside a task: the workspace's profile, else the default one. */
  private async networkContext(workspaceId?: string): Promise<NetworkPolicyContext> {
    if (workspaceId) {
      const workspace = await this.deps.findWorkspace(workspaceId);
      if (!workspace) throw new PactSurfaceError("not_found", "Unknown workspace");
      return networkContextOf(effectiveWorkspace(workspace)) ?? { networkEnabled: false };
    }
    const profile = resolveEffectiveAccessProfile({
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    return {
      networkEnabled: profile.networkEnabled,
      accessNetworkMode: profile.definition.network,
      profileDomainRules: profile.definition.domainRules,
    };
  }

  private async context(
    workspaceId: string | undefined,
    overrides: Partial<PactCallContext> = {},
  ): Promise<PactCallContext> {
    return {
      ...(workspaceId ? { workspaceId } : {}),
      origin: "owner",
      localAuthority: "explicit_user_request",
      humanInput: "out_of_band",
      waitForConsent: false,
      networkContext: await this.networkContext(workspaceId),
      ...overrides,
    };
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PactSurfaceError) throw error;
      throw new PactSurfaceError("failed", redactPactError(error));
    }
  }

  status(principal: PactPrincipal): Promise<PactStatusView> {
    return this.guard(() => this.deps.runtime().status(principal));
  }

  discover(principal: PactPrincipal, input: PactDiscoverInput) {
    return this.guard(async () =>
      this.deps.runtime().discover(
        principal,
        {
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.cardUrl ? { cardUrl: input.cardUrl } : {}),
          ...(input.refresh ? { refresh: true } : {}),
        },
        await this.context(input.workspaceId),
      ),
    );
  }

  listBusinesses() {
    return this.guard(() => this.deps.runtime().listBusinesses());
  }

  getConversation(principal: PactPrincipal, id: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().getConversation(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown conversation");
      return view;
    });
  }

  listConversations(principal: PactPrincipal, filter: { businessId?: string; taskId?: string; limit?: number }) {
    return this.guard(() => this.deps.runtime().listConversations(principal, filter));
  }

  /** A send typed by the owner on their own surface; `confirmed` covers the local approval. */
  send(principal: PactPrincipal, input: PactSendInput) {
    return this.guard(async () =>
      this.deps.runtime().send(
        principal,
        {
          businessId: input.businessId,
          text: input.text,
          effect: input.effect,
          requiredScopes: input.requiredScopes,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.reconcileOperationId ? { reconcileOperationId: input.reconcileOperationId } : {}),
        },
        await this.context(input.workspaceId, { preApproved: input.confirmed }),
      ),
    );
  }

  startAuthorization(principal: PactPrincipal, input: PactAuthorizationStartInput) {
    return this.guard(async () =>
      this.deps.runtime().startAuthorization(
        principal,
        {
          businessId: input.businessId,
          scopes: input.scopes,
          ...(input.purpose ? { purpose: input.purpose } : {}),
        },
        await this.context(input.workspaceId),
      ),
    );
  }

  getAuthorization(principal: PactPrincipal, id: string): Promise<PactAuthorizationView> {
    return this.guard(async () => {
      const view = await this.deps.runtime().getAuthorization(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown authorization");
      return view;
    });
  }

  getAuthorizationByInputRequest(principal: PactPrincipal, inputRequestId: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().getAuthorizationByInputRequest(principal, inputRequestId);
      if (!view) throw new PactSurfaceError("not_found", "Unknown authorization");
      return view;
    });
  }

  /** The verified sign-in link; callers must already have checked the caller is the owner. */
  authorizationSignIn(principal: PactPrincipal, id: string): Promise<PactAuthorizationSignIn | null> {
    return this.guard(() => this.deps.runtime().getAuthorizationSignIn(principal, id));
  }

  listAuthorizations(principal: PactPrincipal, filter: { pendingOnly?: boolean; taskId?: string }) {
    return this.guard(() => this.deps.runtime().listAuthorizations(principal, filter));
  }

  awaitAuthorization(principal: PactPrincipal, id: string) {
    return this.guard(() => this.deps.runtime().awaitAuthorization(principal, id));
  }

  cancelAuthorization(principal: PactPrincipal, id: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().cancelAuthorization(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown authorization");
      return view;
    });
  }

  listGrants(principal: PactPrincipal) {
    return this.guard(() => this.deps.runtime().listGrants(principal));
  }

  disconnectGrant(principal: PactPrincipal, id: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().disconnectGrant(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown permission");
      // PACT 1.0 has no revocation endpoint: this is a local disconnect only.
      return { grant: view, revokedAtBusiness: false as const };
    });
  }

  getReceipt(principal: PactPrincipal, id: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().getReceipt(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown receipt");
      return view;
    });
  }

  acknowledgeEvidence(principal: PactPrincipal, id: string) {
    return this.guard(async () => {
      const view = await this.deps.runtime().acknowledgeEvidence(principal, id);
      if (!view) throw new PactSurfaceError("not_found", "Unknown conversation");
      return view;
    });
  }

  getSettings(): PactSettings {
    return PactSettingsManager.loadSettings();
  }

  /**
   * Turning the adapter on with no preference set is an explicit opt-in to prefer PACT; the
   * qualified release default is applied separately by the settings envelope.
   */
  updateSettings(update: PactSettingsUpdateInput): PactSettings {
    const current = PactSettingsManager.loadSettings();
    const next: Partial<PactSettings> = { ...update } as Partial<PactSettings>;
    if (update.enabled === true && !current.preference && !update.preference) {
      next.preference = "prefer-pact";
    }
    return PactSettingsManager.saveSettings(next);
  }

  setSignerCredential(credential: string | null): { configured: boolean } {
    this.deps.runtime().setSignerCredential(credential);
    return { configured: Boolean(credential) };
  }

  /** Generate the install's device key for account-free enrollment; returns only the public key. */
  ensureDeviceKey(): { publicJwk: Record<string, unknown> } {
    return { publicJwk: { ...this.deps.runtime().ensureDeviceKey() } };
  }
}
