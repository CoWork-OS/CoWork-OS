/**
 * Runtime records for PACT persistence. Rows hold descriptors, state and secret references only.
 */
import type {
  PactAuthorizationState,
  PactConversationState,
  PactEffectClass,
  PactEvidenceStatus,
  PactGrantState,
  PactIdentityDeployment,
  PactProfile,
  PactScopeView,
} from "../../shared/pact";

export type PactProviderReadiness = "ready" | "not_ready" | "blocked";
export type PactRegistrationStatus = "unknown" | "registered" | "manual" | "unregistered";

export interface PactProviderRecord {
  id: string;
  origin: string;
  audience: string | null;
  issuer: string | null;
  metadataUrl: string | null;
  registrationStatus: PactRegistrationStatus;
  readiness: PactProviderReadiness;
  readinessReason: string | null;
  configRevision: number;
  createdAt: number;
  updatedAt: number;
}

/** What CoWork keeps about a business: public card facts, never credentials. */
export interface PactBusinessDescriptor {
  description: string;
  providerOrganization?: string;
  identitySchemeName: string;
  skills: { id: string; name: string; description: string }[];
  delegation?: {
    deviceAuthorizationUrl: string;
    tokenUrl: string;
    refreshUrl: string;
    metadataUrl: string;
    scopes: PactScopeView[];
    /** From verified RFC 8414 metadata, when fetched. */
    authorizationServer?: string;
    jwksUri?: string;
  };
}

export interface PactBusinessRecord {
  id: string;
  cardUrl: string;
  displayName: string;
  originChain: string[];
  providerId: string;
  interfaceUrl: string;
  profile: PactProfile;
  supportStatus: "supported" | "unsupported";
  unsupportedReason: string | null;
  cardFingerprint: string;
  securityFingerprint: string;
  descriptor: PactBusinessDescriptor;
  revision: number;
  fetchedAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PactSubjectBindingRecord {
  id: string;
  principalId: string;
  deployment: Exclude<PactIdentityDeployment, "none">;
  issuer: string;
  subject: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface PactGrantRecord {
  id: string;
  principalId: string;
  subjectBindingId: string;
  businessId: string;
  interfaceUrl: string;
  authorizationServer: string;
  /** The business-side account the grant acts as (delegation token `sub`). */
  accountBinding: string | null;
  remoteGrantId: string | null;
  scopes: string[];
  state: PactGrantState;
  stateReason: string | null;
  secretRef: string;
  accessExpiresAt: number | null;
  grantExpiresAt: number | null;
  secretRevision: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface PactConversationRecord {
  id: string;
  principalId: string;
  subjectBindingId: string;
  businessId: string;
  accountBinding: string | null;
  contextId: string | null;
  taskId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  state: PactConversationState;
  stateReason: string | null;
  contextAttempts: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * One wire attempt of a logical operation. `prepared` rows are persisted before any network
 * effect; `sending` rows carry a lease; a crash while `sending` becomes `outcome_unknown`.
 */
export type PactMessageState =
  | "prepared"
  | "sending"
  | "replied"
  | "auth_required"
  | "outcome_unknown"
  | "failed"
  | "cancelled"
  | "superseded";

export type PactMessageKind = "introduction" | "operation";

export interface PactMessageRecord {
  id: string;
  conversationId: string;
  operationId: string;
  seq: number;
  wireMessageId: string;
  kind: PactMessageKind;
  bodyText: string;
  bodyDigest: string;
  effectClass: PactEffectClass;
  requiredScopes: string[];
  authorityFingerprint: string;
  cardRevision: number;
  providerRevision: number;
  grantId: string | null;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  state: PactMessageState;
  stateReason: string | null;
  replyText: string | null;
  replyMessageId: string | null;
  evidence: PactEvidenceStatus;
  receiptId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PactAuthorizationRecord {
  id: string;
  inputRequestId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  principalId: string;
  subjectBindingId: string;
  businessId: string;
  conversationId: string | null;
  operationId: string | null;
  purpose: string;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  state: PactAuthorizationState;
  stateReason: string | null;
  expiresAt: number;
  intervalSeconds: number;
  secretRef: string;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  grantId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PactReceiptRecord {
  id: string;
  messageId: string;
  conversationId: string;
  contextId: string | null;
  jwsDigest: string;
  secretRef: string;
  verificationState: PactEvidenceStatus;
  verificationReason: string | null;
  grantIdClaim: string | null;
  paClaim: string | null;
  brandClaim: string | null;
  scopesUsed: string[];
  actions: { tool: string; argsHash?: string }[];
  receiptTs: string | null;
  createdAt: number;
}

/** Who is acting. Always supplied by the calling surface, never inferred from a fallback. */
export interface PactPrincipal {
  id: string;
  kind: "local_owner" | "control_plane_client" | "session_role";
  /** Audit label, e.g. the Control Plane client id. Not an authority. */
  actor?: string;
}
