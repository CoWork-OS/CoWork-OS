/** Mapping from runtime records to the secret-free views shared with every surface. */
import type {
  PactAuthorizationView,
  PactBusinessView,
  PactConversationView,
  PactGrantView,
  PactReceiptView,
  PactScopeView,
  PactTurnView,
} from "../../shared/pact";
import type {
  PactAuthorizationRecord,
  PactBusinessRecord,
  PactConversationRecord,
  PactGrantRecord,
  PactMessageRecord,
  PactProviderRecord,
  PactReceiptRecord,
} from "./types";

export function scopeViews(
  business: PactBusinessRecord | null,
  ids: readonly string[],
): PactScopeView[] {
  const known = new Map(
    (business?.descriptor.delegation?.scopes ?? []).map((scope) => [scope.id, scope]),
  );
  return ids.map((id) => ({ id, description: known.get(id)?.description ?? id }));
}

export function toBusinessView(
  business: PactBusinessRecord,
  provider: PactProviderRecord | null,
): PactBusinessView {
  return {
    id: business.id,
    displayName: business.displayName,
    cardUrl: business.cardUrl,
    originChain: business.originChain,
    providerOrigin: provider?.origin ?? new URL(business.interfaceUrl).origin,
    interfaceUrl: business.interfaceUrl,
    profile: business.profile,
    supported: business.supportStatus === "supported",
    ...(business.unsupportedReason ? { unsupportedReason: business.unsupportedReason } : {}),
    scopes: business.descriptor.delegation?.scopes ?? [],
    skills: business.descriptor.skills,
    fetchedAt: business.fetchedAt,
    expiresAt: business.expiresAt,
    providerReady: provider?.readiness === "ready",
    ...(provider?.readinessReason ? { providerReadinessReason: provider.readinessReason } : {}),
  };
}

export function toTurnView(message: PactMessageRecord): PactTurnView {
  return {
    id: message.id,
    operationId: message.operationId,
    direction: "outbound",
    text: message.bodyText,
    state: message.state,
    effectClass: message.effectClass,
    ...(message.replyText ? { replyText: message.replyText } : {}),
    evidence: message.evidence,
    ...(message.receiptId ? { receiptId: message.receiptId } : {}),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

export function toConversationView(
  conversation: PactConversationRecord,
  business: PactBusinessRecord | null,
  messages: PactMessageRecord[],
): PactConversationView {
  return {
    id: conversation.id,
    businessId: conversation.businessId,
    businessName: business?.displayName ?? "Unknown business",
    state: conversation.state,
    ...(conversation.stateReason ? { stateReason: conversation.stateReason } : {}),
    ...(conversation.taskId ? { taskId: conversation.taskId } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turns: messages.filter((message) => message.kind === "operation").map(toTurnView),
  };
}

export function toGrantView(
  grant: PactGrantRecord,
  business: PactBusinessRecord | null,
): PactGrantView {
  return {
    id: grant.id,
    businessId: grant.businessId,
    businessName: business?.displayName ?? "Unknown business",
    scopes: scopeViews(business, grant.scopes),
    state: grant.state,
    createdAt: grant.createdAt,
    ...(grant.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
    ...(grant.accessExpiresAt ? { accessExpiresAt: grant.accessExpiresAt } : {}),
    ...(grant.grantExpiresAt ? { grantExpiresAt: grant.grantExpiresAt } : {}),
  };
}

export function toAuthorizationView(
  record: PactAuthorizationRecord,
  business: PactBusinessRecord | null,
): PactAuthorizationView {
  return {
    id: record.id,
    ...(record.inputRequestId ? { inputRequestId: record.inputRequestId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    businessId: record.businessId,
    businessName: business?.displayName ?? "Unknown business",
    purpose: record.purpose,
    requestedScopes: scopeViews(business, record.requestedScopes),
    ...(record.grantedScopes ? { grantedScopes: scopeViews(business, record.grantedScopes) } : {}),
    state: record.state,
    ...(record.stateReason ? { stateReason: record.stateReason } : {}),
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

export function toReceiptView(receipt: PactReceiptRecord): PactReceiptView {
  return {
    id: receipt.id,
    conversationId: receipt.conversationId,
    turnId: receipt.messageId,
    verification: receipt.verificationState,
    ...(receipt.verificationReason ? { verificationReason: receipt.verificationReason } : {}),
    scopesUsed: receipt.scopesUsed,
    actions: receipt.actions,
    ...(receipt.brandClaim ? { brand: receipt.brandClaim } : {}),
    ...(receipt.receiptTs ? { receiptTimestamp: receipt.receiptTs } : {}),
    createdAt: receipt.createdAt,
  };
}
