/**
 * Local admission (plan §7): three independent decisions kept separate.
 *
 * 1. The current principal may operate this task and disclose the selected facts.
 * 2. A business grant for this principal and account covers the requested scopes (grant-service).
 * 3. The proposed operation matches the user's instruction and CoWork policy.
 *
 * Sending text to a business agent can cause effects whatever the HTTP method or profile, and
 * scope descriptions are not read-only declarations. The model may propose scopes, an effect class
 * and a message; the runtime takes the strongest class implied by any of them, and anything other
 * than a plain inspection needs local approval (or an explicit request from the owner's own
 * surface). A stored `orders:cancel` grant cannot turn an inspect request into a cancellation.
 */
import { createHash } from "node:crypto";
import type { PactEffectClass } from "../../shared/pact";
import { redactPactString } from "./redaction";
import type { PactBusinessRecord, PactPrincipal } from "./types";

export const MAX_OUTBOUND_TEXT_CHARS = 4000;

// Mutating verbs only: nouns such as "order", "payment" or "return policy" must not turn an
// inspection into a change, while a false "change" only costs a confirmation.
const CHANGE_WORDS =
  /\b(cancel|cancell?ation|refund|rebook|re-book|reschedul\w*|change|modify|update|edit|delete|remove|book|reserve|purchase|buy|pay|transfer|submit|approve|confirm|upgrade|downgrade|subscribe|unsubscribe|renew|redeem|write|writes)\b/i;
const INSPECT_WORDS =
  /\b(read|view|list|look\s?up|lookup|status|history|check|see|show|get|find|search|track|inspect|upcoming|past|balance|receipts?)\b/i;
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\b(password|passcode|passwd|pwd)\s*[:=]\s*\S+/i,
  /\b(?:\d[ -]?){13,19}\b/,
];

const EFFECT_RANK: Record<PactEffectClass, number> = { inspect: 0, change: 1, unknown: 2 };

function strongest(...classes: PactEffectClass[]): PactEffectClass {
  return classes.reduce((left, right) => (EFFECT_RANK[right] > EFFECT_RANK[left] ? right : left));
}

/** Classify a scope from its id and the business's description of it. */
export function classifyScope(scope: { id: string; description: string }): PactEffectClass {
  const text = `${scope.id.replace(/[:._-]+/g, " ")} ${scope.description}`;
  if (CHANGE_WORDS.test(text)) return "change";
  if (/\b(read|view|list|look|history|status|upcoming|past)\b/i.test(text)) return "inspect";
  return "unknown";
}

/** A message that asks for a change is a change, whatever the model declared. */
export function classifyText(text: string): PactEffectClass {
  if (CHANGE_WORDS.test(text)) return "change";
  if (INSPECT_WORDS.test(text) || /\?\s*$/.test(text.trim())) return "inspect";
  return "unknown";
}

/** Sensitive local facts that must never be disclosed to a business agent. */
export function findSensitiveContent(text: string): string | null {
  if (redactPactString(text) !== text) return "credential";
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return "secret_or_card_number";
  }
  return null;
}

export type PactTaskOrigin = "owner" | "owner_cli" | "sub_agent" | "bot" | "gateway" | "automation";

export type PactLocalAuthority =
  /** The owner typed this request on a CoWork surface (Settings, CLI `cowork pact send`). */
  | "explicit_user_request"
  /** The model proposed it inside a task. */
  | "task";

export interface PactAdmissionInput {
  principal: PactPrincipal;
  origin: PactTaskOrigin;
  localAuthority: PactLocalAuthority;
  business: PactBusinessRecord;
  text: string;
  declaredEffect: PactEffectClass;
  requiredScopes: string[];
  /** Scopes the delegation token that would be sent carries. */
  tokenScopes: string[];
}

export type PactAdmission =
  | {
      decision: "admit";
      effectClass: PactEffectClass;
      /** Local approval needed before sending. */
      approvalRequired: boolean;
      approvalReasons: string[];
    }
  | { decision: "deny"; reason: string; message: string };

export function admitPactOperation(input: PactAdmissionInput): PactAdmission {
  if (input.origin !== "owner" && input.origin !== "owner_cli") {
    // Shared-session contributors, bots, gateway users and sub-agents cannot act with the owner's
    // identity or grants without an explicit, logged delegation, which PACT 1.0 does not model.
    return {
      decision: "deny",
      reason: "delegation_required",
      message: "Only the profile owner's own tasks can talk to businesses through PACT.",
    };
  }
  const text = input.text.trim();
  if (!text) {
    return {
      decision: "deny",
      reason: "blank_message",
      message: "The message to the business is empty.",
    };
  }
  if (text.length > MAX_OUTBOUND_TEXT_CHARS) {
    return {
      decision: "deny",
      reason: "message_too_long",
      message: `Messages to a business are limited to ${MAX_OUTBOUND_TEXT_CHARS} characters.`,
    };
  }
  const sensitive = findSensitiveContent(text);
  if (sensitive) {
    return {
      decision: "deny",
      reason: "sensitive_content",
      message:
        "The message contains a credential, secret or card number. Business agents never need these; the user signs in on the business's own page.",
    };
  }
  if (input.business.supportStatus !== "supported") {
    return {
      decision: "deny",
      reason: "unsupported",
      message: "This business is not a supported PACT agent.",
    };
  }
  const advertised = new Map(
    (input.business.descriptor.delegation?.scopes ?? []).map((scope) => [scope.id, scope]),
  );
  const unknownScopes = input.requiredScopes.filter((scope) => !advertised.has(scope));
  if (unknownScopes.length > 0) {
    return {
      decision: "deny",
      reason: "unknown_scope",
      message: `Scopes not offered by this business: ${unknownScopes.join(", ")}`,
    };
  }

  const scopeClasses = input.requiredScopes.map((scope) => classifyScope(advertised.get(scope)!));
  const tokenClasses = input.tokenScopes.map((scope) =>
    advertised.has(scope) ? classifyScope(advertised.get(scope)!) : "unknown",
  );
  const effectClass = strongest(input.declaredEffect, classifyText(text), ...scopeClasses);
  const tokenClass = tokenClasses.length > 0 ? strongest(...tokenClasses) : "inspect";

  const approvalReasons: string[] = [];
  if (effectClass !== "inspect") approvalReasons.push(`effect_${effectClass}`);
  // Sending a token that could do more than this operation needs is itself a decision.
  if (EFFECT_RANK[tokenClass] > EFFECT_RANK[effectClass]) {
    approvalReasons.push("token_exceeds_operation");
  }
  const approvalRequired =
    approvalReasons.length > 0 &&
    // The owner's own explicit request satisfies the local gate for changes; unknown effects and
    // over-broad tokens still need review.
    !(
      input.localAuthority === "explicit_user_request" &&
      effectClass === "change" &&
      !approvalReasons.includes("token_exceeds_operation")
    );
  return { decision: "admit", effectClass, approvalRequired, approvalReasons };
}

/** What an admitted operation was admitted under; a retry under different facts is refused. */
export function authorityFingerprint(input: {
  principalId: string;
  subjectBindingId: string;
  subjectRevision: number;
  businessId: string;
  businessRevision: number;
  providerRevision: number;
  effectClass: PactEffectClass;
  requiredScopes: string[];
  grantId: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        requiredScopes: [...input.requiredScopes].sort(),
      }),
    )
    .digest("hex");
}
