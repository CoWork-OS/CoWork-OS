/**
 * PACT (personal-agent identity and delegated authority on A2A 1.0) types shared by the runtime,
 * IPC, Control Plane, browser host, CLI and renderer. None of these carry secrets: tokens, device
 * codes, user codes and signer credentials stay in the main process's encrypted store.
 */

export type BusinessAgentProtocolPreference = "prefer-pact" | "require-pact" | "disabled";

/**
 * The preference new and upgraded profiles adopt once PACT is qualified for release. `null`
 * keeps unset profiles on "disabled" until the live pilot passes (plan §12, decision 5).
 */
export const PACT_QUALIFIED_DEFAULT_PREFERENCE: BusinessAgentProtocolPreference | null = null;

export type PactIdentityDeployment = "managed" | "self_hosted" | "development" | "none";
export type PactSignerAuthMode = "credential" | "device_key";

export interface PactIdentitySettings {
  deployment: PactIdentityDeployment;
  /** HTTPS origin used as `iss`; it must serve `/.well-known/jwks.json`. */
  issuer?: string;
  /** Base URL of the signer contract. */
  signerUrl?: string;
  authMode?: PactSignerAuthMode;
}

/** A provider CoWork has verified out of band: its origin and the audience it assigned. */
export interface PactProviderConfig {
  origin: string;
  audience: string;
  label?: string;
}

export interface PactSettings {
  version: 1;
  /** User toggle for the outbound adapter; admin policy and env can still disable it. */
  enabled: boolean;
  preference?: BusinessAgentProtocolPreference;
  /** Set once the qualified default has been considered for this profile. */
  defaultPreferenceApplied?: boolean;
  identity: PactIdentitySettings;
  providers: PactProviderConfig[];
}

export const DEFAULT_PACT_SETTINGS: PactSettings = {
  version: 1,
  enabled: false,
  identity: { deployment: "none" },
  providers: [],
};

export type PactProfile = "identity" | "delegated";

export type PactConversationState =
  | "discovered"
  | "ready"
  | "awaiting_local_authority"
  | "awaiting_business_consent"
  | "sending"
  | "replied"
  | "evidence_verified"
  | "denied"
  | "expired"
  | "cancelled"
  | "unsupported"
  | "outcome_unknown"
  | "evidence_invalid"
  | "closed";

export type PactEffectClass = "inspect" | "change" | "unknown";

export type PactEvidenceStatus =
  | "not_applicable"
  | "verified"
  | "missing"
  | "invalid"
  | "unverifiable"
  | "needs_review";

export interface PactScopeView {
  id: string;
  description: string;
}

export interface PactBusinessView {
  id: string;
  displayName: string;
  cardUrl: string;
  /** Every URL fetched to reach the card, starting with the request URL. */
  originChain: string[];
  providerOrigin: string;
  interfaceUrl: string;
  profile: PactProfile;
  supported: boolean;
  unsupportedReason?: string;
  scopes: PactScopeView[];
  skills: { id: string; name: string; description: string }[];
  fetchedAt: number;
  expiresAt: number;
  providerReady: boolean;
  providerReadinessReason?: string;
}

export interface PactTurnView {
  id: string;
  operationId: string;
  direction: "outbound";
  text: string;
  state: string;
  effectClass: PactEffectClass;
  replyText?: string;
  evidence: PactEvidenceStatus;
  receiptId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PactConversationView {
  id: string;
  businessId: string;
  businessName: string;
  state: PactConversationState;
  stateReason?: string;
  taskId?: string;
  createdAt: number;
  updatedAt: number;
  turns: PactTurnView[];
}

export type PactGrantState = "active" | "expired" | "invalid" | "disconnected";

export interface PactGrantView {
  id: string;
  businessId: string;
  businessName: string;
  scopes: PactScopeView[];
  state: PactGrantState;
  createdAt: number;
  lastUsedAt?: number;
  accessExpiresAt?: number;
  grantExpiresAt?: number;
}

export type PactAuthorizationState =
  | "pending"
  | "granted"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed";

export interface PactAuthorizationView {
  id: string;
  inputRequestId?: string;
  taskId?: string;
  businessId: string;
  businessName: string;
  purpose: string;
  requestedScopes: PactScopeView[];
  grantedScopes?: PactScopeView[];
  state: PactAuthorizationState;
  stateReason?: string;
  /** Origin of the business's sign-in page while pending (not the link itself). */
  verificationOrigin?: string;
  expiresAt: number;
  createdAt: number;
}

/**
 * The sign-in link for a pending authorization. Only returned to the owning user's surfaces
 * (desktop, authenticated web or CLI), never to the model and never logged.
 */
export interface PactAuthorizationSignIn {
  id: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  /** The origin the link opens, shown so the user can recognise the business's own login. */
  verificationOrigin: string;
  expiresAt: number;
}

export interface PactReceiptView {
  id: string;
  conversationId: string;
  turnId: string;
  verification: PactEvidenceStatus;
  verificationReason?: string;
  scopesUsed: string[];
  actions: { tool: string; argsHash?: string }[];
  brand?: string;
  receiptTimestamp?: string;
  createdAt: number;
}

export type PactUnavailableReason =
  | "disabled_by_admin"
  | "disabled_by_env"
  | "disabled_in_settings"
  | "identity_not_configured"
  | "identity_unavailable";

export interface PactStatusView {
  available: boolean;
  unavailableReason?: PactUnavailableReason;
  preference: BusinessAgentProtocolPreference;
  autoRoute: boolean;
  identity: {
    deployment: PactIdentityDeployment;
    issuer?: string;
    ready: boolean;
    reason?: string;
  };
  providers: { origin: string; audience?: string; ready: boolean; reason?: string }[];
  pendingAuthorizations: number;
  activeGrants: number;
}

export type PactSendOutcome =
  | {
      status: "replied";
      conversationId: string;
      turnId: string;
      replyText: string;
      evidence: PactEvidenceStatus;
      receiptId?: string;
      grantedScopes?: string[];
    }
  | {
      status: "needs_user_action";
      conversationId: string;
      authorizationId: string;
      inputRequestId?: string;
      scopes: PactScopeView[];
      message: string;
    }
  | {
      status: "denied" | "expired" | "cancelled" | "blocked" | "unsupported" | "outcome_unknown";
      conversationId?: string;
      reason: string;
      message: string;
    };

/** Question id that marks an input request as a PACT authorization wait. */
export const PACT_AUTHORIZATION_QUESTION_ID = "pact_authorization";
export const PACT_AUTHORIZATION_CANCEL_OPTION = "Cancel sign-in";

/** Whether an input request is a PACT authorization wait (resolved by the runtime, not the user). */
export function isPactAuthorizationInputRequest(
  request: { questions?: { id: string }[] } | null | undefined,
): boolean {
  return Boolean(
    request?.questions?.some((question) => question.id === PACT_AUTHORIZATION_QUESTION_ID),
  );
}
